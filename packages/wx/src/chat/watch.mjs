// The live feed of the user's chats: the websocket of the stream service (wss://<region>-ws.stream.wildix.com),
// as the agent skill's watch.mjs. Read only: it sends nothing to any chat and marks nothing read. One event per
// ctx.emit(); READY when subscribed, RECONNECTING / RECONNECTED while the connection is renewed (the service closes
// one after two hours; the token, checked only when a connection opens, is renewed with ctx.freshToken()), END at
// the end (ctx.signal, --count or --for).
import {jwtClaims} from 'wldx-core/auth';
import {AuthError} from 'wldx-core/errors';
import {localTime, oneLine, paint} from 'wldx-core/format';
import {streamWsUrl} from 'wldx-core/services';
import {streamClient} from '../stream.mjs';
import {displayName, meId} from './lib.mjs';

export const EVENT_GROUPS = {
  messages: ['message.new', 'message.updated', 'message.deleted'],
  reactions: ['reaction.new', 'reaction.updated', 'reaction.deleted'],
  reads: ['read.cursor.updated', 'read.receipt.updated'],
  members: ['member.added', 'member.updated', 'member.removed'],
  channels: [
    'channel.created',
    'channel.updated',
    'channel.truncated',
    'channel.added',
    'channel.removed',
    'channel.hidden',
    'channel.visible',
    'channel.muted',
    'channel.unmuted',
    'channel.pinned',
    'channel.unpinned',
  ],
  typing: ['typing.start', 'typing.stop'],
};
export const EVENT_CHOICES = [...Object.keys(EVENT_GROUPS), ...Object.values(EVENT_GROUPS).flat()];

const KEEPALIVE_MS = 4 * 60 * 1000; // the gateway drops a connection that is quiet for 10 minutes
const BACKOFF = [1, 2, 5, 10]; // seconds, then 30
const drop = (o) => JSON.parse(JSON.stringify(o)); // removes the undefined fields
const unreadOf = (counters) =>
  counters ? Object.values(counters).reduce((n, c) => n + (c?.unmutedUnreadMessageCount ?? 0), 0) : undefined;

// Whether an event passes the filters. A reaction event does not say who reacted (its message is someone else's
// work), so a reaction has no author: it is never taken for the user's own action, and --from leaves it out.
export function wanted(e, {channels, senders, types, mine, me}) {
  if (types.size && !types.has(e.eventType)) return false;
  if (channels.size && !channels.has(e.channelId)) return false;
  const isReaction = e.eventType.startsWith('reaction.');
  const author = isReaction ? undefined : (e.message?.userId ?? e.readerUserId ?? e.typingUserId);
  if (isReaction && senders.size) return false;
  if (senders.size && !senders.has(author)) return false;
  if (!mine) {
    if (e.eventType === 'read.cursor.updated') return false; // always the user's own reading
    if (author === me) return false;
  }
  return true;
}

// The short form of an event (the fields of the skill's watch.mjs).
export async function view(e, nameOf) {
  const person = async (id) => (id ? {id, name: await nameOf(id)} : undefined);
  const m = e.message;
  const isReaction = e.eventType.startsWith('reaction.');
  return drop({
    event: e.eventType,
    channelId: e.channelId,
    channel: e.inboxChannel?.subject,
    channelType: e.inboxChannel?.channelType,
    messageId: e.messageId,
    seq: e.timelineSeq,
    from: isReaction ? undefined : await person(m?.userId),
    messageAuthor: isReaction ? await person(m?.userId) : undefined,
    text: m?.text,
    attachments: m?.attachments?.length ? m.attachments.map((f) => drop({name: f.name, mime: f.mime})) : undefined,
    mentions: m?.mentions?.length ? m.mentions : undefined,
    system: m?.system || undefined,
    reactions: isReaction ? m?.reactionCounts : undefined,
    reader: await person(e.readerUserId),
    readUpTo: e.lastReadVisibleSeq,
    member: e.member ? {...e.member, name: await nameOf(e.member.userId)} : undefined,
    typing: await person(e.typingUserId),
    unread: unreadOf(e.sectionCounters),
  });
}

const tokenExp = (token) => (Number.isFinite(jwtClaims(token).exp) ? jwtClaims(token).exp * 1000 : 0);

// Runs until ctx.signal, `count` events (0: no limit) or `seconds` (0: no limit). Resolves when it stops.
export async function watch(
  ctx,
  {
    channels = new Set(),
    senders = new Set(),
    types = new Set(),
    mine = false,
    raw = false,
    count = 0,
    seconds = 0,
  } = {},
) {
  let token = ctx.token;
  let client = streamClient({token, env: ctx.env, fetchImpl: ctx.fetch});
  const me = await meId(ctx, client);
  const wsBase = streamWsUrl(ctx.env);
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') throw new Error('This Node.js has no WebSocket: Node.js 22 or newer is needed');

  const names = new Map();
  const nameOf = async (id) => {
    if (!id) return undefined;
    if (!names.has(id)) {
      let name;
      try {
        name = displayName(
          (await client.call('POST', '/users/query', {query: {ids: [id]}}, {timeoutMs: 10_000}))?.users?.[0],
        );
      } catch {
        // a name is a nicety: the id is printed anyway
      }
      names.set(id, name);
    }
    return names.get(id);
  };
  const filters = {channels, senders, types, mine, me};

  return new Promise((resolve, reject) => {
    let ws;
    let stopping = false;
    let attempts = 0;
    let renewedFor; // the token a "token" reconnection was made for: once per token, then the usual waits
    let ready = false;
    let left = count;
    let keepalive;
    let retry;
    let deadline;
    let queue = Promise.resolve();

    const finish = (error) => {
      if (stopping) return;
      stopping = true;
      clearInterval(keepalive);
      clearTimeout(retry);
      clearTimeout(deadline);
      ctx.signal?.removeEventListener('abort', onAbort);
      try {
        ws?.close(1000);
      } catch {
        // closing a socket that is gone
      }
      queue.then(() => {
        if (error) return reject(error);
        ctx.emit({event: 'END', reason: 'stopped'});
        resolve();
      });
    };
    const onAbort = () => finish();
    if (ctx.signal?.aborted) return finish();
    ctx.signal?.addEventListener('abort', onAbort, {once: true});
    if (seconds > 0) deadline = setTimeout(() => finish(), seconds * 1000);

    const connect = async () => {
      if (stopping) return;
      if (ws) {
        token = await ctx.freshToken(); // renewed when it ended: the service checks it only when a connection opens
        client = streamClient({token, env: ctx.env, fetchImpl: ctx.fetch});
      }
      if (stopping) return;
      let opened = false;
      let acked = false;
      let socket;
      try {
        socket = new WS(`${wsBase}/?access_token=${encodeURIComponent(token)}`);
      } catch {
        throw new Error(`Cannot open the websocket of the chat service (${wsBase})`); // never the address with the token
      }
      ws = socket;
      const subscribe = () => socket.send(JSON.stringify({action: 'subscribe', version: '2', topic: 'chat'}));
      socket.onopen = () => {
        opened = true;
        subscribe();
        clearInterval(keepalive);
        keepalive = setInterval(subscribe, KEEPALIVE_MS); // subscribing again is harmless
      };
      socket.onmessage = (m) => {
        if (stopping || socket !== ws) return;
        let d;
        try {
          d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'));
        } catch {
          return;
        }
        if (d?.event === 'subscribed') {
          if (acked) return;
          acked = true;
          attempts = 0;
          const shown = drop({
            channels: channels.size ? [...channels] : undefined,
            from: senders.size ? [...senders] : undefined,
            types: types.size ? [...types] : undefined,
            mine: mine || undefined,
          });
          const event = ready ? 'RECONNECTED' : 'READY';
          ready = true;
          queue = queue.then(() => !stopping && ctx.emit({event, user: me, ...shown}));
          return;
        }
        const e = d?.data;
        if (d?.event !== 'broadcast' || typeof e?.eventType !== 'string' || !wanted(e, filters)) return;
        queue = queue.then(async () => {
          if (stopping) return;
          ctx.emit(raw ? {event: e.eventType, ...e} : await view(e, nameOf));
          if (left > 0 && --left === 0) finish();
        });
      };
      socket.onerror = () => {
        // onclose follows and decides
      };
      socket.onclose = (ev) => {
        if (socket !== ws) return;
        clearInterval(keepalive);
        if (stopping) return;
        const again = () => connect().catch((err) => finish(err));
        if (tokenExp(token) && tokenExp(token) - ctx.clock() < 2 * 60 * 1000 && renewedFor !== token) {
          renewedFor = token;
          queue = queue.then(() => !stopping && ctx.emit({event: 'RECONNECTING', reason: 'token'}));
          again();
          return;
        }
        attempts += 1;
        if (!opened && attempts >= 5) {
          finish(
            new AuthError(
              `The chat service did not accept the connection (code ${ev?.code}): log in again (wx login) if this repeats`,
            ),
          );
          return;
        }
        const wait = BACKOFF[attempts - 1] ?? 30;
        queue = queue.then(
          () => !stopping && ctx.emit({event: 'RECONNECTING', code: ev?.code, attempt: attempts, inSeconds: wait}),
        );
        retry = setTimeout(again, wait * 1000);
      };
    };
    connect().catch((err) => finish(err));
  });
}

// One event as a line of text.
export function eventText(e, ctx) {
  const c = paint(ctx);
  const at = c.dim(localTime(ctx?.clock ? ctx.clock() : Date.now(), {seconds: true}));
  const where = e.channel ? c.bold(oneLine(e.channel, 40)) : (e.channelId ?? '');
  const who = (p) => (p ? (p.name ?? p.id) : '?');
  switch (true) {
    case e.event === 'READY':
      return `${at}  ${c.green('watching the chats')}${e.types ? ` (${e.types.join(', ')})` : ''}${e.channels ? ` in ${e.channels.join(', ')}` : ''}${e.from ? ` from ${e.from.join(', ')}` : ''}. Ctrl-C stops.`;
    case e.event === 'RECONNECTING':
      return `${at}  ${c.yellow(e.reason === 'token' ? 'reconnecting (renewing the login)' : `reconnecting in ${e.inSeconds}s (code ${e.code ?? '?'})`)}`;
    case e.event === 'RECONNECTED':
      return `${at}  ${c.green('reconnected')} (events of the pause are not sent again)`;
    case e.event === 'END':
      return `${at}  stopped`;
    case e.event?.startsWith('message.'): {
      const files = (e.attachments ?? []).map((f) => ` [file: ${oneLine(f.name, 60)}]`).join('');
      const text = e.event === 'message.deleted' ? '(deleted)' : `${oneLine(e.text ?? '', 500)}${files}`;
      return `${at}  ${e.event.padEnd(15)}  ${where}  ${c.bold(who(e.from))}: ${text}`;
    }
    case e.event?.startsWith('reaction.'): {
      const counts = Object.entries(e.reactions ?? {})
        .map(([t, n]) => `${t} ${n}`)
        .join(', ');
      return `${at}  ${e.event.padEnd(15)}  ${where}  on a message of ${who(e.messageAuthor)}: ${counts ? `[${counts}]` : '(none)'}`;
    }
    case e.event?.startsWith('read.'):
      return `${at}  ${e.event.padEnd(15)}  ${where}  ${who(e.reader)} read up to #${e.readUpTo ?? '?'}`;
    case e.event?.startsWith('member.'):
      return `${at}  ${e.event.padEnd(15)}  ${where}  ${e.member?.name ?? e.member?.userId ?? '?'}${e.member?.role ? ` (${e.member.role})` : ''}`;
    case e.event?.startsWith('typing.'):
      return `${at}  ${e.event.padEnd(15)}  ${where}  ${who(e.typing)}`;
    default:
      return `${at}  ${String(e.event ?? '').padEnd(15)}  ${where}`;
  }
}
