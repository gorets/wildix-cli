// wx chat: channels and messages of the Wildix stream service, as the logged-in user (the agent skill's
// messages.sh, mentions.sh, search.sh messages and watch.sh). The inbox state is `wx inbox`, channels and their
// members `wx channel`, files `wx file`, people `wx user`.
import {AuthError, UsageError} from 'wldx-core/errors';
import {localTime, oneLine, paint, table} from 'wldx-core/format';
import {apiPath, query} from 'wldx-core/http';
import {channelId, messageId} from '../stream.mjs';
import {channelLines, channelUserIds, done, messageLines, messageText, nextPage} from '../chat/format.mjs';
import {
  api,
  attachmentOf,
  checkId,
  checkInt,
  checkReaction,
  meId,
  messageUserIds,
  nameIn,
  readText,
  uploadFile,
  withNames,
} from '../chat/lib.mjs';
import {EVENT_CHOICES, EVENT_GROUPS, eventText, watch} from '../chat/watch.mjs';

const SEQ_MAX = 999_999_999_999;
const seq = (name, value) => checkInt(name, value, 0, SEQ_MAX);

const target = (positionals) => ({ch: channelId(positionals[0]), msg: messageId(positionals[1])});

// Stops (exit 2) unless the message is the user's own; returns the message.
async function ownMessage(ctx, client, ch, msg) {
  const r = await client.call('GET', apiPath`/channels/${ch}/messages/${msg}`);
  const author = r?.message?.userId;
  const me = await meId(ctx, client);
  if (!author || author !== me)
    throw new AuthError(`The message is not yours (author: ${author ?? 'unknown'}, you: ${me}). Nothing was changed.`);
  return r.message;
}

// The body of a full update (PUT): the new text with what the message already has, so nothing is lost. Never
// `silent`.
export function editBody(message, text, markdown) {
  const ref = (o) => (o ? {channelId: o.channelId, messageId: o.messageId} : undefined);
  const body = {
    text,
    mentions: message.mentions ?? [],
    attachments: (message.attachments ?? []).map(attachmentOf),
    elements: message.elements,
    quote: ref(message.quote),
    forward: ref(message.forward),
    markdown: markdown ? true : message.markdown,
  };
  return Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)),
  );
}

const sentText = (verb) => (r, ctx) => {
  const m = r?.message;
  return m ? `${verb} ${m.messageId}${m.createdAt ? ` at ${localTime(m.createdAt)}` : ''}` : verb;
};

const list = {
  summary: 'your channels, newest activity first',
  usage: 'wx chat list [--filter unread|archived] [--section ID] [--cursor C]',
  options: {
    filter: {type: 'string', description: 'only unread or archived channels', choices: ['unread', 'archived']},
    section: {type: 'string', description: 'only the channels of a section'},
    cursor: {type: 'string', description: 'the next page (nextCursor of the previous one)'},
  },
  args: [0, 0],
  async run(ctx) {
    const {values} = ctx;
    const client = api(ctx);
    const r = await client.call(
      'GET',
      `/channels${query({filter: values.filter, section: values.section, cursor: values.cursor})}`,
    );
    return withNames(ctx, r, (r?.channels ?? []).flatMap(channelUserIds), client);
  },
  text(r, ctx) {
    if (!r?.channels?.length) return 'No channels.';
    return [...channelLines(r.channels, r, ctx), ...nextPage(r.nextCursor, paint(ctx))];
  },
};

const read = {
  summary: 'messages of a channel, newest first, 30 per page',
  usage: 'wx chat read <channel> [--unread] [--from SEQ] [--to SEQ]',
  details: [
    'A channel is an id or an inbox link. --from and --to are inclusive timelineSeq bounds: for the next older page,',
    'pass the smallest timelineSeq of the page minus 1 as --to. The text output shows the page oldest first.',
  ].join('\n'),
  options: {
    unread: {type: 'boolean', description: 'start at the first unread message'},
    from: {type: 'string', description: 'from this sequence number'},
    to: {type: 'string', description: 'up to this sequence number'},
  },
  args: [1, 1],
  async run(ctx) {
    const {values, positionals} = ctx;
    const ch = channelId(positionals[0]);
    const q = query({from: seq('from', values.from), to: seq('to', values.to), anchor: values.unread && 'firstUnread'});
    const client = api(ctx);
    const r = await client.call('GET', apiPath`/channels/${ch}/messages` + q);
    return withNames(ctx, r, (r?.messages ?? []).flatMap(messageUserIds), client);
  },
  text(r, ctx) {
    const messages = r?.messages ?? [];
    if (!messages.length) return 'No messages.';
    const lines = messageLines(messages, r, ctx);
    const oldest = Math.min(...messages.map((m) => m.timelineSeq ?? Infinity));
    if (messages.length >= 30 && Number.isFinite(oldest) && oldest > 0)
      lines.push(paint(ctx).dim(`Older: --to ${oldest - 1}`));
    return lines;
  },
};

const send = {
  summary: 'send a message to a channel ("-" reads the text from stdin)',
  usage: 'wx chat send <channel> <text|-> [--markdown] [--reply-to MESSAGE] [--mention USERID]... [--file PATH]...',
  details:
    'Sends as the logged-in user. --file uploads the file and attaches it (files in credential folders are refused).',
  options: {
    markdown: {type: 'boolean', description: 'the text is markdown'},
    'reply-to': {type: 'string', description: 'quote this message (id or inbox link)'},
    mention: {type: 'string', multiple: true, placeholder: 'USERID', description: 'mention this user'},
    file: {type: 'string', multiple: true, placeholder: 'PATH', description: 'attach this file'},
  },
  args: [2, 2],
  async run(ctx) {
    const {values, positionals, stdin} = ctx;
    const ch = channelId(positionals[0]);
    const text = await readText(positionals[1], stdin);
    const files = values.file ?? [];
    if (!text.trim() && !files.length) throw new UsageError('Nothing to send: the text is empty');
    const body = {};
    if (text.trim()) body.text = text;
    if (values.markdown) body.markdown = true;
    if (values['reply-to']) body.quote = {channelId: ch, messageId: messageId(values['reply-to'])};
    if (values.mention?.length) body.mentions = values.mention.map((u) => checkId('--mention', u));
    const client = api(ctx);
    if (files.length) {
      body.attachments = [];
      for (const f of files) body.attachments.push(await uploadFile(ctx, ch, f, client));
    }
    return client.call('POST', apiPath`/channels/${ch}/messages`, body);
  },
  text: sentText('Sent'),
};

const get = {
  summary: 'one message',
  usage: 'wx chat get <channel> <message>',
  details: 'A message is an id or an inbox link to it. Who reacted: wx chat reactions.',
  options: {},
  args: [2, 2],
  async run(ctx) {
    const {ch, msg} = target(ctx.positionals);
    const client = api(ctx);
    const r = await client.call('GET', apiPath`/channels/${ch}/messages/${msg}`);
    return withNames(ctx, r, [...messageUserIds(r?.message), ...(r?.message?.mentions ?? [])], client);
  },
  text(r, ctx) {
    const m = r?.message;
    if (!m) return 'No message.';
    const c = paint(ctx);
    const rows = [
      ['Message', `${m.messageId} (#${m.timelineSeq})`],
      ['From', c.bold(nameIn(r, m.userId))],
      ['At', `${localTime(m.createdAt)}${m.editedAt ? `, edited ${localTime(m.editedAt)}` : ''}`],
    ];
    if (m.quote) rows.push(['Reply to', `${nameIn(r, m.quote.userId)}: ${oneLine(m.quote.text ?? '', 100)}`]);
    if (m.mentions?.length) rows.push(['Mentions', m.mentions.map((id) => nameIn(r, id)).join(', ')]);
    for (const f of m.attachments ?? [])
      rows.push(['File', `${f.name} (${f.mime ?? '?'}, ${f.size ?? '?'} bytes) fsId ${f.fsId}`]);
    const counts = Object.entries(m.reactionCounts ?? {})
      .map(([t, n]) => `${t} ${n}`)
      .join(', ');
    if (counts) rows.push(['Reactions', counts]);
    if (m.pinned) rows.push(['Pinned', `${localTime(m.pinnedAt)}${m.pinnedBy ? ` by ${nameIn(r, m.pinnedBy)}` : ''}`]);
    const body = m.messageType === 'deleted' || m.deletedAt ? ['(deleted)'] : String(m.text ?? '').split('\n');
    return [...table(rows), '', ...body];
  },
};

const edit = {
  summary: 'edit your own message ("-" reads the new text from stdin)',
  usage: 'wx chat edit <channel> <message> <text|-> [--markdown]',
  details: [
    'Only your own messages (else exit 2, nothing changed). The full update (PUT) is used, since the partial one',
    '(PartialUpdateMessage) is not implemented by the service yet: the new text is sent with what the message has',
    '(attachments, quote, mentions). --markdown is accepted, but the service does not store it on an edit yet.',
  ].join('\n'),
  options: {markdown: {type: 'boolean', description: 'the new text is markdown'}},
  args: [3, 3],
  async run(ctx) {
    const {ch, msg} = target(ctx.positionals);
    const text = await readText(ctx.positionals[2], ctx.stdin);
    if (!text.trim()) throw new UsageError('The new text is empty');
    const client = api(ctx);
    const message = await ownMessage(ctx, client, ch, msg);
    return client.call('PUT', apiPath`/channels/${ch}/messages/${msg}`, editBody(message, text, ctx.values.markdown));
  },
  text: sentText('Edited'),
};

const del = {
  summary: 'delete your own message, for everyone (needs --yes)',
  usage: 'wx chat delete <channel> <message> --yes',
  details:
    'Only your own messages (else exit 2, nothing changed). Confirm with the person first: --yes is not the confirmation.',
  options: {yes: {type: 'boolean', description: 'yes, delete it for everyone'}},
  args: [2, 2],
  async run(ctx) {
    const {ch, msg} = target(ctx.positionals);
    if (!ctx.values.yes)
      throw new UsageError(
        'delete removes the message for everyone: confirm with the person, then add --yes',
        ctx.usage(),
      );
    const client = api(ctx);
    await ownMessage(ctx, client, ch, msg);
    return client.call('DELETE', apiPath`/channels/${ch}/messages/${msg}`);
  },
  text: done('Deleted'),
};

const pinCmd = (pin) => ({
  summary: pin ? 'pin a message in its channel (clients then show it as edited)' : 'unpin a message',
  usage: `wx chat ${pin ? 'pin' : 'unpin'} <channel> <message>`,
  options: {},
  args: [2, 2],
  async run(ctx) {
    const {ch, msg} = target(ctx.positionals);
    return api(ctx).call(pin ? 'PUT' : 'DELETE', apiPath`/channels/${ch}/messages/${msg}/pin`);
  },
  text: done(pin ? 'Pinned' : 'Unpinned'),
});

const reactCmd = (add) => ({
  summary: add ? 'react to a message (eyes, white_check_mark, thumbsup, heart…)' : 'take your reaction back',
  usage: `wx chat ${add ? 'react' : 'unreact'} <channel> <message> <type>`,
  details: 'A type is a name of [a-z0-9_+-] (up to 64). One reaction of each type per person; twice is harmless.',
  options: {},
  args: [3, 3],
  async run(ctx) {
    const {ch, msg} = target(ctx.positionals);
    const type = checkReaction(ctx.positionals[2]);
    return api(ctx).call(add ? 'PUT' : 'DELETE', apiPath`/channels/${ch}/messages/${msg}/reactions/${type}`);
  },
  text: (r, ctx) => (add ? `Reacted with ${ctx.positionals[2]}` : `Removed ${ctx.positionals[2]}`),
});

const reactions = {
  summary: 'who reacted to a message: one entry per person and type',
  usage: 'wx chat reactions <channel> <message> [--type TYPE] [--users]',
  details:
    'The JSON gives user ids; --users adds the name, e-mail and bot of each (the text output always shows names).',
  options: {
    type: {type: 'string', description: 'only this reaction type'},
    users: {type: 'boolean', description: 'add the name, e-mail and bot of each person (JSON)'},
  },
  args: [2, 2],
  async run(ctx) {
    const {ch, msg} = target(ctx.positionals);
    const body = {messageIds: [msg]};
    if (ctx.values.type !== undefined) body.type = checkReaction(ctx.values.type);
    const client = api(ctx);
    const r = await client.call('POST', apiPath`/channels/${ch}/reactions/query`, body);
    const ids = [...new Set((r?.reactions ?? []).map((x) => x.userId))];
    if (ctx.values.users && ids.length) {
      const u = await client.call('POST', '/users/query', {query: {ids}});
      const byId = new Map((u?.users ?? []).map((p) => [p.id, p]));
      r.reactions = r.reactions.map((x) => {
        const p = byId.get(x.userId);
        return {...x, user: p ? {name: p.displayName ?? p.name, email: p.email, bot: p.bot} : null};
      });
      return r;
    }
    return withNames(ctx, r, ids, client);
  },
  text(r) {
    const list = r?.reactions ?? [];
    if (!list.length) return 'No reactions.';
    const byType = new Map();
    for (const x of list) byType.set(x.type, [...(byType.get(x.type) ?? []), x.user?.name ?? nameIn(r, x.userId)]);
    return table([...byType].map(([type, people]) => [type, String(people.length), people.join(', ')]));
  },
};

const mentions = {
  summary: 'messages that mention you',
  usage: 'wx chat mentions [--unread] [--cursor C]',
  options: {
    unread: {type: 'boolean', description: 'only the unread ones'},
    cursor: {type: 'string', description: 'the next page (nextCursor of the previous one)'},
  },
  args: [0, 0],
  async run(ctx) {
    const client = api(ctx);
    const r = await client.call(
      'GET',
      `/mentions${query({filter: ctx.values.unread && 'unread', cursor: ctx.values.cursor})}`,
    );
    return withNames(
      ctx,
      r,
      (r?.mentions ?? []).flatMap((x) => [...messageUserIds(x.message), x.channel?.peerId]),
      client,
    );
  },
  text(r, ctx) {
    const c = paint(ctx);
    const list = r?.mentions ?? [];
    if (!list.length) return 'No mentions.';
    const rows = list.map((x) => [
      c.dim(localTime(x.message?.createdAt ?? x.mentionAddedAt)),
      x.read ? '' : c.yellow('new'),
      c.bold(x.channel?.subject || (x.channel?.peerId ? nameIn(r, x.channel.peerId) : x.channelId)),
      `${nameIn(r, x.message?.userId)}: ${messageText(x.message, r, {max: 300})}`,
      c.dim(`${x.channelId} ${x.messageId}`),
    ]);
    return [...table(rows), ...nextPage(r.nextCursor, c)];
  },
};

const SORT = ['relevance', 'recency', 'recency_asc'];

const search = {
  summary: 'search messages in your channels',
  usage:
    'wx chat search <query> [--channel C] [--sender USERID]... [--attachments] [--links] [--size 1-50] [--cursor C] [--sort relevance|recency|recency_asc]',
  options: {
    channel: {type: 'string', description: 'only in this channel (id or inbox link)'},
    sender: {type: 'string', multiple: true, placeholder: 'USERID', description: 'only messages of this person'},
    attachments: {type: 'boolean', description: 'only messages with files'},
    links: {type: 'boolean', description: 'only messages with links'},
    size: {type: 'string', placeholder: '1-50', description: 'results per page (default 20)'},
    cursor: {type: 'string', description: 'the next page (nextCursor of the previous one)'},
    sort: {type: 'string', choices: SORT, description: 'the order of the results'},
  },
  args: [1, 1],
  async run(ctx) {
    const {values, positionals} = ctx;
    const q = query({
      q: positionals[0],
      channelId: values.channel === undefined ? undefined : channelId(values.channel),
      hasAttachments: values.attachments && 'true',
      hasLinks: values.links && 'true',
      size: checkInt('size', values.size, 1, 50),
      cursor: values.cursor,
      sort: values.sort,
      senderIds: (values.sender ?? []).map((s) => checkId('--sender', s)),
    });
    const client = api(ctx);
    const r = await client.call('GET', `/search/messages${q}`);
    return withNames(
      ctx,
      r,
      (r?.results ?? []).flatMap((x) => messageUserIds(x.message)),
      client,
    );
  },
  text(r, ctx) {
    const c = paint(ctx);
    const list = r?.results ?? [];
    if (!list.length) return 'Nothing found.';
    const rows = list.map((x) => [
      c.dim(localTime(x.message?.createdAt)),
      c.bold(nameIn(r, x.message?.userId)),
      messageText(x.message, r, {max: 300}),
      c.dim(`${x.channelId} ${x.message?.messageId ?? ''}`),
    ]);
    const total = r.totalCount !== undefined ? [c.dim(`${list.length} of ${r.totalCount}`)] : [];
    return [...table(rows), ...total, ...nextPage(r.nextCursor, c)];
  },
};

const watchCmd = {
  summary: 'follow your chats live: messages, reactions, reads, members, channel changes',
  usage:
    'wx chat watch [--channel C]... [--from USERID]... [--type TYPE]... [--mine] [--count N] [--for SECONDS] [--raw]',
  details: [
    'Read only: nothing is sent and nothing is marked read. One line per event (one JSON object per line with',
    '--output json): READY when listening, then message.new, reaction.new, read.receipt.updated, member.added,',
    'channel.updated, typing.start…; RECONNECTING / RECONNECTED while the connection is renewed, END at the end.',
    'Types: the groups messages, reactions, reads, members, channels, typing, or one event. By default your own',
    'messages and reading are left out (--mine keeps them). A reaction event does not say who reacted (see',
    'wx chat reactions), so --from leaves reactions out. Delivery is best effort: after RECONNECTED, read the',
    'channel when nothing may be missed. Waiting for one answer:',
    '  wx chat watch --channel C --from USERID --type message.new --count 1 --for 3600',
  ].join('\n'),
  options: {
    channel: {type: 'string', multiple: true, placeholder: 'C', description: 'only this channel (id or inbox link)'},
    from: {
      type: 'string',
      multiple: true,
      placeholder: 'USERID',
      description: 'only what this person did (messages, reading, typing)',
    },
    type: {
      type: 'string',
      multiple: true,
      choices: EVENT_CHOICES,
      description: 'only these events: a group or one event',
    },
    mine: {type: 'boolean', description: 'also what you did yourself'},
    count: {type: 'string', placeholder: 'N', description: 'stop after N events (1-100000)'},
    for: {type: 'string', placeholder: 'SECONDS', description: 'stop after this long (1-604800)'},
    raw: {type: 'boolean', description: 'each event as the service sends it'},
  },
  args: [0, 0],
  async run(ctx) {
    const {values} = ctx;
    const types = new Set((values.type ?? []).flatMap((t) => EVENT_GROUPS[t] ?? [t]));
    await watch(ctx, {
      channels: new Set((values.channel ?? []).map(channelId)),
      senders: new Set((values.from ?? []).map((u) => checkId('--from', u))),
      types,
      mine: Boolean(values.mine),
      raw: Boolean(values.raw),
      count: checkInt('count', values.count, 1, 100_000) ?? 0,
      seconds: checkInt('for', values.for, 1, 604_800) ?? 0,
    });
  },
  textEvent(e, ctx) {
    if (ctx.values.raw && !['READY', 'RECONNECTING', 'RECONNECTED', 'END'].includes(e.event))
      return `${e.event} ${JSON.stringify(e)}`;
    return eventText(e, ctx);
  },
};

const chat = {
  summary: 'chats: channels, messages, reactions, mentions, search, the live feed',
  auth: true,
  commands: {
    list,
    read,
    send,
    get,
    edit,
    delete: del,
    pin: pinCmd(true),
    unpin: pinCmd(false),
    react: reactCmd(true),
    unreact: reactCmd(false),
    reactions,
    mentions,
    search,
    watch: watchCmd,
  },
};

export const groups = {chat};
export default chat;
