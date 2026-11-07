import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups} from '../src/commands/chat.mjs';
import {fakeFetch, fakeJwt, run} from './helpers.mjs';

const API = 'https://eu-1.stream.wildix.com/api/v1';
const CH = 'abcdefgh-ijkl-mnop-qrst-uvwxyz01';
const ME = 'meUserId0001';
const OTHER = 'otherUser001';
const env = {WILDIX_ID_TOKEN: fakeJwt({email: 'me@example.com', exp: 4102444800})};
const registry = {groups};
const wx = (argv, options = {}) => run(argv, {env, registry, ...options});
const meAnswer = {body: {users: [{id: ME, displayName: 'Me Myself', bot: false}]}};

test('chat list, read and send keep their released requests', async () => {
  let fetch = fakeFetch({body: {channels: []}});
  let r = await wx(['chat', 'list', '--filter', 'archived', '--section', 'work', '--cursor', 'c1'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${API}/channels?filter=archived&section=work&cursor=c1`);

  fetch = fakeFetch({body: {messages: []}});
  r = await wx(['chat', 'read', CH, '--from', '10', '--to', '20'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${API}/channels/${CH}/messages?from=10&to=20`);

  fetch = fakeFetch({body: {message: {messageId: 'm1'}}});
  r = await wx(['chat', 'send', `https://app.x-bees.com/inbox/${CH}`, 'hello', '--mention', OTHER, '--mention', ME], {
    fetch,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${API}/channels/${CH}/messages`);
  assert.deepEqual(fetch.calls[0].body, {text: 'hello', mentions: [OTHER, ME]});
});

test('chat send refuses an empty text and never sends silent', async () => {
  const fetch = fakeFetch();
  const r = await wx(['chat', 'send', CH, ' '], {fetch});
  assert.equal(r.code, 64);
  assert.equal(fetch.calls.length, 0);
  const ok = fakeFetch({body: {}});
  await wx(['chat', 'send', CH, 'x', '--markdown'], {fetch: ok});
  assert.equal('silent' in ok.calls[0].body, false);
});

test('chat read --to refuses a number out of range', async () => {
  const r = await wx(['chat', 'read', CH, '--to', '1000000000000'], {fetch: fakeFetch()});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--to must be a whole number from 0 to 999999999999/);
});

test('chat get takes a message link', async () => {
  const fetch = fakeFetch({body: {message: {messageId: 'm1'}}});
  const r = await wx(['chat', 'get', CH, `https://app.x-bees.com/inbox/${CH}/m1`], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, `${API}/channels/${CH}/messages/m1`);
});

test('chat edit checks the owner, then PUTs the new text with what the message has', async () => {
  const message = {
    messageId: 'm1',
    userId: ME,
    text: 'old',
    mentions: [OTHER],
    markdown: false,
    silent: true,
    attachments: [{fsId: 'f1', id: 'a1', name: 'a.png', size: 3, mime: 'image/png', width: 1, height: 1}],
    quote: {channelId: CH, messageId: 'm0', userId: OTHER, text: 'q', createdAt: 'x'},
  };
  const fetch = fakeFetch({body: {message}}, meAnswer, {body: {message: {...message, text: 'new'}}});
  const r = await wx(['chat', 'edit', CH, 'm1', 'new', '--markdown'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    fetch.calls.map((c) => `${c.method} ${c.url}`),
    [`GET ${API}/channels/${CH}/messages/m1`, `POST ${API}/users/query`, `PUT ${API}/channels/${CH}/messages/m1`],
  );
  assert.deepEqual(fetch.calls[1].body, {query: {emails: ['me@example.com']}});
  assert.deepEqual(fetch.calls[2].body, {
    text: 'new',
    mentions: [OTHER],
    attachments: [{fsId: 'f1', name: 'a.png', size: 3, mime: 'image/png', width: 1, height: 1}],
    quote: {channelId: CH, messageId: 'm0'},
    markdown: true,
  });
});

test('chat edit and delete stop with exit 2 on a message of someone else', async () => {
  for (const argv of [
    ['chat', 'edit', CH, 'm1', 'new'],
    ['chat', 'delete', CH, 'm1', '--yes'],
  ]) {
    const fetch = fakeFetch({body: {message: {messageId: 'm1', userId: OTHER}}}, meAnswer);
    const r = await wx(argv, {fetch});
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /not yours/);
    assert.equal(fetch.calls.length, 2);
  }
});

test('chat delete needs --yes, then deletes your own message', async () => {
  const none = fakeFetch();
  const refused = await wx(['chat', 'delete', CH, 'm1'], {fetch: none});
  assert.equal(refused.code, 64);
  assert.equal(none.calls.length, 0);
  const fetch = fakeFetch({body: {message: {messageId: 'm1', userId: ME}}}, meAnswer, {body: {}});
  const r = await wx(['chat', 'delete', CH, 'm1', '--yes'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[2].method, 'DELETE');
  assert.equal(fetch.calls[2].url, `${API}/channels/${CH}/messages/m1`);
});

test('chat pin, unpin, react and unreact', async () => {
  const cases = [
    [['pin', CH, 'm1'], 'PUT', `/channels/${CH}/messages/m1/pin`],
    [['unpin', CH, 'm1'], 'DELETE', `/channels/${CH}/messages/m1/pin`],
    [['react', CH, 'm1', 'white_check_mark'], 'PUT', `/channels/${CH}/messages/m1/reactions/white_check_mark`],
    [['unreact', CH, 'm1', '+1'], 'DELETE', `/channels/${CH}/messages/m1/reactions/%2B1`],
  ];
  for (const [args, method, path] of cases) {
    const fetch = fakeFetch({body: {}});
    const r = await wx(['chat', ...args], {fetch});
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fetch.calls[0].method, method);
    assert.equal(fetch.calls[0].url, API + path);
    assert.equal(fetch.calls[0].body, undefined);
  }
  const bad = await wx(['chat', 'react', CH, 'm1', 'Thumbs Up'], {fetch: fakeFetch()});
  assert.equal(bad.code, 64);
});

test('chat reactions queries who reacted; --users adds name, e-mail and bot', async () => {
  const reactions = {reactions: [{messageId: 'm1', type: 'heart', userId: OTHER}]};
  let fetch = fakeFetch({body: reactions});
  let r = await wx(['chat', 'reactions', CH, 'm1', '--type', 'heart'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${API}/channels/${CH}/reactions/query`);
  assert.deepEqual(fetch.calls[0].body, {messageIds: ['m1'], type: 'heart'});
  assert.deepEqual(JSON.parse(r.stdout), reactions);

  fetch = fakeFetch(
    {body: reactions},
    {body: {users: [{id: OTHER, displayName: 'Anna', email: 'anna@example.com', bot: false, phone: '+1'}]}},
  );
  r = await wx(['chat', 'reactions', CH, 'm1', '--users'], {fetch});
  assert.deepEqual(fetch.calls[1].body, {query: {ids: [OTHER]}});
  assert.deepEqual(JSON.parse(r.stdout).reactions[0].user, {name: 'Anna', email: 'anna@example.com', bot: false});
});

test('chat mentions and search', async () => {
  let fetch = fakeFetch({body: {mentions: []}});
  let r = await wx(['chat', 'mentions', '--unread', '--cursor', 'c'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${API}/mentions?filter=unread&cursor=c`);

  fetch = fakeFetch({body: {results: []}});
  r = await wx(
    [
      'chat',
      'search',
      'a b',
      '--channel',
      CH,
      '--sender',
      OTHER,
      '--sender',
      ME,
      '--attachments',
      '--links',
      '--size',
      '5',
      '--sort',
      'recency',
    ],
    {fetch},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    fetch.calls[0].url,
    `${API}/search/messages?q=a+b&channelId=${CH}&hasAttachments=true&hasLinks=true&size=5&sort=recency&senderIds=${OTHER}&senderIds=${ME}`,
  );
  for (const size of ['0', '51', 'x'])
    assert.equal((await wx(['chat', 'search', 'q', '--size', size], {fetch: fakeFetch()})).code, 64);
});

test('the text of chat read: oldest first, names from one users query, the next page', async () => {
  const messages = Array.from({length: 30}, (_, i) => ({
    messageId: `m${i}`,
    userId: i % 2 ? OTHER : ME,
    text: `text ${30 - i}`,
    timelineSeq: 130 - i,
    createdAt: '2026-11-07T10:00:00Z',
    reactionCounts: {},
    attachments: [],
  }));
  messages[0].reactionCounts = {thumbsup: 2};
  messages[1].attachments = [{name: 'a.pdf'}];
  messages[2].messageType = 'deleted';
  const fetch = fakeFetch(
    {body: {messages}},
    {
      body: {
        users: [
          {id: ME, displayName: 'Me Myself'},
          {id: OTHER, displayName: 'Anna'},
        ],
      },
    },
  );
  const r = await wx(['chat', 'read', CH], {fetch, output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[1].body.query.ids.sort(), [ME, OTHER].sort());
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /Me Myself|Anna/);
  assert.match(lines[0], /text 1 /);
  assert.match(lines[29], /text 30 \[thumbsup 2\]/);
  assert.match(lines[28], /\[file: a\.pdf\]/);
  assert.match(lines[27], /\(deleted\)/);
  assert.equal(lines[30], 'Older: --to 100');
});

test('the text of chat list: titles, unread, the author of the last message; JSON stays the service data', async () => {
  const channels = [
    {
      channelId: CH,
      channelType: 'direct',
      peerId: OTHER,
      lastActivityAt: '2026-11-07T10:00:00Z',
      inbox: {unreadCount: 2},
      lastMessage: {userId: OTHER, text: 'hi', messageType: 'regular'},
    },
    {
      channelId: 'c2',
      channelType: 'group',
      subject: 'Team',
      lastActivityAt: '2026-11-07T09:00:00Z',
      inbox: {unreadCount: 0, muted: true},
    },
  ];
  const fetch = fakeFetch({body: {channels, nextCursor: 'n1'}}, {body: {users: [{id: OTHER, displayName: 'Anna'}]}});
  const r = await wx(['chat', 'list'], {fetch, output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], new RegExp(`${CH}\\s+2 new\\s+Anna\\s+Anna: hi`));
  assert.match(lines[1], /c2\s+muted\s+Team/);
  assert.equal(lines[2], 'More: --cursor n1');

  const json = await wx(['chat', 'list'], {fetch: fakeFetch({body: {channels, nextCursor: 'n1'}})});
  assert.deepEqual(JSON.parse(json.stdout), {channels, nextCursor: 'n1'});
});

test('the text of chat get, reactions, mentions and search', async () => {
  const users = {body: {users: [{id: OTHER, displayName: 'Anna'}]}};
  const message = {
    messageId: 'm1',
    userId: OTHER,
    text: 'line 1\nline 2',
    timelineSeq: 5,
    createdAt: '2026-11-07T10:00:00Z',
    attachments: [],
    mentions: [],
    reactionCounts: {heart: 1},
  };
  let r = await wx(['chat', 'get', CH, 'm1'], {fetch: fakeFetch({body: {message}}, users), output: 'text'});
  assert.match(r.stdout, /From\s+Anna/);
  assert.match(r.stdout, /Reactions\s+heart 1/);
  assert.match(r.stdout, /\n\nline 1\nline 2\n$/);

  r = await wx(['chat', 'reactions', CH, 'm1'], {
    fetch: fakeFetch({body: {reactions: [{messageId: 'm1', type: 'heart', userId: OTHER}]}}, users),
    output: 'text',
  });
  assert.equal(r.stdout, 'heart  1  Anna\n');

  r = await wx(['chat', 'mentions'], {
    fetch: fakeFetch(
      {body: {mentions: [{channelId: CH, messageId: 'm1', read: false, message, channel: {subject: 'Team'}}]}},
      users,
    ),
    output: 'text',
  });
  assert.match(r.stdout, /new\s+Team\s+Anna: line 1 line 2 \[heart 1\]/);

  r = await wx(['chat', 'search', 'line'], {
    fetch: fakeFetch({body: {results: [{channelId: CH, message}], totalCount: 7}}, users),
    output: 'text',
  });
  assert.match(r.stdout, /Anna\s+line 1 line 2/);
  assert.match(r.stdout, /1 of 7/);
});

test('names are a nicety: a failed users query prints the ids', async () => {
  const fetch = fakeFetch(
    {body: {messages: [{messageId: 'm1', userId: OTHER, text: 'x', timelineSeq: 1}]}},
    {status: 500, body: {}},
  );
  const r = await wx(['chat', 'read', CH], {fetch, output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${OTHER}: x|${OTHER}\\s+x`));
});
