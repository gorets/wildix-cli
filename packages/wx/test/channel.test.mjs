import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups as channelGroups} from '../src/commands/channel.mjs';
import {groups as inboxGroups} from '../src/commands/inbox.mjs';
import {groups as sectionGroups} from '../src/commands/section.mjs';
import {fakeFetch, fakeJwt, run} from './helpers.mjs';

const API = 'https://eu-1.stream.wildix.com/api/v1';
const CH = 'abcdefgh-ijkl-mnop-qrst-uvwxyz01';
const OTHER = 'otherUser001';
const env = {WILDIX_ID_TOKEN: fakeJwt({email: 'me@example.com'})};
const registry = {groups: {...channelGroups, ...inboxGroups, ...sectionGroups}};
const wx = (argv, options = {}) => run(argv, {env, registry, ...options});

async function call(argv, answer = {body: {}}) {
  const fetch = fakeFetch(answer);
  const r = await wx(argv, {fetch});
  assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
  return fetch.calls[0];
}

const req = (c) => `${c.method} ${c.url.replace(API, '')}`;

test('channel get, query, search', async () => {
  assert.equal(req(await call(['channel', 'get', `https://app.x-bees.com/inbox/${CH}/m1`])), `GET /channels/${CH}`);
  const q = await call(['channel', 'query', CH, `group:${CH}`]);
  assert.equal(req(q), 'POST /channels/query');
  assert.deepEqual(q.body, {query: {ids: [CH, CH]}});
  const s = await call([
    'channel',
    'search',
    'team',
    '--type',
    'group',
    '--member',
    OTHER,
    '--size',
    '3',
    '--cursor',
    'c',
    '--sort',
    'recency_asc',
  ]);
  assert.equal(
    req(s),
    `GET /search/channels?q=team&channelType=group&memberId=${OTHER}&size=3&cursor=c&sort=recency_asc`,
  );
});

test('channel create always sends an 8-4-4-4-8 id and the given fields', async () => {
  const c = await call([
    'channel',
    'create',
    '--subject',
    'Team',
    '--description',
    'D',
    '--access',
    'private',
    '--member',
    OTHER,
    '--invite',
    'a@example.com',
    '--auto-transcribe',
  ]);
  assert.equal(req(c), 'POST /channels/group');
  assert.match(c.body.channelId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}$/);
  const {channelId, ...rest} = c.body;
  assert.deepEqual(rest, {
    subject: 'Team',
    description: 'D',
    access: 'private',
    autoTranscribe: true,
    members: [OTHER],
    membersToInvite: [{email: 'a@example.com'}],
  });

  const given = await call(['channel', 'create', '--subject', 'S', '--id', CH, '--no-auto-transcribe']);
  assert.deepEqual(given.body, {channelId: CH, subject: 'S', autoTranscribe: false});

  for (const argv of [
    ['channel', 'create'],
    ['channel', 'create', '--subject', 'S', '--id', '0123-bad'],
    ['channel', 'create', '--subject', 'S', '--auto-transcribe', '--no-auto-transcribe'],
    ['channel', 'create', '--subject', 'S', '--invite', 'not-an-email'],
    ['channel', 'create', '--subject', 'S', '--access', 'secret'],
  ]) {
    const fetch = fakeFetch();
    assert.equal((await wx(argv, {fetch})).code, 64, argv.join(' '));
    assert.equal(fetch.calls.length, 0);
  }
});

test('channel direct and direct-id by user or e-mail', async () => {
  const d = await call(['channel', 'direct', '--user', OTHER]);
  assert.equal(req(d), 'POST /channels/direct/get-or-create');
  assert.deepEqual(d.body, {memberId: OTHER});
  const i = await call(['channel', 'direct-id', '--email', 'a@example.com'], {body: {channelId: CH}});
  assert.equal(req(i), 'POST /channels/direct/resolve-id');
  assert.deepEqual(i.body, {memberToInvite: {email: 'a@example.com'}});
  assert.equal((await wx(['channel', 'direct'], {fetch: fakeFetch()})).code, 64);
  assert.equal(
    (await wx(['channel', 'direct', '--user', OTHER, '--email', 'a@example.com'], {fetch: fakeFetch()})).code,
    64,
  );
});

test('channel update (not implemented by the service) sends set and unset, never silent', async () => {
  const u = await call(['channel', 'update', CH, '--subject', 'New', '--unset', 'description', '--unset', 'picture']);
  assert.equal(req(u), `PATCH /channels/${CH}`);
  assert.deepEqual(u.body, {set: {subject: 'New'}, unset: ['description', 'picture']});
  assert.equal((await wx(['channel', 'update', CH], {fetch: fakeFetch()})).code, 64);
  assert.equal((await wx(['channel', 'update', CH, '--unset', 'everything'], {fetch: fakeFetch()})).code, 64);
});

test('channel join, leave and delete (--yes)', async () => {
  const j = await call(['channel', 'join', CH]);
  assert.equal(req(j), `POST /channels/${CH}/join`);
  assert.deepEqual(j.body, {});
  assert.equal(req(await call(['channel', 'leave', CH])), `POST /channels/${CH}/leave`);
  const none = fakeFetch();
  const refused = await wx(['channel', 'delete', CH], {fetch: none});
  assert.equal(refused.code, 64);
  assert.match(refused.stderr, /for everyone/);
  assert.equal(none.calls.length, 0);
  assert.equal(req(await call(['channel', 'delete', CH, '--yes'])), `DELETE /channels/${CH}`);
});

test('channel members, member, add, remove, read-status', async () => {
  assert.equal(
    req(await call(['channel', 'members', CH, '--limit', '100', '--offset', '0'])),
    `GET /channels/${CH}/members?limit=100&offset=0`,
  );
  for (const bad of [
    ['--limit', '0'],
    ['--limit', '101'],
    ['--offset', '1001'],
  ])
    assert.equal((await wx(['channel', 'members', CH, ...bad], {fetch: fakeFetch()})).code, 64);
  assert.equal(req(await call(['channel', 'member', CH, OTHER])), `GET /channels/${CH}/members/${OTHER}`);
  const a = await call(['channel', 'add', CH, '--user', OTHER, '--invite', 'a@example.com', '--hide-history']);
  assert.equal(req(a), `PUT /channels/${CH}/members`);
  assert.deepEqual(a.body, {members: [OTHER], membersToInvite: [{email: 'a@example.com'}], hideHistory: true});
  assert.equal((await wx(['channel', 'add', CH], {fetch: fakeFetch()})).code, 64);
  assert.equal(req(await call(['channel', 'remove', CH, OTHER])), `DELETE /channels/${CH}/members/${OTHER}`);
  assert.equal((await wx(['channel', 'remove', CH, '../x'], {fetch: fakeFetch()})).code, 64);
  assert.equal(req(await call(['channel', 'read-status', CH])), `GET /channels/${CH}/read-status`);
});

test('the text of channel get and members uses names', async () => {
  const users = {body: {users: [{id: OTHER, displayName: 'Anna'}]}};
  const channel = {
    channelId: CH,
    channelType: 'direct',
    peerId: OTHER,
    membersCount: 2,
    createdBy: OTHER,
    createdAt: '2026-11-07T10:00:00Z',
    lastActivityAt: '2026-11-07T10:00:00Z',
  };
  let r = await wx(['channel', 'get', CH], {fetch: fakeFetch({body: {channel}}, users), output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Title\s+Anna/);
  assert.match(r.stdout, new RegExp(`With\\s+Anna \\(${OTHER}\\)`));
  r = await wx(['channel', 'members', CH], {
    fetch: fakeFetch({body: {members: [{userId: OTHER, role: 'owner', joinedAt: '2026-11-07T10:00:00Z'}]}}, users),
    output: 'text',
  });
  assert.match(r.stdout, new RegExp(`^Anna\\s+${OTHER}\\s+owner\\s+joined `));
  r = await wx(['channel', 'read-status', CH], {
    fetch: fakeFetch({body: {members: [{userId: OTHER, lastReadVisibleSeq: 7}]}}, users),
    output: 'text',
  });
  assert.match(r.stdout, /^Anna\s+up to #7/);
});

test('not implemented commands say so in their help', async () => {
  for (const name of ['query', 'update', 'join', 'member']) {
    const r = await wx(['channel', name, '--help']);
    assert.match(r.stdout, /not implemented by the service yet/, name);
    assert.match(r.stdout, /Do not retry/, name);
  }
  const help = await wx(['section', '--help']);
  assert.equal((help.stdout.match(/not implemented/g) ?? []).length, 5);
});

test('inbox get, read, unread, mute, unmute, pin, unpin, hide, show', async () => {
  assert.equal(req(await call(['inbox', 'get'])), 'GET /inbox');
  const read = await call(['inbox', 'mark-read', CH, '--message', `https://app.x-bees.com/inbox/${CH}/m9`]);
  assert.equal(req(read), `POST /channels/${CH}/read`);
  assert.deepEqual(read.body, {messageId: 'm9'});
  assert.deepEqual((await call(['inbox', 'mark-read', CH])).body, {});
  const unread = await call(['inbox', 'mark-unread', CH, '--message', 'm9', '--force']);
  assert.equal(req(unread), `PUT /channels/${CH}/unread?force=true`);
  assert.deepEqual(unread.body, {messageId: 'm9'});
  const mute = await call(['inbox', 'mute', CH, '--until', '2026-11-08T09:00:00Z']);
  assert.equal(req(mute), `POST /channels/${CH}/mute`);
  assert.deepEqual(mute.body, {mutedUntil: '2026-11-08T09:00:00Z'});
  assert.equal((await wx(['inbox', 'mute', CH, '--until', 'tomorrow'], {fetch: fakeFetch()})).code, 64);
  assert.equal(req(await call(['inbox', 'unmute', CH])), `DELETE /channels/${CH}/mute`);
  assert.equal(req(await call(['inbox', 'pin', CH])), `POST /channels/${CH}/pin`);
  assert.equal(req(await call(['inbox', 'unpin', CH])), `DELETE /channels/${CH}/pin`);
  assert.equal(req(await call(['inbox', 'hide', CH])), `POST /channels/${CH}/hide`);
  assert.equal(req(await call(['inbox', 'show', CH])), `POST /channels/${CH}/show`);
});

test('the text of inbox get: sections, then channels', async () => {
  const body = {
    sections: [
      {
        sectionId: 'all',
        name: 'All',
        type: 'system',
        channelCount: 3,
        unmutedUnreadMessageCount: 4,
        unmutedUnreadChannelCount: 2,
        unreadMentionCount: 1,
      },
    ],
    channels: [{channelId: CH, channelType: 'group', subject: 'Team', inbox: {unreadCount: 4}}],
  };
  const r = await wx(['inbox', 'get'], {fetch: fakeFetch({body}), output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^All\s+all\s+system\s+3 channels\s+4 new in 2\s+@1$/);
  assert.equal(lines[1], '');
  assert.match(lines[2], /4 new\s+Team/);
});

test('section list comes from the inbox; the others send the section id', async () => {
  const fetch = fakeFetch({body: {sections: [{sectionId: 'work', name: 'Work'}], channels: [{channelId: CH}]}});
  const r = await wx(['section', 'list'], {fetch});
  assert.equal(req(fetch.calls[0]), 'GET /inbox');
  assert.deepEqual(JSON.parse(r.stdout), {sections: [{sectionId: 'work', name: 'Work'}]});
  const c = await call(['section', 'create', 'work', 'Work things']);
  assert.equal(req(c), 'POST /sections');
  assert.deepEqual(c.body, {sectionId: 'work', name: 'Work things'});
  const n = await call(['section', 'rename', 'work', 'Job']);
  assert.equal(req(n), 'PATCH /sections/work');
  assert.deepEqual(n.body, {name: 'Job'});
  assert.equal(req(await call(['section', 'delete', 'work'])), 'DELETE /sections/work');
  assert.equal(req(await call(['section', 'add', CH, 'work'])), `PUT /channels/${CH}/sections/work`);
  assert.equal(req(await call(['section', 'remove', CH, 'work'])), `DELETE /channels/${CH}/sections/work`);
  for (const bad of [
    ['create', 'Work', 'x'],
    ['create', 'work', ''],
    ['delete', 'a/b'],
  ])
    assert.equal((await wx(['section', ...bad], {fetch: fakeFetch()})).code, 64, bad.join(' '));
});
