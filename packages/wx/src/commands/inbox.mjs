// wx inbox: the logged-in user's inbox on the stream service (the agent skill's inbox.sh): what is unread, and the
// user's own state of a channel (read, muted, pinned, hidden). Changes here are seen only by the user.
import {UsageError} from 'wldx-core/errors';
import {paint, table} from 'wldx-core/format';
import {apiPath, query} from 'wldx-core/http';
import {channelId, messageId} from '../stream.mjs';
import {channelLines, channelUserIds, done} from '../chat/format.mjs';
import {api, withNames} from '../chat/lib.mjs';

export function sectionLines(sections, ctx) {
  const c = paint(ctx);
  return table(
    (sections ?? []).map((s) => [
      c.bold(s.name ?? s.sectionId),
      s.sectionId,
      s.type ?? '',
      `${s.channelCount ?? 0} channels`,
      s.unmutedUnreadMessageCount
        ? c.yellow(`${s.unmutedUnreadMessageCount} new in ${s.unmutedUnreadChannelCount ?? '?'}`)
        : '',
      s.unreadMentionCount ? c.yellow(`@${s.unreadMentionCount}`) : '',
    ]),
  );
}

const get = {
  summary: 'your inbox: recent channels with your state, and the counters of the sections',
  usage: 'wx inbox get',
  options: {},
  args: [0, 0],
  async run(ctx) {
    const client = api(ctx);
    const r = await client.call('GET', '/inbox');
    return withNames(ctx, r, (r?.channels ?? []).flatMap(channelUserIds), client);
  },
  text(r, ctx) {
    const lines = sectionLines(r?.sections, ctx);
    if (r?.channels?.length) lines.push('', ...channelLines(r.channels, r, ctx));
    return lines.length ? lines : 'Nothing in the inbox.';
  },
};

const mark = (read) => ({
  summary: read
    ? 'mark a channel read, up to the latest message (or up to a message)'
    : 'mark a channel unread from a message on',
  usage: `wx inbox ${read ? 'mark-read' : 'mark-unread'} <channel> [--message MESSAGE]${read ? '' : ' [--force]'}`,
  options: {
    message: {type: 'string', description: 'the message (id or inbox link)'},
    ...(read ? {} : {force: {type: 'boolean', description: 'also when the channel has no unread messages'}}),
  },
  args: [1, 1],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const body = {};
    if (ctx.values.message !== undefined) body.messageId = messageId(ctx.values.message);
    if (read) return api(ctx).call('POST', apiPath`/channels/${ch}/read`, body);
    return api(ctx).call('PUT', apiPath`/channels/${ch}/unread` + query({force: ctx.values.force && 'true'}), body);
  },
  text: done(read ? 'Marked read' : 'Marked unread'),
});

const mute = {
  summary: 'mute a channel (no notifications), for good or until a time',
  usage: 'wx inbox mute <channel> [--until ISO8601]',
  options: {until: {type: 'string', placeholder: 'ISO8601', description: 'until this time (2026-11-08T09:00:00Z)'}},
  args: [1, 1],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const body = {};
    if (ctx.values.until !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(ctx.values.until) || Number.isNaN(Date.parse(ctx.values.until)))
        throw new UsageError(`--until must be an ISO 8601 time: ${ctx.values.until}`);
      body.mutedUntil = ctx.values.until;
    }
    return api(ctx).call('POST', apiPath`/channels/${ch}/mute`, body);
  },
  text: done('Muted'),
};

const simple = (name, summary, method, suffix, text, body) => ({
  summary,
  usage: `wx inbox ${name} <channel>`,
  options: {},
  args: [1, 1],
  async run(ctx) {
    return api(ctx).call(method, apiPath`/channels/${channelId(ctx.positionals[0])}` + suffix, body);
  },
  text: done(text),
});

const inbox = {
  summary: 'your inbox: unread, mark read or unread, mute, pin, hide (only for you)',
  auth: true,
  commands: {
    get,
    'mark-read': mark(true),
    'mark-unread': mark(false),
    mute,
    unmute: simple('unmute', 'unmute a channel', 'DELETE', '/mute', 'Unmuted'),
    pin: simple('pin', 'pin a channel at the top of your inbox', 'POST', '/pin', 'Pinned', {}),
    unpin: simple('unpin', 'unpin a channel', 'DELETE', '/pin', 'Unpinned'),
    hide: simple('hide', 'archive a channel (hide it from your inbox)', 'POST', '/hide', 'Hidden', {}),
    show: simple('show', 'restore an archived channel', 'POST', '/show', 'Shown', {}),
  },
};

export const groups = {inbox};
