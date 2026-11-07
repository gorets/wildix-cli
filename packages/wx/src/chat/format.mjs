// Text output of the chat commands: one line per channel, message, member or person, local times, names of
// people instead of their ids (looked up by the command, see withNames in lib.mjs).
import {localTime, oneLine, paint, table} from 'wldx-core/format';
import {displayName, nameIn} from './lib.mjs';

const reactions = (counts) => {
  const parts = Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`);
  return parts.length ? `[${parts.join(', ')}]` : '';
};

// The text of a message on one line, with what goes with it: files, reply, edits, reactions.
export function messageText(m, data, {max = 2000} = {}) {
  if (!m) return '';
  if (m.messageType === 'deleted' || m.deletedAt) return '(deleted)';
  const parts = [];
  if (m.system) parts.push('[system]');
  if (m.quote) parts.push(`(reply to ${nameIn(data, m.quote.userId)})`);
  if (m.forward) parts.push('(forwarded)');
  if (m.text) parts.push(oneLine(m.text, max));
  for (const f of m.attachments ?? []) parts.push(`[file: ${oneLine(f.name, 80)}]`);
  if (m.giphy) parts.push('[giphy]');
  if (m.pollId) parts.push('[poll]');
  if (m.editedAt) parts.push('(edited)');
  if (m.pinned) parts.push('(pinned)');
  const r = reactions(m.reactionCounts);
  if (r) parts.push(r);
  return parts.join(' ');
}

// Messages as a transcript, oldest first: time, author, text, and the message id.
export function messageLines(messages, data, ctx) {
  const c = paint(ctx);
  const sorted = [...(messages ?? [])].sort((a, b) => (a.timelineSeq ?? 0) - (b.timelineSeq ?? 0));
  return table(
    sorted.map((m) => [
      c.dim(localTime(m.createdAt)),
      c.bold(nameIn(data, m.userId) || '?'),
      `${messageText(m, data)}  ${c.dim(m.messageId)}`,
    ]),
  );
}

// The title of a channel: its subject, or for a 1:1 channel the name of the other person.
export const channelTitle = (ch, data) =>
  ch?.subject ||
  (ch?.peerId ? nameIn(data, ch.peerId) : '') ||
  (ch?.channelType === 'direct' ? '(direct)' : '(no subject)');

// The people a channel line names: the other person of a 1:1 channel, the author of the last message.
export const channelUserIds = (ch) => [ch?.peerId, ch?.lastMessage?.userId];

function flags(ch, c) {
  const i = ch.inbox;
  if (!i) return '';
  const f = [];
  if (i.unreadCount) f.push(c.yellow(`${i.unreadCount} new`));
  if (i.mentionUnreadCount) f.push(c.yellow(`@${i.mentionUnreadCount}`));
  if (i.pinned) f.push('pinned');
  if (i.muted) f.push('muted');
  if (i.hidden) f.push('archived');
  return f.join(' ');
}

const preview = (ch, data) => {
  const m = ch.lastMessage;
  if (!m) return '';
  const text = m.messageType === 'deleted' ? '(deleted)' : oneLine(m.text ?? (m.pollId ? '[poll]' : ''), 80);
  return `${nameIn(data, m.userId)}: ${text}`;
};

// Channels: last activity, id, inbox flags, title, the last message.
export function channelLines(channels, data, ctx) {
  const c = paint(ctx);
  return table(
    (channels ?? []).map((ch) => [
      c.dim(localTime(ch.lastActivityAt)),
      ch.channelId,
      flags(ch, c),
      c.bold(oneLine(channelTitle(ch, data), 50)),
      c.dim(preview(ch, data)),
    ]),
  );
}

export function channelDetails(ch, data, ctx) {
  const c = paint(ctx);
  if (!ch) return [];
  const rows = [
    ['Channel', ch.channelId],
    ['Title', c.bold(channelTitle(ch, data))],
    [
      'Type',
      [ch.channelType, ch.access, ch.broadcast && 'broadcast', ch.external && 'external'].filter(Boolean).join(' · '),
    ],
  ];
  if (ch.description) rows.push(['Description', oneLine(ch.description, 300)]);
  if (ch.peerId) rows.push(['With', `${nameIn(data, ch.peerId)} (${ch.peerId})`]);
  rows.push(['Members', String(ch.membersCount ?? '')]);
  rows.push(['Created', `${localTime(ch.createdAt)}${ch.createdBy ? ` by ${nameIn(data, ch.createdBy)}` : ''}`]);
  rows.push(['Last activity', localTime(ch.lastActivityAt)]);
  if (ch.pinnedMessageIds?.length) rows.push(['Pinned', ch.pinnedMessageIds.join(', ')]);
  if (ch.autoRecord !== undefined || ch.autoTranscribe !== undefined) {
    rows.push([
      'Conferences',
      [ch.autoRecord && 'auto record', ch.autoTranscribe && 'auto transcribe'].filter(Boolean).join(', ') || 'manual',
    ]);
  }
  if (ch.inbox) rows.push(['Inbox', flags(ch, c) || 'read']);
  return table(rows);
}

// A person on one line: name, id, e-mail, extension, bot.
export function userLine(u, c) {
  return [
    c.bold(displayName(u) ?? ''),
    u.id,
    u.email ?? '',
    u.pbxExtension ? `ext ${u.pbxExtension}` : '',
    u.bot ? 'bot' : '',
    u.deactivatedAt ? c.dim('deactivated') : '',
  ];
}

export const nextPage = (cursor, c) => (cursor ? [c.dim(`More: --cursor ${cursor}`)] : []);

// The text of a command that changes something: what was done (the JSON output keeps the answer of the service).
export const done = (what) => (r, ctx) => (typeof what === 'function' ? what(r, ctx) : what);
