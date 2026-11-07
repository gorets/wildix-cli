// The `password` access: a login and password kept on this computer, used with Basic (mode basic) or the WMS token
// sign-in (mode token), and the moves between them when the PBX changes its mind.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {removeAccess, saveAccess, savedAccess} from '../src/pbx.mjs';
import {signIn} from '../src/wms-login.mjs';
import {fakeWms} from './fake-wms.mjs';
import {fakeJwt, run, tempConfigDir} from './helpers.mjs';

const HOST = 'mypbx.example.com';
const BASE = `https://${HOST}`;
const T0 = Date.UTC(2026, 10, 7, 12);
const now = () => T0;
const noCode = () => assert.fail('no code expected');
const check = (env, fetch, opts = {}) => run(['pbx', 'check', '--pbx', HOST], {env, fetch, now, ...opts});

function home(access) {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  if (access) saveAccess({host: HOST, port: 443, ...access}, env);
  return env;
}

async function tokenAccess(pbx, extra = {}) {
  const t = await signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: pbx.fetch});
  return {
    auth: 'password',
    mode: 'token',
    username: 'admin',
    password: 'pw',
    ...t,
    lastUsed: new Date(T0).toISOString(),
    ...extra,
  };
}

test('mode basic sends Basic; a 401 moves to token with one sign-in and retries the request', async () => {
  const pbx = fakeWms({now});
  const env = home({auth: 'password', mode: 'basic', username: 'admin', password: 'pw'});
  assert.equal((await check(env, pbx.fetch)).code, 0);
  pbx.state.basic = false; // the administrator turned Basic off
  const r = await check(env, pbx.fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.state.attempts.signIn, 1);
  const a = savedAccess(HOST, env);
  assert.equal(a.mode, 'token');
  assert.ok(a.refresh && a.accessToken && a.lastUsed);
  assert.equal(a.password, 'pw');
});

test('mode token reuses a fresh access token without a request to /auth/', async () => {
  const pbx = fakeWms({now, basic: false});
  const env = home(await tokenAccess(pbx));
  const before = pbx.state.calls.length;
  assert.equal((await check(env, pbx.fetch)).code, 0);
  assert.ok(pbx.state.calls.slice(before).every((c) => !c.path.startsWith('/api/v1/auth/')));
});

test('an expired access token is renewed; the new refresh token and lastUsed are saved', async () => {
  const pbx = fakeWms({now, basic: false});
  const old = await tokenAccess(pbx, {
    accessTokenExpires: new Date(T0 - 1000).toISOString(),
    lastUsed: '2026-11-06T00:00:00.000Z',
  });
  old.accessToken = 'x.eyJleHAiOjF9.y'; // exp 1970
  const env = home(old);
  const r = await check(env, pbx.fetch);
  assert.equal(r.code, 0, r.stderr);
  const a = savedAccess(HOST, env);
  assert.notEqual(a.refresh, old.refresh);
  assert.equal(a.lastUsed, new Date(T0).toISOString());
  assert.equal(pbx.state.attempts.signIn, 1); // the one of tokenAccess
});

test('a 401 with Bearer error="invalid_token" on a token thought valid: one renewal, one retry', async () => {
  const pbx = fakeWms({now, basic: false});
  const a = await tokenAccess(pbx);
  const stale = fakeJwt({typ: 'access', user: 'admin', sid: 'gone', exp: T0 / 1000 + 3000}); // valid here, refused there
  const env = home({...a, accessToken: stale});
  const r = await check(env, pbx.fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.state.calls.filter((c) => c.path === '/api/v1/auth/refresh/').length, 1);
});

test('refresh refused: Basic is tried once, then mode basic', async () => {
  const pbx = fakeWms({now});
  const env = home({...(await tokenAccess(pbx)), accessToken: 'x.eyJleHAiOjF9.y'});
  pbx.state.sessions.clear(); // the PBX restarted
  const r = await check(env, pbx.fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(savedAccess(HOST, env).mode, 'basic');
  assert.equal(savedAccess(HOST, env).refresh, undefined);
  assert.equal(pbx.state.attempts.signIn, 1);
});

test('refresh refused, Basic off: a new sign-in with the saved password; with 2FA and no terminal, exit 2', async () => {
  const pbx = fakeWms({now, basic: false});
  let env = home({...(await tokenAccess(pbx)), accessToken: 'x.eyJleHAiOjF9.y'});
  pbx.state.sessions.clear();
  let r = await check(env, pbx.fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.state.attempts.signIn, 2);
  assert.equal(pbx.state.attempts.basic, 1);

  pbx.state.users.admin = {password: 'pw', factor: 'googleauthenticator', code: '1'};
  env = home({...savedAccess(HOST, env), accessToken: 'x.eyJleHAiOjF9.y'});
  pbx.state.sessions.clear();
  r = await check(env, pbx.fetch);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /2FA code.*wx-admin login mypbx\.example\.com/s);
});

test('a changed password: its error, one sign-in and at most one Basic attempt', async () => {
  const pbx = fakeWms({now, basic: false});
  const env = home({...(await tokenAccess(pbx)), accessToken: 'x.eyJleHAiOjF9.y'});
  pbx.state.sessions.clear();
  pbx.state.users.admin.password = 'N3w-pass';
  const before = {...pbx.state.attempts};
  const r = await check(env, pbx.fetch);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /password of admin on mypbx\.example\.com was refused/);
  assert.equal(pbx.state.attempts.signIn - before.signIn, 1);
  assert.ok(pbx.state.attempts.basic - before.basic <= 1);
  assert.ok(!r.stderr.includes('pw') && !r.stderr.includes('N3w-pass'));
});

test('a newer refresh token saved by another process meanwhile is used, not lost', async () => {
  const pbx = fakeWms({now, basic: false});
  const first = await tokenAccess(pbx);
  const env = home({...first, accessToken: 'x.eyJleHAiOjF9.y'});
  const second = await tokenAccess(pbx);
  let raced = false;
  const fetch = async (url, init) => {
    if (!raced && new URL(url).pathname === '/api/v1/auth/refresh/') {
      raced = true; // another wx-admin signed in again and saved, and the old session ended
      saveAccess({host: HOST, port: 443, ...second}, env);
      pbx.state.sessions.delete(JSON.parse(Buffer.from(first.refresh.split('.')[1], 'base64url')).sid);
    }
    return pbx.fetch(url, init);
  };
  const r = await check(env, fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.state.attempts.signIn, 2); // the two of the test, none by wx-admin
  assert.equal(pbx.state.attempts.basic, 0); // Basic is tried only when no newer refresh token exists
});

test('basic: false (--no-basic) and no saved password: a refused refresh never tries Basic and exits 2', async () => {
  const pbx = fakeWms({now});
  const a = await tokenAccess(pbx, {basic: false});
  delete a.password;
  const env = home({...a, accessToken: 'x.eyJleHAiOjF9.y'});
  pbx.state.sessions.clear();
  const r = await check(env, pbx.fetch);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /has ended.*wx-admin login mypbx\.example\.com/s);
  assert.equal(pbx.state.attempts.basic, 0);
  assert.equal(savedAccess(HOST, env).accessToken, undefined);
});

test('403 exits 2', async () => {
  const env = home({auth: 'apikey', key: `wsk-v1-${'a'.repeat(93)}`});
  const fetch = async () => new Response(JSON.stringify({type: 'error', reason: 'Access error'}), {status: 403});
  const r = await run(['user', 'list', '--pbx', HOST], {env, fetch, now});
  assert.equal(r.code, 2, r.stderr);
});

test('config backup in mode basic with a changed password: one Basic attempt, one sign-in, exit 2', async () => {
  const pbx = fakeWms({now});
  const env = home({auth: 'password', mode: 'basic', username: 'admin', password: 'pw'});
  pbx.state.users.admin.password = 'N3w-pass';
  const r = await run(['config', 'backup', '--to', `${env.WILDIX_CONFIG_DIR}/backup`, '--pbx', HOST], {
    env,
    now,
    fetch: pbx.fetch,
  });
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(pbx.state.attempts, {basic: 1, signIn: 1});
});

test('a refused password is remembered: the next command does not contact the PBX', async () => {
  const pbx = fakeWms({now});
  const env = home({auth: 'password', mode: 'basic', username: 'admin', password: 'pw'});
  pbx.state.users.admin.password = 'N3w-pass';
  assert.equal((await check(env, pbx.fetch)).code, 2);
  const calls = pbx.state.calls.length;
  const r = await check(env, pbx.fetch);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /wx-admin login mypbx\.example\.com/);
  assert.equal(pbx.state.calls.length, calls);
  assert.equal(savedAccess(HOST, env).password, undefined);
});

test('a logout by another process during a renewal is not undone', async () => {
  const pbx = fakeWms({now, basic: false});
  const env = home({...(await tokenAccess(pbx)), accessToken: 'x.eyJleHAiOjF9.y'});
  const fetch = async (url, init) => {
    if (new URL(url).pathname === '/api/v1/auth/refresh/') removeAccess(HOST, env);
    return pbx.fetch(url, init);
  };
  await check(env, fetch);
  assert.equal(savedAccess(HOST, env), undefined);
});

test('a new login by another process during a renewal is not overwritten', async () => {
  const pbx = fakeWms({now, basic: false});
  const env = home({...(await tokenAccess(pbx)), accessToken: 'x.eyJleHAiOjF9.y'});
  const KEY = `wsk-v1-${'b'.repeat(93)}`;
  const fetch = async (url, init) => {
    if (new URL(url).pathname === '/api/v1/auth/refresh/')
      saveAccess({host: HOST, port: 443, auth: 'apikey', key: KEY}, env);
    return pbx.fetch(url, init);
  };
  await check(env, fetch);
  assert.equal(savedAccess(HOST, env).key, KEY);
});
