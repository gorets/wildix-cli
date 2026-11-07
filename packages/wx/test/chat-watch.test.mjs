import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {groups} from '../src/commands/chat.mjs';
import {fakeFetch, fakeJwt, run} from './helpers.mjs';

const CH = 'abcdefgh-ijkl-mnop-qrst-uvwxyz01';
const ME = 'meUserId0001';
const OTHER = 'otherUser001';
const NOW = Date.UTC(2026, 10, 7, 12);
const TOKEN = fakeJwt({email: 'me@example.com', exp: NOW / 1000 + 3600});
const registry = {groups};
const meAnswer = {body: {users: [{id: ME, displayName: 'Me Myself'}]}};

// A websocket of the service: opens, answers a subscription, then runs the scenario of the test.
class FakeWS {
  static instances = [];
  static scenario = () => {};
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.n = FakeWS.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data) {
    const d = JSON.parse(data);
    this.sent.push(d);
    if (d.action === 'subscribe' && this.sent.length === 1) {
      setTimeout(() => {
        this.deliver({event: 'subscribed'});
        FakeWS.scenario(this);
      }, 0);
    }
  }
  deliver(obj) {
    this.onmessage?.({data: JSON.stringify(obj)});
  }
  broadcast(data) {
    this.deliver({event: 'broadcast', data});
  }
  close() {
    this.closed = true;
  }
  drop(code = 1006) {
    this.onclose?.({code});
  }
}

let saved;
beforeEach(() => {
  saved = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  FakeWS.instances = [];
  FakeWS.scenario = () => {};
});
afterEach(() => {
  globalThis.WebSocket = saved;
});

const lines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const message = (userId, text) => ({
  eventType: 'message.new',
  channelId: CH,
  messageId: 'm1',
  timelineSeq: 5,
  message: {userId, text, attachments: [{name: 'a.png', mime: 'image/png', fsId: 'x'}], mentions: []},
  inboxChannel: {subject: 'Team', channelType: 'group'},
  sectionCounters: {all: {unmutedUnreadMessageCount: 2}, work: {unmutedUnreadMessageCount: 1}},
});

test('watch subscribes, filters out your own messages and reading, and stops after --count events', async () => {
  FakeWS.scenario = (ws) => {
    ws.broadcast(message(ME, 'mine'));
    ws.broadcast({eventType: 'read.cursor.updated', channelId: CH, readerUserId: ME});
    ws.broadcast(message(OTHER, 'hello'));
    ws.broadcast({
      eventType: 'reaction.new',
      channelId: CH,
      messageId: 'm0',
      message: {userId: ME, reactionCounts: {heart: 1}},
    });
    ws.broadcast({eventType: 'typing.start', channelId: CH, typingUserId: OTHER});
  };
  const fetch = fakeFetch(meAnswer, {body: {users: [{id: OTHER, displayName: 'Anna'}]}}, meAnswer);
  const r = await run(['chat', 'watch', '--count', '2'], {
    env: {WILDIX_ID_TOKEN: TOKEN},
    registry,
    fetch,
    now: () => NOW,
  });
  assert.equal(r.code, 0, r.stderr);
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, `wss://eu-1-ws.stream.wildix.com/?access_token=${encodeURIComponent(TOKEN)}`);
  assert.deepEqual(ws.sent[0], {action: 'subscribe', version: '2', topic: 'chat'});
  assert.ok(ws.closed);
  assert.deepEqual(lines(r.stdout), [
    {event: 'READY', user: ME},
    {
      event: 'message.new',
      channelId: CH,
      channel: 'Team',
      channelType: 'group',
      messageId: 'm1',
      seq: 5,
      from: {id: OTHER, name: 'Anna'},
      text: 'hello',
      attachments: [{name: 'a.png', mime: 'image/png'}],
      unread: 3,
    },
    {
      event: 'reaction.new',
      channelId: CH,
      messageId: 'm0',
      messageAuthor: {id: ME, name: 'Me Myself'},
      reactions: {heart: 1},
    },
    {event: 'END', reason: 'stopped'},
  ]);
  assert.deepEqual(fetch.calls[0].body, {query: {emails: ['me@example.com']}});
  assert.deepEqual(fetch.calls[1].body, {query: {ids: [OTHER]}});
});

test('watch --channel, --from and --type keep only what was asked; --from leaves reactions out', async () => {
  FakeWS.scenario = (ws) => {
    ws.broadcast({...message(OTHER, 'elsewhere'), channelId: 'other-channel'});
    ws.broadcast({eventType: 'reaction.new', channelId: CH, message: {userId: OTHER}});
    ws.broadcast({eventType: 'typing.start', channelId: CH, typingUserId: OTHER});
    ws.broadcast(message('someoneElse1', 'not from'));
    ws.broadcast(message(OTHER, 'yes'));
  };
  const fetch = fakeFetch(meAnswer, {body: {users: [{id: OTHER, displayName: 'Anna'}]}});
  const r = await run(
    [
      'chat',
      'watch',
      '--channel',
      `https://app.x-bees.com/inbox/${CH}`,
      '--from',
      OTHER,
      '--type',
      'messages',
      '--type',
      'reaction.new',
      '--count',
      '1',
      '--raw',
    ],
    {env: {WILDIX_ID_TOKEN: TOKEN}, registry, fetch, now: () => NOW},
  );
  assert.equal(r.code, 0, r.stderr);
  const out = lines(r.stdout);
  assert.deepEqual(out[0], {
    event: 'READY',
    user: ME,
    channels: [CH],
    from: [OTHER],
    types: ['message.new', 'message.updated', 'message.deleted', 'reaction.new'],
  });
  assert.equal(out[1].event, 'message.new');
  assert.equal(out[1].message.text, 'yes');
  assert.ok(out[1].inboxChannel, '--raw keeps the event as the service sends it');
  assert.equal(out.length, 3);
});

test('watch reconnects with a fresh token after a drop, and stops on the signal', async () => {
  const controller = new AbortController();
  FakeWS.scenario = (ws) => {
    if (ws.n === 1) setTimeout(() => ws.drop(1006), 0);
    else setTimeout(() => controller.abort(), 0);
  };
  const r = await run(['chat', 'watch'], {
    env: {WILDIX_ID_TOKEN: TOKEN},
    registry,
    fetch: fakeFetch(meAnswer),
    now: () => NOW,
    signal: controller.signal,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(FakeWS.instances.length, 2);
  assert.deepEqual(lines(r.stdout), [
    {event: 'READY', user: ME},
    {event: 'RECONNECTING', code: 1006, attempt: 1, inSeconds: 1},
    {event: 'RECONNECTED', user: ME},
    {event: 'END', reason: 'stopped'},
  ]);
});

test('watch renews the login at once when the token is about to end', async () => {
  const controller = new AbortController();
  const ending = fakeJwt({email: 'me@example.com', exp: NOW / 1000 + 60});
  FakeWS.scenario = (ws) => {
    if (ws.n === 1) setTimeout(() => ws.drop(1001), 0);
    else setTimeout(() => controller.abort(), 0);
  };
  const r = await run(['chat', 'watch', '--output', 'text', '--no-color'], {
    env: {WILDIX_ID_TOKEN: ending},
    registry,
    fetch: fakeFetch(meAnswer),
    now: () => NOW,
    signal: controller.signal,
  });
  assert.equal(r.code, 0, r.stderr);
  const text = r.stdout
    .trim()
    .split('\n')
    .map((l) => l.replace(/^\S+ \S+ {2}/, ''));
  assert.deepEqual(text, [
    'watching the chats. Ctrl-C stops.',
    'reconnecting (renewing the login)',
    'reconnected (events of the pause are not sent again)',
    'stopped',
  ]);
});

test('an expired token that cannot be renewed reconnects at once only once, then waits (no tight loop)', async () => {
  const controller = new AbortController();
  const expired = fakeJwt({email: 'me@example.com', exp: NOW / 1000 - 10});
  FakeWS.scenario = (ws) => {
    if (ws.n <= 2) setTimeout(() => ws.drop(1006), 0);
    else setTimeout(() => controller.abort(), 0);
  };
  setTimeout(() => controller.abort(), 300); // the second reconnection waits 1 s: the test stops it before
  const r = await run(['chat', 'watch'], {
    env: {WILDIX_ID_TOKEN: expired},
    registry,
    fetch: fakeFetch(meAnswer),
    now: () => NOW,
    signal: controller.signal,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(FakeWS.instances.length, 2);
  const events = lines(r.stdout).map(
    (e) => e.event + (e.reason ? `:${e.reason}` : '') + (e.attempt ? `:${e.attempt}` : ''),
  );
  assert.deepEqual(events, ['READY', 'RECONNECTING:token', 'RECONNECTED', 'RECONNECTING:1', 'END:stopped']);
});

test('watch --for stops after the time; the text shows one line per event', async () => {
  FakeWS.scenario = (ws) => ws.broadcast(message(OTHER, 'hi\nthere'));
  const fetch = fakeFetch(meAnswer, {body: {users: [{id: OTHER, displayName: 'Anna'}]}});
  const r = await run(['chat', 'watch', '--for', '1', '--no-color'], {
    env: {WILDIX_ID_TOKEN: TOKEN},
    registry,
    fetch,
    now: () => NOW,
    output: 'text',
  });
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, 3);
  assert.match(out[1], /message\.new\s+Team {2}Anna: hi there \[file: a\.png\]$/);
  assert.match(out[2], /stopped$/);
});

test('watch refuses an unknown type and limits out of range', async () => {
  for (const argv of [
    ['--type', 'everything'],
    ['--count', '0'],
    ['--for', '604801'],
    ['--from', 'a/b'],
  ]) {
    const fetch = fakeFetch();
    const r = await run(['chat', 'watch', ...argv], {env: {WILDIX_ID_TOKEN: TOKEN}, registry, fetch});
    assert.equal(r.code, 64, argv.join(' '));
    assert.equal(FakeWS.instances.length, 0);
  }
});
