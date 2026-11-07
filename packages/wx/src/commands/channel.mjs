// wx channel: channels of the Wildix stream service and their members, as the logged-in user (the agent skill's
// channels.sh, members.sh and search.sh channels).
import {UsageError} from 'wldx-core/errors';
import {localTime, paint, table} from 'wldx-core/format';
import {apiPath, query} from 'wldx-core/http';
import {channelId} from '../stream.mjs';
import {channelDetails, channelLines, channelUserIds, done, nextPage} from '../chat/format.mjs';
import {
  CHANNEL_ID,
  NOT_IMPLEMENTED,
  api,
  checkId,
  checkInt,
  nameIn,
  newChannelId,
  notImplemented,
  withNames,
} from '../chat/lib.mjs';

const ACCESS = ['private', 'public'];
const UNSET = [
  'subject',
  'description',
  'picture',
  'pictureColor',
  'access',
  'broadcast',
  'context',
  'contextPtt',
  'contextEvents',
  'whatsappStatus',
  'messagingStatus',
  'kiteAssign',
  'service',
  'serviceTitle',
  'assignee',
  'sms',
  'mms',
  'whatsapp',
];
const SORT = ['relevance', 'recency', 'recency_asc'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(value, what = '--invite') {
  if (!EMAIL.test(String(value))) throw new UsageError(`${what} is not an e-mail address: ${value}`);
  return value;
}

const channelResult = async (ctx, client, r) =>
  withNames(ctx, r, [...channelUserIds(r?.channel), r?.channel?.createdBy], client);
const channelText = (r, ctx) => (r?.channel ? channelDetails(r.channel, r, ctx) : 'No channel.');

const get = {
  summary: 'one channel',
  usage: 'wx channel get <channel>',
  details: 'A channel is an id or an inbox link. A deleted channel can still be read (the deletion is soft).',
  options: {},
  args: [1, 1],
  async run(ctx) {
    const client = api(ctx);
    return channelResult(ctx, client, await client.call('GET', apiPath`/channels/${channelId(ctx.positionals[0])}`));
  },
  text: channelText,
};

const queryCmd = {
  summary: `several channels by id${NOT_IMPLEMENTED}`,
  usage: 'wx channel query <channel>...',
  details: notImplemented('QueryChannels'),
  options: {},
  args: [1, 100],
  async run(ctx) {
    const client = api(ctx);
    const r = await client.call('POST', '/channels/query', {query: {ids: ctx.positionals.map(channelId)}});
    return withNames(ctx, r, (r?.channels ?? []).flatMap(channelUserIds), client);
  },
  text: (r, ctx) => (r?.channels?.length ? channelLines(r.channels, r, ctx) : 'No channels.'),
};

const search = {
  summary: 'search your channels by subject or member',
  usage:
    'wx channel search <query> [--type direct|group] [--member USERID] [--size 1-50] [--cursor C] [--sort relevance|recency|recency_asc]',
  options: {
    type: {type: 'string', choices: ['direct', 'group'], description: 'only 1:1 or group channels'},
    member: {type: 'string', placeholder: 'USERID', description: 'only channels with this member'},
    size: {type: 'string', placeholder: '1-50', description: 'results per page (default 20)'},
    cursor: {type: 'string', description: 'the next page (nextCursor of the previous one)'},
    sort: {type: 'string', choices: SORT, description: 'the order of the results'},
  },
  args: [1, 1],
  async run(ctx) {
    const {values} = ctx;
    const q = query({
      q: ctx.positionals[0],
      channelType: values.type,
      memberId: values.member === undefined ? undefined : checkId('--member', values.member),
      size: checkInt('size', values.size, 1, 50),
      cursor: values.cursor,
      sort: values.sort,
    });
    const client = api(ctx);
    const r = await client.call('GET', `/search/channels${q}`);
    return withNames(
      ctx,
      r,
      (r?.results ?? []).flatMap((x) => channelUserIds(x.channel)),
      client,
    );
  },
  text(r, ctx) {
    const list = (r?.results ?? []).map((x) => x.channel).filter(Boolean);
    if (!list.length) return 'Nothing found.';
    return [...channelLines(list, r, ctx), ...nextPage(r.nextCursor, paint(ctx))];
  },
};

const create = {
  summary: 'create a group channel',
  usage:
    'wx channel create --subject S [--description D] [--access private|public] [--member USERID]... [--invite EMAIL]... [--id 8-4-4-4-8] [--auto-transcribe | --no-auto-transcribe]',
  details: [
    'An id of 8-4-4-4-8 characters is always sent (one is made when --id is not given): without it the service makes',
    'a 36-character id that none of its own calls accepts. --auto-transcribe makes a conference in the channel start',
    'transcription by itself; it can be set only now (update is not implemented by the service yet).',
  ].join('\n'),
  options: {
    subject: {type: 'string', description: 'the name of the channel (required)'},
    description: {type: 'string', description: 'what the channel is for'},
    access: {type: 'string', choices: ACCESS, description: 'who can find and join it'},
    member: {type: 'string', multiple: true, placeholder: 'USERID', description: 'add this user'},
    invite: {type: 'string', multiple: true, placeholder: 'EMAIL', description: 'invite this e-mail address'},
    id: {type: 'string', placeholder: '8-4-4-4-8', description: 'the id of the new channel'},
    'auto-transcribe': {type: 'boolean', description: 'conferences in it start transcription by themselves'},
    'no-auto-transcribe': {type: 'boolean', description: 'they do not'},
  },
  args: [0, 0],
  async run(ctx) {
    const {values} = ctx;
    if (!values.subject) throw new UsageError('--subject is required', ctx.usage());
    if (values['auto-transcribe'] && values['no-auto-transcribe'])
      throw new UsageError('Give --auto-transcribe or --no-auto-transcribe, not both', ctx.usage());
    const id = values.id ?? newChannelId();
    if (!CHANNEL_ID.test(id)) throw new UsageError(`--id must look like 8-4-4-4-8 characters of [0-9a-z_]: ${id}`);
    const body = {channelId: id, subject: values.subject};
    if (values.description) body.description = values.description;
    if (values.access) body.access = values.access;
    if (values['auto-transcribe']) body.autoTranscribe = true;
    if (values['no-auto-transcribe']) body.autoTranscribe = false;
    if (values.member?.length) body.members = values.member.map((u) => checkId('--member', u));
    if (values.invite?.length) body.membersToInvite = values.invite.map((e) => ({email: email(e)}));
    const client = api(ctx);
    return channelResult(ctx, client, await client.call('POST', '/channels/group', body));
  },
  text: (r, ctx) => (r?.channel ? ['Created:', ...channelDetails(r.channel, r, ctx)] : 'Created'),
};

function directBody(values, usage) {
  if (values.user && values.email) throw new UsageError('Give --user or --email, not both', usage);
  if (values.user) return {memberId: checkId('--user', values.user)};
  if (values.email) return {memberToInvite: {email: email(values.email, '--email')}};
  throw new UsageError('--user or --email is required', usage);
}
const DIRECT_OPTIONS = {
  user: {type: 'string', placeholder: 'USERID', description: 'the other person (wx user find gives the id)'},
  email: {type: 'string', placeholder: 'EMAIL', description: 'the other person by e-mail (invited when not a user)'},
};

const direct = {
  summary: 'the 1:1 channel with a person (created when it does not exist yet)',
  usage: 'wx channel direct (--user USERID | --email EMAIL)',
  options: DIRECT_OPTIONS,
  args: [0, 0],
  async run(ctx) {
    const client = api(ctx);
    return channelResult(
      ctx,
      client,
      await client.call('POST', '/channels/direct/get-or-create', directBody(ctx.values, ctx.usage())),
    );
  },
  text: channelText,
};

const directId = {
  summary: 'only the id of the 1:1 channel with a person (nothing is created)',
  usage: 'wx channel direct-id (--user USERID | --email EMAIL)',
  options: DIRECT_OPTIONS,
  args: [0, 0],
  async run(ctx) {
    return api(ctx).call('POST', '/channels/direct/resolve-id', directBody(ctx.values, ctx.usage()));
  },
  text: (r) => r?.channelId ?? '',
};

const update = {
  summary: `change the subject, description or access of a channel${NOT_IMPLEMENTED}`,
  usage: 'wx channel update <channel> [--subject S] [--description D] [--access private|public] [--unset FIELD]...',
  details: notImplemented('PartialUpdateChannel'),
  options: {
    subject: {type: 'string', description: 'the new name'},
    description: {type: 'string', description: 'the new description'},
    access: {type: 'string', choices: ACCESS, description: 'who can find and join it'},
    unset: {type: 'string', multiple: true, choices: UNSET, description: 'clear this field'},
  },
  args: [1, 1],
  async run(ctx) {
    const {values} = ctx;
    const ch = channelId(ctx.positionals[0]);
    const set = {};
    for (const k of ['subject', 'description', 'access']) if (values[k] !== undefined) set[k] = values[k];
    const unset = values.unset ?? [];
    if (!Object.keys(set).length && !unset.length)
      throw new UsageError('Nothing to change: give --subject, --description, --access or --unset', ctx.usage());
    const body = {set};
    if (unset.length) body.unset = unset;
    return api(ctx).call('PATCH', apiPath`/channels/${ch}`, body);
  },
  text: done('Updated'),
};

const simple = (name, summary, method, suffix, {details, body = {}, text} = {}) => ({
  summary,
  usage: `wx channel ${name} <channel>`,
  ...(details ? {details} : {}),
  options: {},
  args: [1, 1],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    return api(ctx).call(method, apiPath`/channels/${ch}` + suffix, body);
  },
  text: done(text),
});

const del = {
  summary: 'delete a channel for everyone (needs --yes)',
  usage: 'wx channel delete <channel> --yes',
  details: 'Removes the channel for every member. Confirm with the person first: --yes is not the confirmation.',
  options: {yes: {type: 'boolean', description: 'yes, delete it for everyone'}},
  args: [1, 1],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    if (!ctx.values.yes)
      throw new UsageError(
        'delete removes the channel for everyone: confirm with the person, then add --yes',
        ctx.usage(),
      );
    return api(ctx).call('DELETE', apiPath`/channels/${ch}`);
  },
  text: done('Deleted'),
};

const members = {
  summary: 'members of a channel',
  usage: 'wx channel members <channel> [--limit 1-100] [--offset 0-1000]',
  options: {
    limit: {type: 'string', placeholder: '1-100', description: 'how many'},
    offset: {type: 'string', placeholder: '0-1000', description: 'skip this many'},
  },
  args: [1, 1],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const q = query({
      limit: checkInt('limit', ctx.values.limit, 1, 100),
      offset: checkInt('offset', ctx.values.offset, 0, 1000),
    });
    const client = api(ctx);
    const r = await client.call('GET', apiPath`/channels/${ch}/members` + q);
    return withNames(
      ctx,
      r,
      (r?.members ?? []).map((m) => m.userId),
      client,
    );
  },
  text(r, ctx) {
    const c = paint(ctx);
    const list = r?.members ?? [];
    if (!list.length) return 'No members.';
    return table(
      list.map((m) => [c.bold(nameIn(r, m.userId)), m.userId, m.role ?? '', c.dim(`joined ${localTime(m.joinedAt)}`)]),
    );
  },
};

const member = {
  summary: `one member of a channel${NOT_IMPLEMENTED}`,
  usage: 'wx channel member <channel> <userId>',
  details: notImplemented('GetChannelMember'),
  options: {},
  args: [2, 2],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const user = checkId('The user id', ctx.positionals[1]);
    const client = api(ctx);
    const r = await client.call('GET', apiPath`/channels/${ch}/members/${user}`);
    return withNames(ctx, r, [r?.member?.userId], client);
  },
  text: (r, ctx) =>
    r?.member
      ? table([
          [
            paint(ctx).bold(nameIn(r, r.member.userId)),
            r.member.userId,
            r.member.role ?? '',
            `joined ${localTime(r.member.joinedAt)}`,
          ],
        ])
      : 'No member.',
};

const add = {
  summary: 'add people to a channel',
  usage: 'wx channel add <channel> (--user USERID | --invite EMAIL)... [--hide-history]',
  options: {
    user: {type: 'string', multiple: true, placeholder: 'USERID', description: 'add this user'},
    invite: {type: 'string', multiple: true, placeholder: 'EMAIL', description: 'invite this e-mail address'},
    'hide-history': {type: 'boolean', description: 'the new members do not see the earlier messages'},
  },
  args: [1, 1],
  async run(ctx) {
    const {values} = ctx;
    const ch = channelId(ctx.positionals[0]);
    const users = values.user ?? [];
    const invites = values.invite ?? [];
    if (!users.length && !invites.length) throw new UsageError('Give --user USERID or --invite EMAIL', ctx.usage());
    const body = {};
    if (users.length) body.members = users.map((u) => checkId('--user', u));
    if (invites.length) body.membersToInvite = invites.map((e) => ({email: email(e)}));
    if (values['hide-history']) body.hideHistory = true;
    return api(ctx).call('PUT', apiPath`/channels/${ch}/members`, body);
  },
  text: done('Added'),
};

const remove = {
  summary: 'remove a person from a channel',
  usage: 'wx channel remove <channel> <userId>',
  options: {},
  args: [2, 2],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const user = checkId('The user id', ctx.positionals[1]);
    return api(ctx).call('DELETE', apiPath`/channels/${ch}/members/${user}`);
  },
  text: done('Removed'),
};

const readStatus = {
  summary: 'who has read a channel up to where (channels with up to 100 members)',
  usage: 'wx channel read-status <channel>',
  options: {},
  args: [1, 1],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const client = api(ctx);
    const r = await client.call('GET', apiPath`/channels/${ch}/read-status`);
    return withNames(
      ctx,
      r,
      (r?.members ?? []).map((m) => m.userId),
      client,
    );
  },
  text(r, ctx) {
    const c = paint(ctx);
    const list = r?.members ?? [];
    if (!list.length) return 'No members.';
    return table(
      list.map((m) => [
        c.bold(nameIn(r, m.userId)),
        m.lastReadVisibleSeq === undefined ? c.dim('nothing read') : `up to #${m.lastReadVisibleSeq}`,
        c.dim(localTime(m.lastReadAt)),
      ]),
    );
  },
};

const channel = {
  summary: 'chat channels: get, search, create, 1:1, update, join, leave, delete, members',
  auth: true,
  commands: {
    get,
    query: queryCmd,
    search,
    create,
    direct,
    'direct-id': directId,
    update,
    join: simple('join', `join a public channel${NOT_IMPLEMENTED}`, 'POST', '/join', {
      details: notImplemented('JoinChannel'),
      text: 'Joined',
    }),
    leave: simple('leave', 'leave a channel', 'POST', '/leave', {text: 'Left'}),
    delete: del,
    members,
    member,
    add,
    remove,
    'read-status': readStatus,
  },
};

export const groups = {channel};
