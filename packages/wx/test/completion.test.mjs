import assert from 'node:assert/strict';
import {test} from 'node:test';
import {saveTokens, stamp, tokenFile} from 'wldx-core/auth';
import {complete} from '../src/cli.mjs';
import {fakeFetch, fakeJwt, run, tempConfigDir} from './helpers.mjs';

const values = (lines) => lines.map((l) => l.split('\t')[0]);

test('the first word: groups and completion, options only after a dash', () => {
  assert.deepEqual(values(complete([''])), [
    'chat',
    'channel',
    'inbox',
    'file',
    'user',
    'section',
    'calls',
    'meetings',
    'conversations',
    'reports',
    'live',
    'phone',
    'profile',
    'login',
    'logout',
    'status',
    'completion',
  ]);
  assert.deepEqual(values(complete(['c'])), ['chat', 'channel', 'calls', 'conversations', 'completion']);
  assert.deepEqual(values(complete(['lo'])), ['login', 'logout']);
  assert.deepEqual(values(complete(['login', '--'])), [
    '--send-code',
    '--code',
    '--help',
    '--profile',
    '--output',
    '--pretty',
    '--no-color',
  ]);
  assert.deepEqual(complete(['status', '--output', '']), ['text', 'json']);
  assert.deepEqual(values(complete(['--'])), ['--help', '--version', '--profile', '--output']);
});

test('candidates carry the description after a tab', () => {
  assert.match(complete(['ch'])[0], /^chat\tchats: /);
});

test('the commands of a group', () => {
  assert.deepEqual(values(complete(['chat', ''])), [
    'list',
    'read',
    'send',
    'get',
    'edit',
    'delete',
    'pin',
    'unpin',
    'react',
    'unreact',
    'reactions',
    'mentions',
    'search',
    'watch',
  ]);
  assert.deepEqual(values(complete(['chat', 'r'])), ['read', 'react', 'reactions']);
  assert.deepEqual(complete(['nope', '']), []);
});

test('the options of a command, without those already given', () => {
  assert.deepEqual(values(complete(['chat', 'list', '--'])), [
    '--filter',
    '--section',
    '--cursor',
    '--help',
    '--profile',
    '--output',
    '--pretty',
    '--no-color',
  ]);
  assert.deepEqual(values(complete(['chat', 'list', '--filter', 'unread', '--'])), [
    '--section',
    '--cursor',
    '--help',
    '--profile',
    '--output',
    '--pretty',
    '--no-color',
  ]);
  assert.deepEqual(complete(['chat', 'list', '']), []);
});

test('the values of an option with choices', () => {
  assert.deepEqual(complete(['chat', 'list', '--filter', '']), ['unread', 'archived']);
  assert.deepEqual(complete(['chat', 'list', '--filter', 'a']), ['archived']);
  assert.deepEqual(complete(['chat', 'list', '--section', '']), []);
});

test('--profile offers the saved accounts, without the network', () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  for (const email of ['a@example.com', 'b@example.com']) {
    saveTokens(tokenFile(email, env), {
      IdToken: fakeJwt({exp: 1}),
      RefreshToken: 'r',
      ExpiresIn: 1,
      email,
      savedAt: stamp(0),
    });
  }
  assert.deepEqual(complete(['chat', 'read', '--profile', ''], env), ['a@example.com', 'b@example.com']);
  assert.deepEqual(complete(['status', '--profile', 'b'], env), ['b@example.com']);
});

test('completion: the shells', () => {
  assert.deepEqual(values(complete(['completion', ''])), ['bash', 'zsh', 'fish']);
  assert.deepEqual(complete(['completion', 'zsh', '']), []);
});

test('wx __complete prints one candidate per line and needs no login', async () => {
  const fetch = fakeFetch();
  const r = await run(['__complete', '--', 'chat', ''], {env: {WILDIX_CONFIG_DIR: '/nonexistent-wx-test'}, fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(values(r.stdout.trim().split('\n')), [
    'list',
    'read',
    'send',
    'get',
    'edit',
    'delete',
    'pin',
    'unpin',
    'react',
    'unreact',
    'reactions',
    'mentions',
    'search',
    'watch',
  ]);
  assert.equal(fetch.calls.length, 0);
});

test('wx completion prints the script of the shell, $SHELL by default', async () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const r = await run(['completion', shell]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /wx __complete --/);
  }
  assert.match((await run(['completion'], {env: {SHELL: '/bin/zsh'}})).stdout, /compdef _wx wx/);
  assert.equal((await run(['completion', 'tcsh'])).code, 64);
});

test('an option value outside its choices is refused by the router', async () => {
  const r = await run(['chat', 'list', '--filter', 'all'], {env: {WILDIX_ID_TOKEN: 't'}, fetch: fakeFetch()});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--filter must be one of unread, archived: all/);
});

test('global options anywhere: their values, and the command after them', () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  for (const email of ['a@example.com', 'second.account@my.dev']) {
    saveTokens(tokenFile(email, env), {
      IdToken: fakeJwt({exp: 1}),
      RefreshToken: 'r',
      ExpiresIn: 1,
      email,
      savedAt: stamp(0),
    });
  }
  assert.deepEqual(complete(['--profile', 's'], env), ['second.account@my.dev']);
  assert.deepEqual(values(complete(['--profile', 'a@example.com', 'chat', 'r'], env)), ['read', 'react', 'reactions']);
  assert.deepEqual(complete(['profile', 'use', ''], env), ['a@example.com', 'second.account@my.dev']);
  assert.deepEqual(values(complete(['--output=json', 'li'], env)), ['live']);
  assert.deepEqual(complete(['chat', 'list', '--profile', ''], env), ['a@example.com', 'second.account@my.dev']);
});
