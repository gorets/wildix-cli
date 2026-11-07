import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VERSION} from '../src/version.mjs';
import {fakeFetch, run} from './helpers.mjs';

const env = {WILDIX_ID_TOKEN: 'test-token'};

test('--version prints the version of the package', async () => {
  const r = await run(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), VERSION);
});

test('no arguments prints the usage and exits 0', async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: wx <command>/);
  assert.match(r.stdout, /chat/);
});

test('an unknown command exits 64 with the usage', async () => {
  const r = await run(['nope']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Unknown command: nope/);
});

test('a group without a command exits 64', async () => {
  const r = await run(['chat']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /wx chat list/);
});

test('an unknown option exits 64', async () => {
  const r = await run(['chat', 'list', '--bogus'], {env});
  assert.equal(r.code, 64);
});

test('a missing argument exits 64', async () => {
  const r = await run(['chat', 'send', 'abc'], {env});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Missing arguments/);
});

test('wx chat list calls GET /channels with the filter and the token', async () => {
  const fetch = fakeFetch({body: {channels: []}});
  const r = await run(['chat', 'list', '--filter', 'unread'], {env, fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {channels: []});
  const [call] = fetch.calls;
  assert.equal(call.url, 'https://eu-1.stream.wildix.com/api/v1/channels?filter=unread');
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.authorization, 'Bearer test-token');
  assert.equal(call.redirect, 'error');
});

test('wx chat list refuses an unknown filter', async () => {
  const r = await run(['chat', 'list', '--filter', 'all'], {env, fetch: fakeFetch()});
  assert.equal(r.code, 64);
});

test('wx chat read takes an inbox link and the unread anchor', async () => {
  const fetch = fakeFetch({body: {messages: []}});
  const r = await run(['chat', 'read', 'https://app.x-bees.com/inbox/abc-1/msg-2?x=1', '--unread'], {env, fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, 'https://eu-1.stream.wildix.com/api/v1/channels/abc-1/messages?anchor=firstUnread');
});

test('wx chat read refuses a sequence that is not a number', async () => {
  const r = await run(['chat', 'read', 'abc', '--from', '-1'], {env, fetch: fakeFetch()});
  assert.equal(r.code, 64);
});

test('wx chat send posts the text, markdown and the quote', async () => {
  const fetch = fakeFetch({body: {message: {id: 'm1'}}});
  const r = await run(['chat', 'send', 'abc', 'hello', '--markdown', '--reply-to', 'm0'], {env, fetch});
  assert.equal(r.code, 0, r.stderr);
  const [call] = fetch.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://eu-1.stream.wildix.com/api/v1/channels/abc/messages');
  assert.deepEqual(call.body, {text: 'hello', markdown: true, quote: {channelId: 'abc', messageId: 'm0'}});
});

test('wx chat send - reads the text from stdin', async () => {
  const fetch = fakeFetch({body: {}});
  const r = await run(['chat', 'send', 'abc', '-'], {env, fetch, stdin: 'from stdin\n'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].body.text, 'from stdin\n');
});

test('wx chat send refuses an empty text without a request', async () => {
  const fetch = fakeFetch();
  const r = await run(['chat', 'send', 'abc', '-'], {env, fetch, stdin: '  '});
  assert.equal(r.code, 64);
  assert.equal(fetch.calls.length, 0);
});

test('an HTTP error exits 1 and names the status', async () => {
  const fetch = fakeFetch({status: 401, body: {message: 'Unauthorized'}});
  const r = await run(['chat', 'list'], {env, fetch});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP 401 from the stream service \(GET \/api\/v1\/channels\)/);
  assert.match(r.stderr, /log in again/);
  assert.doesNotMatch(r.stderr, /test-token/);
});

test('a stream address outside wildix.com is refused before any request', async () => {
  const fetch = fakeFetch();
  const r = await run(['chat', 'list'], {env: {...env, WILDIX_STREAM_URL: 'https://evil.example'}, fetch});
  assert.equal(r.code, 64);
  assert.equal(fetch.calls.length, 0);
});

test('not logged in exits 2', async () => {
  const r = await run(['chat', 'list'], {env: {WILDIX_CONFIG_DIR: '/nonexistent-wx-test'}, fetch: fakeFetch()});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Not logged in/);
});

test('--output, --pretty and --no-color stand anywhere; text is the default', async () => {
  const fetch = () => fakeFetch({body: {channels: [], nextCursor: 'c'}});
  const before = await run(['--output', 'json', '--pretty', 'chat', 'list'], {env, fetch: fetch()});
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stdout, /^{\n {2}"channels": \[\],/);
  const after = await run(['chat', 'list', '--output=json'], {env, fetch: fetch()});
  assert.equal(after.stdout.trim(), '{"channels":[],"nextCursor":"c"}');
  const text = await run(['chat', 'list', '--no-color'], {env, fetch: fetch(), output: 'text'});
  assert.equal(text.code, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /^{/);
  assert.equal((await run(['--output', 'yaml', 'status'])).code, 64);
});

test('a group can be tested before it is listed, through the registry option', async () => {
  const group = {
    summary: 'test',
    commands: {
      hello: {
        summary: 's',
        usage: 'wx t hello',
        options: {},
        args: [0, 0],
        run: () => ({hi: 1}),
        text: () => 'hi there',
      },
    },
  };
  const r = await run(['t', 'hello'], {registry: {groups: {t: group}}, output: 'text'});
  assert.equal(r.stdout, 'hi there\n');
});

test('a streaming command emits one line per event and stops on the signal', async () => {
  const controller = new AbortController();
  const cmd = {
    summary: 's',
    usage: 'wx w',
    options: {},
    args: [0, 0],
    async run(ctx) {
      ctx.emit({n: 1});
      ctx.emit({n: 2});
      controller.abort();
      assert.ok(ctx.signal.aborted);
    },
    textEvent: (e) => `event ${e.n}`,
  };
  const json = await run(['w'], {registry: {commands: {w: cmd}}, signal: controller.signal});
  assert.equal(json.stdout, '{"n":1}\n{"n":2}\n');
  const text = await run(['w'], {registry: {commands: {w: cmd}}, signal: new AbortController().signal, output: 'text'});
  assert.equal(text.stdout, 'event 1\nevent 2\n');
});

test('control sequences of fetched text never reach the terminal; JSON escapes them', async () => {
  const evil = 'hi\x1b]52;c;ZXZpbA==\x07\x1b[2K\rFAKE\x1b[8mhidden\x9b31m\u0007 end';
  const cmd = {
    summary: 's',
    usage: 'wx e',
    options: {},
    args: [0, 0],
    run: () => ({text: evil}),
    text: (r) => `${r.text} \x1b[1mbold\x1b[22m`,
  };
  const text = await run(['e'], {registry: {commands: {e: cmd}}, output: 'text'});
  assert.equal(text.stdout, 'hi]52;c;ZXZpbA==[2KFAKEhidden31m end \x1b[1mbold\x1b[22m\n');
  const json = await run(['e'], {registry: {commands: {e: cmd}}});
  assert.equal(JSON.parse(json.stdout).text, evil);
  assert.doesNotMatch(json.stdout, /\x1b/);
  const failing = {
    ...cmd,
    run: () => {
      throw new Error(`bad \x1b]52;c;x\x07 answer`);
    },
  };
  assert.equal((await run(['e'], {registry: {commands: {e: failing}}})).stderr, 'wx: bad ]52;c;x answer\n');
});

test('clean(): a NUL in the input cannot forge a kept color code', async () => {
  const {clean} = await import('wldx-core/format');
  assert.equal(clean('a\u00008\u0000b\x1b[8mc\x1b[31md\x1b[39m'), 'a8bc\x1b[31md\x1b[39m');
  assert.equal(clean('tab\tand\nnewline\r\n'), 'tab\tand\nnewline\n');
});

test('--profile picks the account anywhere on the command line', async () => {
  const {saveTokens, stamp, tokenFile} = await import('wldx-core/auth');
  const {fakeJwt, tempConfigDir} = await import('./helpers.mjs');
  const env2 = {WILDIX_CONFIG_DIR: tempConfigDir()};
  for (const email of ['a@example.com', 'second.account@my.dev']) {
    saveTokens(tokenFile(email, env2), {
      IdToken: fakeJwt({email, exp: Date.UTC(2026, 10, 8) / 1000}),
      RefreshToken: 'r',
      ExpiresIn: 3600,
      email,
      savedAt: stamp(0),
    });
  }
  const who = async (argv) => JSON.parse((await run(argv, {env: env2})).stdout).user?.email;
  assert.equal(await who(['--profile', 'second.account@my.dev', 'status']), 'second.account@my.dev');
  assert.equal(await who(['status', '--profile=a@example.com']), 'a@example.com');
  assert.equal(await who(['--profile', 'SECOND.account@my.dev', 'status']), 'second.account@my.dev');
  assert.match(JSON.parse((await run(['status'], {env: env2})).stdout).problem, /none is the default.*wx profile use/s);
  assert.equal(
    (await run(['--profile', 'a@example.com', '--profile', 'second.account@my.dev', 'status'], {env: env2})).code,
    64,
  );
  assert.equal((await run(['status', '--profile'], {env: env2})).code, 64);
  assert.equal((await run(['status', '--account', 'a@example.com'], {env: env2})).code, 64);
});
