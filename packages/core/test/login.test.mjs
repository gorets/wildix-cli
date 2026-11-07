import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {PENDING_TTL_MS, pendingFile, saveTokens, stamp, tokenFile} from '../src/auth.mjs';
import {fakeCognito, fakeFetch, fakeJwt, run, tempConfigDir} from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 7, 12);
const EMAIL = 'me@example.com';
const tokens = (claims = {}) => ({
  IdToken: fakeJwt({email: EMAIL, exp: NOW / 1000 + 3600, ...claims}),
  AccessToken: 'access-1',
  RefreshToken: 'refresh-1',
  ExpiresIn: 3600,
  TokenType: 'Bearer',
});

function seed(env, claims) {
  const set = {...tokens(claims), email: EMAIL, savedAt: stamp(NOW)};
  saveTokens(tokenFile(EMAIL, env), set);
  return set;
}

test('wx login --send-code starts the sign-in and keeps its session privately', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  const fetch = fakeCognito({body: {Session: 'S1', ChallengeName: 'CUSTOM_CHALLENGE'}});
  const r = await run(['login', 'Me@Example.com', '--send-code'], {env, fetch, now: () => NOW});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    profile: EMAIL,
    codeSent: true,
    expiresAt: new Date(NOW + PENDING_TTL_MS).toISOString(),
  });
  assert.deepEqual(fetch.targets(), ['InitiateAuth']);
  assert.deepEqual(fetch.calls[0].body.AuthParameters, {USERNAME: EMAIL});
  assert.equal(fetch.calls[0].body.AuthFlow, 'CUSTOM_AUTH');
  const file = pendingFile(EMAIL, env);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!r.stdout.includes('S1'));
});

test('wx login --code saves the session and drops the waiting sign-in', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  await run(['login', EMAIL, '--send-code'], {env, fetch: fakeCognito({body: {Session: 'S1'}}), now: () => NOW});
  const fetch = fakeCognito({body: {AuthenticationResult: tokens()}});
  const r = await run(['login', EMAIL, '--code', '123456'], {env, fetch, now: () => NOW + 60_000});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {profile: EMAIL, loggedIn: true, default: true, defaultProfile: EMAIL});
  assert.deepEqual(fetch.calls[0].body, {
    ChallengeName: 'CUSTOM_CHALLENGE',
    ChallengeResponses: {USERNAME: EMAIL, ANSWER: '123456'},
    ClientId: fetch.calls[0].body.ClientId,
    Session: 'S1',
  });
  const saved = JSON.parse(fs.readFileSync(tokenFile(EMAIL, env), 'utf8'));
  assert.equal(saved.email, EMAIL);
  assert.equal(saved.RefreshToken, 'refresh-1');
  assert.equal(saved.savedAt, '2026-11-07T12:01:00Z');
  assert.equal(fs.statSync(tokenFile(EMAIL, env)).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(pendingFile(EMAIL, env)));
});

test('a wrong code keeps the sign-in with the new session for the next try', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  await run(['login', EMAIL, '--send-code'], {env, fetch: fakeCognito({body: {Session: 'S1'}}), now: () => NOW});
  const r = await run(['login', EMAIL, '--code', '000000'], {
    env,
    fetch: fakeCognito({body: {Session: 'S2', ChallengeName: 'CUSTOM_CHALLENGE'}}),
    now: () => NOW + 1000,
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not accepted.*--code/);
  const fetch = fakeCognito({body: {AuthenticationResult: tokens()}});
  assert.equal((await run(['login', EMAIL, '--code', '123456'], {env, fetch, now: () => NOW + 2000})).code, 0);
  assert.equal(fetch.calls[0].body.Session, 'S2');
});

test('--code without a waiting sign-in, or after 3 minutes, asks to start again', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  let r = await run(['login', EMAIL, '--code', '123456'], {env, fetch: fakeCognito()});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--send-code/);
  await run(['login', EMAIL, '--send-code'], {env, fetch: fakeCognito({body: {Session: 'S1'}}), now: () => NOW});
  r = await run(['login', EMAIL, '--code', '123456'], {env, fetch: fakeCognito(), now: () => NOW + PENDING_TTL_MS + 1});
  assert.equal(r.code, 2);
});

test('wx login asks for the code in a terminal and allows another try', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  const fetch = fakeCognito({body: {Session: 'S1'}}, {body: {Session: 'S2'}}, {body: {AuthenticationResult: tokens()}});
  const r = await run(['login', EMAIL], {env, fetch, tty: true, stdin: '111111\n222222\n', now: () => NOW});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.targets(), ['InitiateAuth', 'RespondToAuthChallenge', 'RespondToAuthChallenge']);
  assert.deepEqual(
    fetch.calls.slice(1).map((c) => [c.body.Session, c.body.ChallengeResponses.ANSWER]),
    [
      ['S1', '111111'],
      ['S2', '222222'],
    ],
  );
  assert.match(r.stderr, /A code was sent to me@example.com/);
  assert.match(r.stderr, /not accepted/);
});

test('wx login without a terminal and without --send-code/--code is a usage error', async () => {
  const r = await run(['login', EMAIL], {env: {WILDIX_CONFIG_DIR: tempConfigDir()}, fetch: fakeCognito()});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--send-code/);
});

test('wx login refuses what is not an e-mail and what is not a code', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  assert.equal((await run(['login', '../x', '--send-code'], {env, fetch: fakeCognito()})).code, 2);
  assert.equal((await run(['login', EMAIL, '--code', '12 34'], {env, fetch: fakeCognito()})).code, 64);
});

test('wx logout revokes the refresh token and deletes the session', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  seed(env);
  const fetch = fakeCognito({body: {}});
  const r = await run(['logout'], {env, fetch, now: () => NOW});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {profile: EMAIL, loggedOut: true, everywhere: false});
  assert.deepEqual(fetch.targets(), ['RevokeToken']);
  assert.equal(fetch.calls[0].body.Token, 'refresh-1');
  assert.ok(!fs.existsSync(tokenFile(EMAIL, env)));
});

test('wx logout --everywhere signs out every device with the access token', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  seed(env);
  const fetch = fakeCognito({body: {}});
  assert.equal((await run(['logout', '--everywhere'], {env, fetch, now: () => NOW})).code, 0);
  assert.deepEqual(fetch.targets(), ['GlobalSignOut']);
  assert.deepEqual(fetch.calls[0].body, {AccessToken: 'access-1'});
});

test('a refused logout keeps the local session', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  seed(env);
  const r = await run(['logout'], {
    env,
    fetch: fakeCognito({status: 400, body: {__type: 'UnsupportedTokenTypeException', message: 'nope'}}),
    now: () => NOW,
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /NOT logged out/);
  assert.ok(fs.existsSync(tokenFile(EMAIL, env)));
});

test('wx status: who, until when, without the network and without a token', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  const set = seed(env, {
    name: 'Me',
    'custom:company_name': 'ACME',
    'custom:pbx_domain': 'acme.wildixin.com',
    'custom:pbx_port': '443',
    'custom:pbx_user_extension': '201',
  });
  const fetch = fakeFetch();
  const r = await run(['status'], {env, fetch, now: () => NOW});
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.loggedIn, true);
  assert.equal(out.user.email, EMAIL);
  assert.equal(out.user.company, 'ACME');
  assert.deepEqual(out.user.pbx, {host: 'acme.wildixin.com', extension: '201'});
  assert.equal(out.tokenValidUntil, '2026-11-07T13:00:00.000Z');
  assert.ok(!r.stdout.includes(set.IdToken));
  assert.equal(fetch.calls.length, 0);

  const text = await run(['status'], {env, fetch, now: () => NOW, output: 'text'});
  assert.match(text.stdout, /^Profile\s+me@example.com \(Me\) · the only one$/m);
  assert.match(text.stdout, /^PBX\s+acme.wildixin.com · extension 201$/m);
});

test('wx status --check asks x-bees and reports a rejected token', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  seed(env);
  const fetch = fakeFetch({status: 401, body: {message: 'Unauthorized'}});
  const r = await run(['status', '--check'], {env, fetch, now: () => NOW});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).tokenAccepted, false);
  assert.equal(fetch.calls[0].url, 'https://api.x-bees.com/v2/conversations/inbox/state');
});

test('wx status when not logged in', async () => {
  const r = await run(['status'], {env: {WILDIX_CONFIG_DIR: tempConfigDir()}, output: 'text'});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Not logged in to Wildix/);
});

test('profiles: the first login is the default, a second one is not; wx profile use and logout change it', async () => {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  const loginAs = async (email) => {
    await run(['login', email, '--send-code'], {env, fetch: fakeCognito({body: {Session: 'S'}}), now: () => NOW});
    const t = {...tokens(), IdToken: fakeJwt({email, exp: NOW / 1000 + 3600})};
    return run(['login', email, '--code', '123456'], {
      env,
      fetch: fakeCognito({body: {AuthenticationResult: t}}),
      now: () => NOW,
      output: 'text',
    });
  };
  assert.equal((await loginAs('a@example.com')).stdout, 'Logged in as a@example.com (the default profile)\n');
  assert.match(
    (await loginAs('b@example.com')).stdout,
    /The default profile stays a@example.com\..*wx profile use b@example.com/s,
  );
  const who = async () => JSON.parse((await run(['status'], {env, now: () => NOW})).stdout).profile;
  assert.deepEqual(await who(), {email: 'a@example.com', by: 'default'});
  const list = JSON.parse((await run(['profile', 'list'], {env, now: () => NOW})).stdout).profiles;
  assert.deepEqual(
    list.map((p) => [p.email, p.default]),
    [
      ['a@example.com', true],
      ['b@example.com', false],
    ],
  );
  assert.equal((await run(['profile', 'use', 'B@example.com'], {env})).code, 0);
  assert.deepEqual(await who(), {email: 'b@example.com', by: 'default'});
  assert.deepEqual(
    JSON.parse((await run(['--profile', 'a@example.com', 'status'], {env, now: () => NOW})).stdout).profile,
    {email: 'a@example.com', by: 'option'},
  );
  assert.equal((await run(['profile', 'use', 'nobody@example.com'], {env})).code, 2);
  assert.equal(fs.statSync(path.join(env.WILDIX_CONFIG_DIR, 'wx.json')).mode & 0o777, 0o600);
  // logging out of the default one leaves no default: with two... one left, it is the only one
  assert.equal((await run(['logout'], {env, fetch: fakeCognito({body: {}}), now: () => NOW})).code, 0);
  assert.deepEqual(await who(), {email: 'a@example.com', by: 'only'});
  const text = await run(['profile', 'list'], {env, now: () => NOW, output: 'text'});
  assert.match(text.stdout, /^ +a@example.com {2}token valid until/);
});
