// wx live: what is going on now in the logged-in user's company, from the live stream of Wildix Data Analytics
// (WDA, wss://wda-ws.wildix.com): call queues and their agents (with the statistics of today or the last hour), the
// calls, customer chats and conferences in progress, presence of colleagues, the live transcript of a call, and a
// feed of all this. Read only: nothing here changes a call, a queue or a status. Port of the wildix-live-monitor
// skill (live.sh, live.mjs, stats.mjs): the same commands, options, limits and JSON; `watch` and
// `transcript --follow` print one JSON object per event, {"event": "<EVENT>", "data": {…}} (the skill printed
// `<EVENT> {…}`).
import {jwtClaims} from 'wldx-core/auth';
import {AuthError, UsageError} from 'wldx-core/errors';
import {connect, explain, subscription} from '../live/socket.mjs';
import {SLA_SECONDS, WINDOWS, statsOptions} from '../live/stats.mjs';
import {conversationsText, eventText, presenceText, queuesText, transcriptText} from '../live/text.mjs';
import {
  callIdBySip,
  conversationsResult,
  drop,
  makeViews,
  presenceResult,
  queuesResult,
  transcriptEvents,
  transcriptSnapshot,
  watchFrames,
} from '../live/views.mjs';
import {wdaWsUrl} from 'wldx-core/services';

// Settings of the connection; tests replace them (the WebSocket constructor, shorter waits).
export const liveOptions = {
  WebSocket: undefined, // else ctx.WebSocket, else the global WebSocket of Node 22+
  retryDelays: [1, 2, 5, 10], // seconds before the attempts to reconnect, then retryMaxDelay
  retryMaxDelay: 30,
  connectAttempts: 5, // a watch gives up after this many failed connections in a row
  keepaliveMs: 4 * 60 * 1000, // the gateway drops a connection quiet for 10 minutes; subscribing again is harmless
  tokenMarginMs: 2 * 60 * 1000, // a connection lost this close to the expiry of the token reconnects with a fresh one
  authTimeoutMs: 20_000,
  snapshotTimeoutMs: 30_000,
};

const MAX_SECONDS = 604_800;

const retryDelay = (attempt) => liveOptions.retryDelays[attempt - 1] ?? liveOptions.retryMaxDelay;

// What the live commands need from the login token (never the token itself).
function loginOf(token) {
  const claims = jwtClaims(token);
  const ext = claims['custom:pbx_user_extension'];
  return {
    company: claims.company,
    myExtension: ext ? String(ext) : undefined,
    license: claims['custom:pbx_license'],
    exp: claims.exp,
  };
}

function open(ctx, token, login) {
  return connect({
    url: wdaWsUrl(ctx.env),
    token,
    license: login.license,
    WebSocket: ctx.WebSocket ?? liveOptions.WebSocket ?? globalThis.WebSocket,
    timeoutMs: liveOptions.authTimeoutMs,
    snapshotTimeoutMs: liveOptions.snapshotTimeoutMs,
  });
}

function viewsOf(ctx, login) {
  return makeViews({
    full: Boolean(ctx.values.full),
    company: login.company,
    myExtension: login.myExtension,
    now: () => ctx.clock(),
  });
}

// A one-shot command: connect, run fn(connection, login), close. Ctrl-C closes the connection and prints nothing.
async function oneShot(ctx, fn) {
  const login = loginOf(ctx.token);
  wdaWsUrl(ctx.env); // refuses a bad override before connecting
  const conn = await open(ctx, ctx.token, login);
  const onAbort = () => conn.close();
  ctx.signal?.addEventListener('abort', onAbort, {once: true});
  try {
    return await fn(conn, login);
  } catch (e) {
    if (ctx.signal?.aborted) return undefined;
    throw e;
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
    conn.close();
  }
}

// ── option checks (the limits of live.sh) ─────────────────────────────────────────────────────────────────────
function wholeNumber(name, value, min, max) {
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,12}$/.test(value) || Number(value) < min || Number(value) > max)
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}: ${value}`);
  return Number(value);
}

function check(name, value, pattern, what) {
  if (value !== undefined && !pattern.test(value)) throw new UsageError(`${what}: ${value}`);
  return value;
}

const EXTENSION = /^[0-9]{1,15}$/;
const wantsStats = (v) => Boolean(v.stats || v.window !== undefined || v.sla !== undefined);
const statsOptsOf = (ctx) => statsOptions(ctx.values.window ?? 'today', Number(ctx.values.sla ?? 20), ctx.clock());

const full = {
  type: 'boolean',
  description: 'everything the service sends, also e-mail, IP address, location and user agent of people',
};
const statsOptionsDef = {
  stats: {type: 'boolean', description: 'the figures of each queue, of each agent in it and of all of them together'},
  window: {
    type: 'string',
    choices: WINDOWS,
    description:
      'the window of the figures: today (default, from the local midnight) or the last minutes (implies --stats)',
  },
  sla: {
    type: 'string',
    choices: SLA_SECONDS.map(String),
    description: 'the answer-within target of the service level, seconds (20 by default; implies --stats)',
  },
};

// ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────
const queues = {
  summary: 'the call queues of the company: strategy, calls in them now, agents with their status (Premium)',
  usage:
    'wx live queues [--name TEXT] [--pbx SERIAL] [--busy] [--paused] [--active] [--stats] [--window W] [--sla S] [--full]',
  details: [
    "The queues with calls first. An agent's status is the queue's view (available, pause…); reason and message are",
    "the user's own status (DND, AWAY and its text). --stats counts since the local midnight (--window today) or over",
    'the last 15/30/45/60 minutes (WDA counts in 15-minute buckets: window.minutes says what was covered). In text the',
    'agents are listed under their queue when 10 queues or fewer are shown.',
  ].join('\n'),
  options: {
    name: {type: 'string', placeholder: 'TEXT', description: 'only the queues whose name contains the text (any case)'},
    pbx: {type: 'string', placeholder: 'SERIAL', description: 'only the queues of one PBX of the company'},
    busy: {type: 'boolean', description: 'only the queues with calls now'},
    paused: {type: 'boolean', description: 'only the queues with a paused agent'},
    active: {type: 'boolean', description: 'only the queues with a call now or in the window'},
    ...statsOptionsDef,
    full,
  },
  args: [0, 0],
  async run(ctx) {
    const v = ctx.values;
    check('pbx', v.pbx, /^[A-Za-z0-9]{4,32}$/, 'Not a PBX serial');
    if (v.name !== undefined && v.name.length > 100)
      throw new UsageError('--name is too long (100 characters at most)');
    const stats = wantsStats(v);
    return oneShot(ctx, async (conn, login) => {
      const items = await conn.snapshot('services', stats ? statsOptsOf(ctx) : {});
      return queuesResult(
        items,
        {pbx: v.pbx, name: v.name, busy: v.busy, paused: v.paused, active: v.active, stats},
        viewsOf(ctx, login),
      );
    });
  },
  text: queuesText,
};

const conversations = {
  summary: 'the calls, customer chats and conferences going on now, newest first, with their live insights (Premium)',
  usage: 'wx live conversations [--calls] [--chats] [--conferences] [--mine] [--status S] [--limit N] [--full]',
  details:
    'byType counts all of them before the filters. --status keeps the chats in that status (or the calls whose last flow is in it).',
  options: {
    calls: {type: 'boolean', description: 'only calls'},
    chats: {type: 'boolean', description: 'only customer chats'},
    conferences: {type: 'boolean', description: 'only conferences'},
    mine: {type: 'boolean', description: 'only your own calls'},
    status: {
      type: 'string',
      placeholder: 'S',
      description:
        'only this status: TALKING, HOLD, CONNECTING, WAITFIRSTREPLY, WAITREPLYFROMAGENT, WAITREPLYFROMGUEST…',
    },
    limit: {type: 'string', placeholder: 'N', description: 'at most N items, 1 to 1000 (50 by default)'},
    full,
  },
  args: [0, 0],
  async run(ctx) {
    const v = ctx.values;
    check('status', v.status, /^[A-Za-z_]{1,40}$/, 'Not a status');
    const limit = wholeNumber('limit', v.limit, 1, 1000) ?? 50;
    const kinds = ['calls', 'chats', 'conferences'].filter((k) => v[k]).map((k) => k.slice(0, -1));
    return oneShot(ctx, async (conn, login) => {
      const items = await conn.snapshot('conversations');
      return conversationsResult(items, {kinds, mine: v.mine, status: v.status, limit}, viewsOf(ctx, login));
    });
  },
  text: conversationsText,
};

const presence = {
  summary: 'status, status message, "until" and phone registration of colleagues (is someone available)',
  usage: 'wx live presence <extension>... [--full]',
  details:
    'Up to 50 extensions of your company. phone is REGISTERED when a phone of theirs is online; an extension nobody has gives status unknown.',
  options: {full},
  args: [1, 50],
  async run(ctx) {
    for (const ext of ctx.positionals) check('extension', ext, EXTENSION, 'Not an extension');
    if (!loginOf(ctx.token).company) throw new Error('this login names no company');
    return oneShot(ctx, async (conn, login) => {
      const items = await conn.snapshot('presence', {filter: ctx.positionals.map((ext) => [null, login.company, ext])});
      return presenceResult(items, ctx.positionals, viewsOf(ctx, login));
    });
  },
  text: presenceText,
};

// The WDA id of a call: as given when it is one, else through the conversations of the company (Premium only).
async function wdaCallId(conn, id, login) {
  if (login.company && id.startsWith(`${login.company}_`)) return id;
  let items;
  try {
    items = await conn.snapshot('conversations', {state: true});
  } catch (e) {
    throw new Error(`${e.message}. Without it, give the WDA id of the call (${login.company ?? '<company>'}_…)`);
  }
  const found = callIdBySip(items, id);
  if (!found) throw new Error(`no call going on now has the SIP call id ${id}`);
  return found;
}

const transcript = {
  summary: 'the live transcript of a call or conference in progress; --follow prints each new line until it ends',
  usage: 'wx live transcript <callId|conference:ID> [--follow] [--for SECONDS] [--full]',
  details: [
    '<callId> is the WDA id of a call (from wx live conversations) or its SIP call id (turned into the WDA id through',
    'the conversations: Premium only). A transcript exists only while the call lasts and transcription runs on it.',
    'With --follow: SNAPSHOT, then TEXT (final: false is a partial phrase a final one replaces), CALL, ANNOTATION, END.',
  ].join('\n'),
  options: {
    follow: {type: 'boolean', description: 'then print each change until the call ends'},
    for: {type: 'string', placeholder: 'SECONDS', description: 'with --follow: stop after SECONDS (1 to 604800)'},
    full,
  },
  args: [1, 1],
  async run(ctx) {
    const arg = ctx.positionals[0];
    if (!/^(conference:)?[A-Za-z0-9._@:+-]{1,200}$/.test(arg))
      throw new UsageError(`Name the call: its WDA id or its SIP call id (or conference:<id>): ${arg}`);
    const secs = wholeNumber('for', ctx.values.for, 1, MAX_SECONDS) ?? 0;
    return oneShot(ctx, async (conn, login) => {
      const views = viewsOf(ctx, login);
      const kind = arg.startsWith('conference:') ? 'conference' : 'call';
      const id = kind === 'conference' ? arg.slice('conference:'.length) : await wdaCallId(conn, arg, login);
      let items;
      try {
        items = await conn.snapshot('transcriptions', {state: true, filter: [[kind, id]]});
      } catch (e) {
        throw new Error(
          e.message.includes('not found')
            ? `${kind} ${id} is not going on now (a live transcript exists only while it lasts)`
            : e.message,
        );
      }
      const {call, snapshot} = transcriptSnapshot(items, id, kind, views);
      if (!ctx.values.follow) return snapshot;
      ctx.emit({event: 'SNAPSHOT', data: snapshot});
      const state = {call};
      await new Promise((resolve, reject) => {
        let timer;
        const done = (err) => {
          clearTimeout(timer);
          conn.listeners.delete(listener);
          ctx.signal?.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve();
        };
        const onAbort = () => done();
        const listener = (d) => {
          if (d.event === '_closed') return done(new Error(`the connection was lost (code ${d.code})`));
          if (d.event !== 'broadcast' || d.topic !== 'transcriptions') return;
          for (const it of Array.isArray(d.data) ? d.data : [d.data]) {
            const {events, end} = transcriptEvents(it, id, state, views);
            for (const e of events) ctx.emit(e);
            if (end) return done();
          }
        };
        conn.listeners.add(listener);
        if (ctx.signal?.aborted) return done();
        ctx.signal?.addEventListener('abort', onAbort, {once: true});
        if (secs) timer = setTimeout(() => done(), secs * 1000);
      });
      return undefined;
    });
  },
  text: transcriptText,
  textEvent: eventText,
};

const watch = {
  summary: 'a live feed: one line per change of the conversations, queues or presence until stopped',
  usage:
    'wx live watch [--conversations] [--calls] [--mine] [--queues] [--stats] [--window W] [--sla S] [--presence EXT]... [--for SECONDS] [--full]',
  details: [
    'Without a choice: --conversations. --stats implies --queues and adds QUEUES and QUEUE_STATS lines. Events: READY,',
    'RECONNECTING, RECONNECTED, ERROR, CALL, CALL_COMPLETE, CALL_INTERRUPTED, CALL_ANNOTATION, CHAT…, CONFERENCE…,',
    'QUEUE, QUEUE_CALL, QUEUES, QUEUE_STATS, PRESENCE. With --output json one object per line: {"event", "data"}.',
    'It reconnects by itself, also when the login token is renewed. A whole company is busy: watch what you need.',
  ].join('\n'),
  options: {
    conversations: {type: 'boolean', description: 'the calls, chats and conferences (the default)'},
    calls: {type: 'boolean', description: 'only the calls of the conversations'},
    mine: {type: 'boolean', description: 'only your own calls'},
    queues: {type: 'boolean', description: 'the call queues and the calls entering and leaving them'},
    ...statsOptionsDef,
    presence: {type: 'string', multiple: true, placeholder: 'EXT', description: 'the presence of this extension'},
    for: {type: 'string', placeholder: 'SECONDS', description: 'stop after SECONDS (1 to 604800)'},
    full,
  },
  args: [0, 0],
  run(ctx) {
    const v = ctx.values;
    const presenceExt = v.presence ?? [];
    for (const ext of presenceExt) check('presence', ext, EXTENSION, 'Not an extension');
    const secs = wholeNumber('for', v.for, 1, MAX_SECONDS) ?? 0;
    wdaWsUrl(ctx.env); // refuses a bad override before connecting
    let token = ctx.token;
    const login = loginOf(token);
    if (presenceExt.length && !login.company) throw new Error('this login names no company');
    const wantStats = wantsStats(v);
    const wantQueues = Boolean(v.queues) || wantStats;
    const wantConv = Boolean(v.conversations || v.calls || v.mine) || (!wantQueues && !presenceExt.length);
    const statsOpts = () => statsOptsOf(ctx);
    const handler = watchFrames({
      views: viewsOf(ctx, login),
      wantConv,
      wantQueues,
      wantStats,
      calls: v.calls,
      mine: v.mine,
      statsOpts,
      explain: (topic, d) => explain(topic, d, login.license),
    });
    // With stats the queues are subscribed with their current state, to learn their names (a stats update names
    // only the queue id); the state itself is not printed. The keepalive asks again without the state.
    const queueSub = (state) => subscription('services', wantStats ? {state, ...statsOpts()} : {state: false});
    const subscriptions = (first = false) => [
      ...(wantConv ? [subscription('conversations', {state: false})] : []),
      ...(wantQueues ? [queueSub(first && wantStats)] : []),
      ...(presenceExt.length
        ? [subscription('presence', {state: false, filter: presenceExt.map((e) => [null, login.company, e])})]
        : []),
    ];

    return new Promise((resolve, reject) => {
      let conn;
      let keepalive;
      let retryTimer;
      let deadlineTimer;
      let attempts = 0;
      let ready = false;
      let stopped = false;
      let renewedFor; // the token a "token" reconnection was made for (once per token, then the usual waits)

      const finish = (err) => {
        if (stopped) return;
        stopped = true;
        clearInterval(keepalive);
        clearTimeout(retryTimer);
        clearTimeout(deadlineTimer);
        ctx.signal?.removeEventListener('abort', onAbort);
        conn?.close();
        if (err) reject(err);
        else resolve(undefined);
      };
      const onAbort = () => finish();

      const onFrame = (d) => {
        if (stopped) return;
        if (d.event === '_closed') {
          clearInterval(keepalive);
          conn = undefined;
          const exp = loginOf(token).exp;
          if (Number.isFinite(exp) && exp * 1000 - ctx.clock() < liveOptions.tokenMarginMs && renewedFor !== token) {
            renewedFor = token;
            ctx.emit({event: 'RECONNECTING', data: {reason: 'token'}});
            start();
            return;
          }
          attempts += 1;
          const wait = retryDelay(attempts);
          ctx.emit({event: 'RECONNECTING', data: {code: d.code, attempt: attempts, inSeconds: wait}});
          retryTimer = setTimeout(start, wait * 1000);
          return;
        }
        const {events, fatal} = handler.frame(d);
        for (const e of events) ctx.emit(e);
        if (fatal) finish(new Error(fatal));
      };

      async function start() {
        if (stopped) return;
        let c;
        try {
          // Before every reconnection: the token again, renewed when it expired.
          if (ready) token = await ctx.freshToken();
          c = await open(ctx, token, login);
        } catch (e) {
          if (stopped) return;
          if (e instanceof AuthError) return finish(e);
          attempts += 1;
          if (attempts >= liveOptions.connectAttempts) return finish(e);
          retryTimer = setTimeout(start, retryDelay(attempts) * 1000);
          return;
        }
        if (stopped) {
          c.close();
          return;
        }
        conn = c;
        handler.reset();
        c.listeners.add(onFrame);
        for (const s of subscriptions(true)) c.send(s);
        attempts = 0;
        clearInterval(keepalive);
        keepalive = setInterval(() => {
          for (const s of subscriptions()) conn?.send(s);
        }, liveOptions.keepaliveMs);
        ctx.emit({
          event: ready ? 'RECONNECTED' : 'READY',
          data: drop({
            extension: login.myExtension,
            license: login.license,
            topics: [wantConv && 'conversations', wantQueues && 'queues', presenceExt.length && 'presence'].filter(
              Boolean,
            ),
            calls: v.calls || undefined,
            mine: v.mine || undefined,
            stats: wantQueues && wantStats ? statsOpts() : undefined,
          }),
        });
        ready = true;
      }

      if (ctx.signal?.aborted) return finish();
      ctx.signal?.addEventListener('abort', onAbort, {once: true});
      if (secs) deadlineTimer = setTimeout(() => finish(), secs * 1000);
      start();
    });
  },
  textEvent: eventText,
};

export const groups = {
  live: {
    summary: 'what is going on now: queues and agents, calls and chats in progress, presence, live transcripts',
    auth: true,
    commands: {queues, conversations, presence, transcript, watch},
  },
};

export default {groups};
