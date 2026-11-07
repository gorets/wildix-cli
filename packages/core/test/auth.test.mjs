import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {COGNITO_URL, getToken, saveTokens, stamp, tokenFile} from '../src/auth.mjs';
import {AuthError} from '../src/errors.mjs';
import {fakeFetch, fakeJwt, tempConfigDir} from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 7, 12);

function seed(env, email, {expSeconds, refresh = 'refresh-1'} = {}) {
  const set = {
    IdToken: fakeJwt({email, exp: expSeconds}),
    AccessToken: 'a',
    RefreshToken: refresh,
    ExpiresIn: 3600,
    email,
    savedAt: stamp(NOW - 600_000),
  };
  saveTokens(tokenFile(email, env), set);
  return set;
}

test('the file name follows the skill: @ becomes _at_, .prod.json', () => {
  const env = {WILDIX_CONFIG_DIR: '/x'};
  assert.equal(tokenFile('a.b@c.com', env), path.join('/x', 'tokens', 'a.b_at_c.com.prod.json'));
  assert.throws(() => tokenFile('../evil', env), AuthError);
  assert.throws(() => tokenFile('a/b@c.com', env), AuthError);
});

test('stamp has no milliseconds (the skill parses it with date -f)', () => {
  assert.equal(stamp(NOW + 123), '2026-11-07T12:00:00Z');
});

test('the only saved session is used while its token is valid, without a request', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  const set = seed(env, 'me@example.com', {expSeconds: NOW / 1000 + 3600});
  const fetch = fakeFetch();
  assert.equal(await getToken({env, fetchImpl: fetch, now: NOW}), set.IdToken);
  assert.equal(fetch.calls.length, 0);
});

test('several sessions need --account or WILDIX_EMAIL', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  seed(env, 'a@example.com', {expSeconds: NOW / 1000 + 3600});
  const b = seed(env, 'b@example.com', {expSeconds: NOW / 1000 + 3600});
  await assert.rejects(getToken({env, now: NOW}), /Several profiles.*\n.*a@example.com\n.*b@example.com/s);
  assert.equal(await getToken({env: {...env, WILDIX_EMAIL: 'b@example.com'}, now: NOW}), b.IdToken);
  assert.equal(await getToken({env, profile: 'b@example.com', now: NOW}), b.IdToken);
});

test('an expired token is renewed and written back in the format of the skill, 0600', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  seed(env, 'me@example.com', {expSeconds: NOW / 1000 + 30});
  const fresh = fakeJwt({email: 'me@example.com', exp: NOW / 1000 + 3600});
  const fetch = fakeFetch({
    body: {AuthenticationResult: {IdToken: fresh, AccessToken: 'a2', ExpiresIn: 3600, TokenType: 'Bearer'}},
  });
  assert.equal(await getToken({env, fetchImpl: fetch, now: NOW}), fresh);

  const [call] = fetch.calls;
  assert.equal(call.url, COGNITO_URL);
  assert.equal(call.headers['x-amz-target'], 'AWSCognitoIdentityProviderService.InitiateAuth');
  assert.deepEqual(call.body.AuthParameters, {REFRESH_TOKEN: 'refresh-1'});

  const file = tokenFile('me@example.com', env);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.IdToken, fresh);
  assert.equal(saved.RefreshToken, 'refresh-1');
  assert.equal(saved.email, 'me@example.com');
  assert.equal(saved.savedAt, '2026-11-07T12:00:00Z');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['me_at_example.com.prod.json']);
});

test('a refused renewal is an AuthError and leaves the file as it was', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  const set = seed(env, 'me@example.com', {expSeconds: NOW / 1000 - 10});
  const fetch = fakeFetch({
    status: 400,
    body: {__type: 'NotAuthorizedException', message: 'Refresh Token has expired'},
  });
  await assert.rejects(
    getToken({env, fetchImpl: fetch, now: NOW}),
    (e) => e instanceof AuthError && /Refresh Token has expired/.test(e.message),
  );
  assert.equal(JSON.parse(fs.readFileSync(tokenFile('me@example.com', env), 'utf8')).IdToken, set.IdToken);
});

test('a rotated RefreshToken from a renewal is kept; an e-mail in another case finds its session', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  seed(env, 'me@example.com', {expSeconds: NOW / 1000 - 10});
  const fresh = fakeJwt({email: 'me@example.com', exp: NOW / 1000 + 3600});
  const fetch = fakeFetch({
    body: {AuthenticationResult: {IdToken: fresh, AccessToken: 'a2', RefreshToken: 'refresh-2', ExpiresIn: 3600}},
  });
  assert.equal(await getToken({env, profile: 'Me@Example.COM', fetchImpl: fetch, now: NOW}), fresh);
  assert.equal(JSON.parse(fs.readFileSync(tokenFile('me@example.com', env), 'utf8')).RefreshToken, 'refresh-2');
});
