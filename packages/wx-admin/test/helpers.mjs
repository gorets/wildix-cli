import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {main} from '../src/cli.mjs';

export function sink() {
  return {
    isTTY: false,
    text: '',
    write(s) {
      this.text += s;
      return true;
    },
  };
}

// A JWT-shaped token with the given claims (not signed: only the claims are read).
export function fakeJwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({alg: 'none'})}.${part(claims)}.sig`;
}

export function tempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-test-'));
}

// fetch that records the calls and answers with the given responses in order.
export function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body)});
    const r = responses.shift() ?? {status: 200, body: {}};
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {status: r.status ?? 200});
  };
  fn.calls = calls;
  return fn;
}

const SPECIAL = new Set(['__complete', 'completion']);

// Runs wx-admin in-process. JSON output unless `output: 'text'` (or the arguments name an output themselves). `registry`
// replaces the commands: {groups: {name: group}, commands: {name: command}} (to test a group before it is listed
// in src/commands/index.mjs). `tty: true` makes stdin a terminal; `stdin` is its text, or a terminal() below.
export async function run(
  argv,
  {
    env = {},
    fetch,
    stdin = '',
    tty = false,
    now = () => Date.UTC(2026, 10, 7, 12),
    output = 'json',
    registry,
    signal,
  } = {},
) {
  const stdout = sink();
  const stderr = sink();
  const input = typeof stdin === 'string' ? Readable.from([Buffer.from(stdin)]) : stdin;
  if (tty && typeof stdin === 'string') input.isTTY = true;
  const args =
    SPECIAL.has(argv[0]) || argv.some((a) => a === '--output' || a.startsWith('--output='))
      ? argv
      : ['--output', output, ...argv];
  const io = {stdout, stderr, env, fetch, now, stdin: input, cwd: os.tmpdir()};
  if (registry) io.registry = {groups: {}, commands: {}, ...registry};
  if (signal) io.signal = signal;
  const code = await main(args, io);
  return {code, stdout: stdout.text, stderr: stderr.text};
}

// Cognito answers in the order given; each call is recorded with its target (x-amz-target without the prefix).
export function fakeCognito(...answers) {
  const fetch = fakeFetch(...answers);
  const wrapped = async (url, init) => fetch(url, init);
  wrapped.calls = fetch.calls;
  wrapped.targets = () =>
    fetch.calls.map((c) => c.headers['x-amz-target'].replace('AWSCognitoIdentityProviderService.', ''));
  return wrapped;
}

// A terminal in raw mode: each resume() (a prompt or a menu starting to listen) types the next group of keys.
export function terminal(...groups) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (on) => input.raw.push(on);
  input.setEncoding = () => {};
  input.pause = () => {};
  input.resume = () => {
    const keys = groups.shift() ?? [];
    let i = 0;
    const next = () => {
      if (i < keys.length && input.listenerCount('data')) {
        input.emit('data', keys[i++]);
        setImmediate(next);
      }
    };
    setImmediate(next);
  };
  return input;
}
