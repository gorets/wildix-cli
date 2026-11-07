// wx-admin login and logout: a Company API Key, or a login and password (Basic when the PBX takes it, else the WMS
// sign-in with its second factor), the password kept unless --no-basic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {defaultPbx, saveAccess, savedAccess} from '../src/pbx.mjs';
import {fakeWms} from './fake-wms.mjs';
import {run, tempConfigDir, terminal} from './helpers.mjs';

const HOST = 'mypbx.wildixin.com';
const T0 = Date.UTC(2026, 10, 7, 12);
const now = () => T0;
const KEY = `wsk-v1-${'a'.repeat(93)}`;
const home = () => ({WILDIX_CONFIG_DIR: tempConfigDir()});
const login = (env, argv, opts = {}) => run(['login', ...argv], {env, now, output: 'text', ...opts});
const typed = (s) => [...s, '\r'];

test('no terminal and no flag: exit 64 naming the flags', async () => {
  const r = await login(home(), ['mypbx'], {fetch: fakeWms({now}).fetch});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--api-key.*--password/s);
});

test('an argument and a different --pbx: exit 64', async () => {
  const r = await login(home(), ['one', '--pbx', 'two', '--api-key'], {stdin: `${KEY}\n`});
  assert.equal(r.code, 64);
});

test('the menu: Enter takes the API key, typed hidden, checked, saved', async () => {
  const pbx = fakeWms({now});
  const env = home();
  const keyRead = [];
  const fetch = async (url, init) => {
    keyRead.push(init.headers?.authorization);
    return new Response(JSON.stringify({type: 'result', result: {}}), {status: 200});
  };
  const r = await login(env, ['mypbx'], {fetch, stdin: terminal(['\r'], typed(KEY))});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Company API Key \(recommended\)/);
  assert.match(r.stderr, /PBX → Integrations → Company API Keys/);
  assert.ok(!r.stderr.includes(KEY));
  assert.equal(savedAccess(HOST, env).key, KEY);
  assert.equal(keyRead[0], `Bearer ${KEY}`);
  assert.equal(pbx.state.calls.length, 0);
});

test('--password with Basic on: mode basic, no /auth/ call, the warning about 2FA', async () => {
  const pbx = fakeWms({now});
  const env = home();
  const r = await login(env, ['mypbx', '--password'], {fetch: pbx.fetch, stdin: 'pw\n'});
  assert.equal(r.code, 0, r.stderr);
  const a = savedAccess(HOST, env);
  assert.deepEqual([a.auth, a.mode, a.username, a.password], ['password', 'basic', 'admin', 'pw']);
  assert.ok(pbx.state.calls.every((c) => !c.path.startsWith('/api/v1/auth/')));
  assert.match(r.stdout, /as admin with Basic.*password is saved.*bypasses 2FA/s);
  assert.match(r.stdout, /It is the default PBX/);
  const file = path.join(env.WILDIX_CONFIG_DIR, 'admin', 'pbx', `${HOST}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('--password with Basic off: the token sign-in with --code; mode token, refresh and password saved', async () => {
  const pbx = fakeWms({
    now,
    basic: false,
    users: {admin: {password: 'pw', factor: 'googleauthenticator', code: '1234'}},
  });
  const env = home();
  const r = await login(env, ['mypbx', '--password', '--code', '1234'], {fetch: pbx.fetch, stdin: 'pw\n'});
  assert.equal(r.code, 0, r.stderr);
  const a = savedAccess(HOST, env);
  assert.deepEqual([a.mode, a.password, Boolean(a.refresh), Boolean(a.lastUsed)], ['token', 'pw', true, true]);
  assert.match(r.stdout, /WMS sign-in \(2FA\), until about/);
  assert.match(r.stdout, /password is saved so that wx-admin can sign in again/);
  assert.deepEqual(pbx.state.attempts, {basic: 1, signIn: 1});
});

test('the code typed in a terminal (user asked, admin by default)', async () => {
  const pbx = fakeWms({now, basic: false, users: {admin: {password: 'pw', factor: 'googleauthenticator', code: '77'}}});
  const env = home();
  const r = await login(env, ['mypbx', '--password'], {
    fetch: pbx.fetch,
    stdin: terminal(['\r'], typed('pw'), typed('77')),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /User \[admin\]/);
  assert.match(r.stderr, /authenticator app code/);
  assert.equal(savedAccess(HOST, env).mode, 'token');
});

test('Basic off and a wrong password: the PBX reason, nothing saved, one attempt of each', async () => {
  const pbx = fakeWms({now, basic: false});
  const env = home();
  const r = await login(env, ['mypbx', '--password'], {fetch: pbx.fetch, stdin: 'wrong-Pass-9\n'});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Login or password incorrect/);
  assert.ok(!r.stderr.includes('wrong-Pass-9'));
  assert.deepEqual(pbx.state.attempts, {basic: 1, signIn: 1});
  assert.equal(savedAccess(HOST, env), undefined);
});

test('Basic off and no WMS sign-in on the PBX (404): the API-key hint', async () => {
  const pbx = fakeWms({now, basic: false, auth: false});
  const r = await login(home(), ['mypbx', '--password'], {fetch: pbx.fetch, stdin: 'pw\n'});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /neither Basic.*nor the WMS sign-in.*wx-admin login mypbx\.wildixin\.com --api-key/s);
});

test('a piped password, 2FA asked and no --code: exit 64 naming --code, no wait', async () => {
  const pbx = fakeWms({now, basic: false, users: {admin: {password: 'pw', factor: 'googleauthenticator', code: '1'}}});
  const r = await login(home(), ['mypbx', '--password'], {fetch: pbx.fetch, stdin: 'pw\n'});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /2FA code \(googleauthenticator\).*--code/s);
});

test('--basic: Basic only, no token sign-in when the PBX refuses it', async () => {
  const pbx = fakeWms({now, basic: false});
  const r = await login(home(), ['mypbx', '--basic'], {fetch: pbx.fetch, stdin: 'pw\n'});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ALLOW_BASIC_AUTH/);
  assert.equal(pbx.state.attempts.signIn, 0);
});

test('--no-basic: no Basic attempt, the token sign-in, the password not saved, basic: false', async () => {
  const pbx = fakeWms({now});
  const env = home();
  const r = await login(env, ['mypbx', '--password', '--no-basic'], {fetch: pbx.fetch, stdin: 'pw\n'});
  assert.equal(r.code, 0, r.stderr);
  const a = savedAccess(HOST, env);
  assert.deepEqual([a.mode, a.password, a.basic], ['token', undefined, false]);
  assert.equal(pbx.state.attempts.basic, 0);
  assert.match(r.stdout, /password is not saved/);
});

test('the first login sets the default PBX; a second does not change it', async () => {
  const env = home();
  const ok = async () => new Response(JSON.stringify({type: 'result', result: {}}), {status: 200});
  assert.equal((await login(env, ['one', '--api-key'], {fetch: ok, stdin: `${KEY}\n`})).code, 0);
  assert.equal(defaultPbx(env), 'one.wildixin.com');
  const r = await login(env, ['two', '--api-key'], {fetch: ok, stdin: `${KEY}\n`});
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /default PBX/);
  assert.equal(defaultPbx(env), 'one.wildixin.com');
});

test('a refused login keeps the access saved before', async () => {
  const env = home();
  saveAccess({host: HOST, port: 443, auth: 'apikey', key: KEY}, env);
  const refused = async () => new Response(JSON.stringify({type: 'error', reason: 'Unauthorized'}), {status: 401});
  const r = await login(env, ['mypbx', '--token'], {fetch: refused, stdin: 'tok\n'});
  assert.equal(r.code, 2);
  assert.equal(savedAccess(HOST, env).key, KEY);
});

test('logout of a WMS sign-in ends the session on the PBX and removes the file', async () => {
  const pbx = fakeWms({now, basic: false});
  const env = home();
  await login(env, ['mypbx', '--password'], {fetch: pbx.fetch, stdin: 'pw\n'});
  const r = await run(['logout'], {env, now, fetch: pbx.fetch, output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.state.sessions.size, 0);
  assert.equal(savedAccess(HOST, env), undefined);
  assert.match(r.stdout, /Signed out of mypbx\.wildixin\.com.*ended the session/);
});

test('logout when the PBX does not answer still removes the file and says so', async () => {
  const pbx = fakeWms({now, basic: false});
  const env = home();
  await login(env, ['mypbx', '--password'], {fetch: pbx.fetch, stdin: 'pw\n'});
  const down = async () => {
    throw new Error('down');
  };
  const r = await run(['logout', 'mypbx'], {env, now, fetch: down, output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(savedAccess(HOST, env), undefined);
  assert.match(r.stdout, /ends by itself/);
});

test('pbx add and pbx remove are gone; a file with auth basic is not read', async () => {
  const env = home();
  assert.equal((await run(['pbx', 'add', 'mypbx', '--api-key'], {env, stdin: `${KEY}\n`})).code, 64);
  assert.equal((await run(['pbx', 'remove', 'mypbx'], {env})).code, 64);
  const dir = path.join(env.WILDIX_CONFIG_DIR, 'admin', 'pbx');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(
    path.join(dir, `${HOST}.json`),
    JSON.stringify({host: HOST, auth: 'basic', username: 'a', password: 'b'}),
  );
  assert.equal(savedAccess(HOST, env), undefined);
});

test('no secret anywhere: password, code, tokens and key stay out of every output', async () => {
  const secrets = ['Pa55-word-X', '908172', KEY];
  const pbx = fakeWms({
    now,
    basic: false,
    users: {admin: {password: 'Pa55-word-X', factor: 'googleauthenticator', code: '908172'}},
  });
  const env = home();
  const outs = [];
  const keep = (r) => {
    outs.push(r.stdout, r.stderr);
    return r;
  };
  keep(await login(env, ['mypbx', '--password', '--code', '908172'], {fetch: pbx.fetch, stdin: 'Pa55-word-X\n'}));
  keep(await login(env, ['mypbx', '--password', '--code', '000000'], {fetch: pbx.fetch, stdin: 'Pa55-word-X\n'}));
  keep(await login(env, ['mypbx', '--password'], {fetch: pbx.fetch, stdin: 'wrong\n'}));
  keep(await run(['pbx', 'check', '--output', 'json'], {env, now, fetch: pbx.fetch}));
  keep(await run(['pbx', 'list', '--output', 'json'], {env, now, fetch: pbx.fetch}));
  const a = savedAccess(HOST, env);
  secrets.push(a.refresh, a.accessToken);
  keep(await run(['logout'], {env, now, fetch: pbx.fetch, output: 'json'}));
  const all = outs.join('\n');
  for (const s of secrets) assert.ok(!all.includes(s), `leaked ${s.slice(0, 12)}…`);
});
