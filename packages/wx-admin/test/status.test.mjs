// wx-admin status: the PBX signed in to, how, until when; --check asks each of them once.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {saveAccess, savedAccess, setDefaultPbx} from '../src/pbx.mjs';
import {signIn} from '../src/wms-login.mjs';
import {fakeWms} from './fake-wms.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const T0 = Date.UTC(2026, 10, 7, 12);
const now = () => T0;
const KEY = `wsk-v1-${'a'.repeat(93)}`;
const home = () => ({WILDIX_CONFIG_DIR: tempConfigDir()});
const status = (env, argv = [], opts = {}) => run(['status', ...argv], {env, now, ...opts});

test('no PBX: the login hint', async () => {
  const r = await status(home(), [], {output: 'text'});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^wx-admin\s+\d+\.\d+\.\d+/m);
  assert.match(r.stdout, /Not signed in to any PBX: wx-admin login <host>/);
});

test('several PBX, the default marked, no network', async () => {
  const env = home();
  saveAccess({host: 'one.wildixin.com', port: 443, auth: 'apikey', key: KEY, serial: '2211000000ef'}, env);
  saveAccess(
    {host: 'two.example.com', port: 8443, auth: 'password', mode: 'basic', username: 'admin', password: 'pw'},
    env,
  );
  setDefaultPbx('one.wildixin.com', env);
  const calls = [];
  const fetch = async (u) => {
    calls.push(u);
    return new Response('{}');
  };
  const r = await status(env, [], {fetch});
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.pbxs.map((p) => [p.host, p.port, p.auth, p.mode ?? null, p.default]),
    [
      ['one.wildixin.com', 443, 'apikey', null, true],
      ['two.example.com', 8443, 'password', 'basic', false],
    ],
  );
  assert.equal(calls.length, 0);
  assert.ok(!r.stdout.includes('pw') && !r.stdout.includes(KEY));
  const text = await status(env, [], {output: 'text', fetch});
  assert.match(text.stdout, /\*\s+one\.wildixin\.com\s+serial 2211000000ef\s+Company API Key/);
  assert.match(text.stdout, /two\.example\.com:8443\s+admin · Basic/);
});

test('WILDIX_PBX_API_KEY is shown', async () => {
  const r = await status({...home(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'ci'});
  assert.equal(JSON.parse(r.stdout).environmentKey, 'ci.wildixin.com');
  assert.ok(!r.stdout.includes(KEY));
});

test('a WMS sign-in shows until about the earlier of its expiry and its last use + 36 h', async () => {
  const pbx = fakeWms({now, basic: false});
  const t = await signIn({base: 'https://x', username: 'admin', password: 'pw', askCode: () => '', fetch: pbx.fetch});
  const env = home();
  saveAccess(
    {
      host: 'w.wildixin.com',
      port: 443,
      auth: 'password',
      mode: 'token',
      username: 'admin',
      password: 'pw',
      ...t,
      lastUsed: new Date(T0).toISOString(),
    },
    env,
  );
  const p = JSON.parse((await status(env)).stdout).pbxs[0];
  assert.equal(p.until, new Date(T0 + 36 * 3600 * 1000).toISOString());
  assert.equal(p.default, true); // the only one
});

test('--check: one refused → exit 1, the others accepted', async () => {
  const env = home();
  saveAccess({host: 'one.wildixin.com', port: 443, auth: 'apikey', key: KEY}, env);
  saveAccess({host: 'two.wildixin.com', port: 443, auth: 'token', token: 'tok'}, env);
  const fetch = async (u) =>
    new URL(u).host === 'two.wildixin.com'
      ? new Response(JSON.stringify({type: 'error', reason: 'Unauthorized'}), {status: 401})
      : new Response(JSON.stringify({type: 'result', result: {}}));
  const r = await status(env, ['--check'], {fetch});
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.pbxs.map((p) => [p.host, p.accepted]),
    [
      ['one.wildixin.com', true],
      ['two.wildixin.com', false],
    ],
  );
  assert.match(out.pbxs[1].error, /HTTP 401/);
});

test('--check moves a WMS sign-in to Basic when the PBX now takes it', async () => {
  const pbx = fakeWms({now, basic: false});
  const t = await signIn({base: 'https://x', username: 'admin', password: 'pw', askCode: () => '', fetch: pbx.fetch});
  const env = home();
  saveAccess(
    {
      host: 'w.wildixin.com',
      port: 443,
      auth: 'password',
      mode: 'token',
      username: 'admin',
      password: 'pw',
      ...t,
      lastUsed: new Date(T0).toISOString(),
    },
    env,
  );
  pbx.state.basic = true;
  const r = await status(env, ['--check'], {fetch: pbx.fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(savedAccess('w.wildixin.com', env).mode, 'basic');
  assert.equal(JSON.parse(r.stdout).pbxs[0].mode, 'basic');
});
