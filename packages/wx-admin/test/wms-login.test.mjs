// The WMS token sign-in protocol (/api/v1/auth/*): sign in with a second factor, renew, sign out.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renew, signIn, signOut, WmsAuthError} from '../src/wms-login.mjs';
import {fakeWms} from './fake-wms.mjs';

const BASE = 'https://pbx.example.com';
const T0 = Date.UTC(2026, 10, 7, 12);
const now = () => T0;
const noCode = () => assert.fail('no code expected');
const kindOf = (kind) => (e) => e instanceof WmsAuthError && e.kind === kind;

test('sign-in without 2FA returns the tokens and the refresh token from Set-Cookie', async () => {
  const pbx = fakeWms({now});
  const t = await signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: pbx.fetch});
  assert.ok(t.accessToken && t.refresh);
  assert.equal(t.validUntil, new Date(T0 + 604800 * 1000).toISOString());
  assert.equal(t.accessTokenExpires, new Date(T0 + 3600 * 1000).toISOString());
  assert.deepEqual(Object.keys(t).sort(), ['accessToken', 'accessTokenExpires', 'refresh', 'validUntil']);
  assert.deepEqual(pbx.state.calls[0].body, {login: 'admin', password: 'pw', remember: '1'});
});

test('sign-in with googleauthenticator asks the code once and carries PHPSESSID in memory only', async () => {
  const pbx = fakeWms({now, users: {admin: {password: 'pw', factor: 'googleauthenticator', code: '123456'}}});
  const asked = [];
  const t = await signIn({
    base: BASE,
    username: 'admin',
    password: 'pw',
    askCode: async (factor) => {
      asked.push(factor);
      return '123456';
    },
    fetch: pbx.fetch,
  });
  assert.deepEqual(asked, ['googleauthenticator']);
  const second = pbx.state.calls[1];
  assert.deepEqual(second.body, {type: 'next', code: '123456', remember: '1'});
  assert.match(second.headers.cookie, /^PHPSESSID=s\d+$/);
  assert.ok(!JSON.stringify(t).includes('PHPSESSID'));
});

test('email factor: an empty answer has the PBX send the code again, then the code signs in', async () => {
  const pbx = fakeWms({now, users: {admin: {password: 'pw', factor: 'email', code: 'abc'}}});
  const answers = ['', 'abc'];
  const resent = [];
  const t = await signIn({
    base: BASE,
    username: 'admin',
    password: 'pw',
    askCode: async (factor, {resent: again}) => {
      resent.push(again);
      return answers.shift();
    },
    fetch: pbx.fetch,
  });
  assert.ok(t.refresh);
  assert.equal(pbx.state.resent, 1);
  assert.deepEqual(resent, [false, true]);
});

test('a wrong password is kind credentials with the PBX reason, after one attempt', async () => {
  const pbx = fakeWms({now});
  await assert.rejects(
    signIn({base: BASE, username: 'admin', password: 'no', askCode: noCode, fetch: pbx.fetch}),
    (e) => kindOf('credentials')(e) && /Login or password incorrect/.test(e.message) && !e.message.includes('no'),
  );
  assert.equal(pbx.state.attempts.signIn, 1);
});

test('a wrong code is kind credentials; the code is tried once', async () => {
  const pbx = fakeWms({now, users: {admin: {password: 'pw', factor: 'googleauthenticator', code: '1'}}});
  await assert.rejects(
    signIn({base: BASE, username: 'admin', password: 'pw', askCode: async () => '2', fetch: pbx.fetch}),
    kindOf('credentials'),
  );
  assert.equal(pbx.state.calls.filter((c) => c.body?.type === 'next').length, 1);
});

test('403 is kind refused with the reason; 404 is kind missing; a redirect is refused', async () => {
  const blocked = fakeWms({now, users: {admin: {password: 'pw', blocked: 'Confirm the new location'}}});
  await assert.rejects(
    signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: blocked.fetch}),
    (e) => kindOf('refused')(e) && /Confirm the new location/.test(e.message),
  );
  const old = fakeWms({now, auth: false});
  await assert.rejects(
    signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: old.fetch}),
    kindOf('missing'),
  );
  const moved = fakeWms({now, redirectLogin: true});
  await assert.rejects(
    signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: moved.fetch}),
    kindOf('redirect'),
  );
});

test('no Authorization header, trailing slashes and redirect manual on /auth/*', async () => {
  const pbx = fakeWms({now, users: {admin: {password: 'pw', factor: 'sms', code: '9'}}});
  const t = await signIn({base: BASE, username: 'admin', password: 'pw', askCode: async () => '9', fetch: pbx.fetch});
  await renew({base: BASE, refresh: t.refresh, fetch: pbx.fetch});
  await signOut({base: BASE, refresh: t.refresh, fetch: pbx.fetch});
  for (const c of pbx.state.calls) {
    assert.equal(c.headers.authorization, undefined, c.path);
    assert.ok(c.path.endsWith('/'), c.path);
    assert.equal(c.redirect, 'manual', c.path);
  }
});

test('renew sends refresh_token in the body and returns the new refresh token', async () => {
  const pbx = fakeWms({now});
  const t = await signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: pbx.fetch});
  const r = await renew({base: BASE, refresh: t.refresh, fetch: pbx.fetch});
  const call = pbx.state.calls.at(-1);
  assert.equal(call.path, '/api/v1/auth/refresh/');
  assert.deepEqual(call.body, {refresh_token: t.refresh});
  assert.equal(call.headers.cookie, undefined);
  assert.ok(r.accessToken && r.refresh && r.refresh !== t.refresh);
});

test('renew refused is kind expired', async () => {
  const pbx = fakeWms({now});
  const t = await signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: pbx.fetch});
  pbx.state.sessions.clear(); // the PBX forgot the session (36 h idle, a restart)
  await assert.rejects(renew({base: BASE, refresh: t.refresh, fetch: pbx.fetch}), kindOf('expired'));
});

test('signOut posts refresh_token and never throws', async () => {
  const pbx = fakeWms({now});
  const t = await signIn({base: BASE, username: 'admin', password: 'pw', askCode: noCode, fetch: pbx.fetch});
  await signOut({base: BASE, refresh: t.refresh, fetch: pbx.fetch});
  assert.equal(pbx.state.sessions.size, 0);
  await assert.rejects(renew({base: BASE, refresh: t.refresh, fetch: pbx.fetch}), kindOf('expired'));
  await signOut({
    base: BASE,
    refresh: t.refresh,
    fetch: async () => {
      throw new Error('down');
    },
  });
});

test('an unknown factor is still asked for', async () => {
  const pbx = fakeWms({now, users: {admin: {password: 'pw', factor: 'yubikey', code: 'x'}}});
  const asked = [];
  await signIn({
    base: BASE,
    username: 'admin',
    password: 'pw',
    askCode: async (f) => {
      asked.push(f);
      return 'x';
    },
    fetch: pbx.fetch,
  });
  assert.deepEqual(asked, ['yubikey']);
});
