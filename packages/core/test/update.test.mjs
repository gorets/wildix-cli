import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {createMain} from '../src/cli.mjs';
import {isNewer} from '../src/update.mjs';
import {tempConfigDir} from './helpers.mjs';

// The helpers set the program: wx, wldx-cli, 9.9.9 — tests here run as version 1.2.0 of it.
import {program, setProgram} from '../src/program.mjs';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 8, 12);
const hello = {summary: 's', usage: 'wx hello', options: {}, args: [0, 0], run: () => 'hi'};
const main = createMain({groups: {}, commands: {hello}});
const tty = () => ({
  isTTY: true,
  text: '',
  write(s) {
    this.text += s;
    return true;
  },
});
const cacheOf = (dir) => path.join(dir, 'update-check.json');

// Runs `wx hello` with terminals on both streams, a cache folder, a registry answering `latest` (or failing).
async function hi({
  argv = ['hello'],
  env = {},
  cache,
  latest = '1.3.0',
  registry,
  stdout = tty(),
  stderr = tty(),
} = {}) {
  const dir = tempConfigDir();
  if (cache) fs.writeFileSync(cacheOf(dir), JSON.stringify(cache));
  const calls = [];
  const fetch =
    registry ??
    (async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({name: 'wldx-cli', version: latest}), {status: 200});
    });
  const before = {...program};
  setProgram({name: 'wx', pkg: 'wldx-cli', version: '1.2.0'});
  try {
    const code = await main(argv, {stdout, stderr, env: {WILDIX_CONFIG_DIR: dir, ...env}, fetch, now: () => NOW});
    const saved = fs.existsSync(cacheOf(dir)) ? JSON.parse(fs.readFileSync(cacheOf(dir), 'utf8')) : undefined;
    return {code, out: stdout.text, err: stderr.text, calls, saved};
  } finally {
    setProgram(before);
  }
}
const NOTICE = /wx 1\.2\.0 → 1\.3\.0 is out: npm i -g wldx-cli/;

test('a newer version on npm: one line on stderr after the output, the registry asked once a day', async () => {
  const r = await hi();
  assert.equal(r.code, 0);
  assert.equal(r.out, 'hi\n');
  assert.match(r.err, NOTICE);
  assert.deepEqual(r.calls, ['https://registry.npmjs.org/wldx-cli/latest']);
  assert.deepEqual(r.saved, {'wldx-cli': {latest: '1.3.0', checkedAt: NOW}});
});

test('a check less than a day old is not repeated; its answer is used', async () => {
  const r = await hi({cache: {'wldx-cli': {latest: '1.3.0', checkedAt: NOW - DAY / 2}}});
  assert.deepEqual(r.calls, []);
  assert.match(r.err, NOTICE);
  const old = await hi({cache: {'wldx-cli': {latest: '1.2.0', checkedAt: NOW - 2 * DAY}}});
  assert.equal(old.calls.length, 1);
  assert.match(old.err, NOTICE);
});

test('the same or an older version, or a pre-release: nothing', async () => {
  for (const latest of ['1.2.0', '1.1.9', '1.3.0-beta.1']) assert.equal((await hi({latest})).err, '', latest);
});

test('silent without a terminal, with --output json, in CI, under npx, when turned off, for completion', async () => {
  const cases = [
    {stdout: {isTTY: false, text: '', write: tty().write}},
    {stderr: {isTTY: false, text: '', write: tty().write}},
    {argv: ['--output', 'json', 'hello']},
    {argv: ['hello', '--output=json']},
    {env: {CI: 'true'}},
    {env: {npm_command: 'exec'}},
    {env: {WX_NO_UPDATE_CHECK: '1'}},
    {env: {NO_UPDATE_NOTIFIER: '1'}},
    {argv: ['__complete', '--', 'he']},
    {argv: ['completion', 'zsh']},
  ];
  for (const c of cases) {
    const r = await hi(c);
    assert.ok(!/is out/.test(r.err), JSON.stringify(c));
    assert.deepEqual(r.calls, [], JSON.stringify(c));
  }
});

test('a registry that fails or hangs changes nothing: same output, same exit code, tried again tomorrow', async () => {
  const failing = async () => {
    throw new Error('offline');
  };
  let r = await hi({registry: failing});
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.saved['wldx-cli'].checkedAt, NOW);
  const hanging = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const started = Date.now();
  r = await hi({registry: hanging});
  assert.ok(Date.now() - started < 2000, 'the command is not held by the registry');
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
});

test('the notice also follows a command that failed, and keeps its exit code', async () => {
  const r = await hi({argv: ['nope']});
  assert.equal(r.code, 64);
  assert.match(r.err, NOTICE);
});

test('isNewer compares x.y.z as numbers', () => {
  assert.equal(isNewer('1.10.0', '1.9.9'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.2.0', '1.2.0'), false);
  assert.equal(isNewer('1.2.0-rc.1', '1.1.0'), false);
  assert.equal(isNewer('nonsense', '1.0.0'), false);
});

test('a check cut short by the end of the command is not kept: the next run asks again', async () => {
  const slow = (url, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify({version: '1.3.0'}))), 800);
      init.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    });
  const r = await hi({registry: slow});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(r.code, 0);
  assert.equal(r.saved, undefined);
});
