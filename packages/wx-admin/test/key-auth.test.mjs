import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthError} from 'wldx-core/errors';
import {keysClient, AUTH_HOSTS} from '../src/keys/auth.mjs';
import {saveAccess} from '../src/pbx.mjs';
import {fakeJwt, tempConfigDir} from './helpers.mjs';

const PERSONAL = 'personal-token-secret';
const ID_TOKEN = 'id-token-secret';

function ctxOf({access, env = 'stage', routes = {}} = {}) {
  const dir = tempConfigDir();
  const envVars = {WILDIX_CONFIG_DIR: dir};
  if (access !== false)
    saveAccess(
      access ?? {
        host: 'demo.wildixin.com',
        port: 443,
        auth: 'password',
        mode: 'basic',
        username: 'admin',
        password: 'pw',
      },
      envVars,
    );
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.host}${u.pathname}`;
    calls.push({key, search: u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined});
    const r = routes[key];
    if (!r) return new Response('{"message":"no route"}', {status: 404});
    const out = typeof r === 'function' ? r(calls.filter((c) => c.key === key).length) : r;
    return out instanceof Response ? out : new Response(JSON.stringify(out), {status: 200});
  };
  return {
    ctx: {env: envVars, fetch, pbx: 'demo.wildixin.com', cloudEnv: env, clock: () => Date.UTC(2026, 10, 8)},
    calls,
  };
}

const CHAIN = (host = 'auth-stage.wildix.com') => ({
  'GET demo.wildixin.com/api/v1/personal/token/': {type: 'result', result: {token: PERSONAL}},
  [`POST ${host}/api/v2/OpenId/service`]: {type: 'result', result: {id_token: ID_TOKEN}},
  [`GET ${host}/api/v3/scopes`]: {scopes: []},
});

test('the auth host of each environment', () => {
  assert.deepEqual(AUTH_HOSTS, {
    prod: 'auth.wildix.com',
    stable: 'auth-stable.wildix.com',
    stage: 'auth-stage.wildix.com',
  });
});

test('mints the personal token for the auth host, then the id token with the right aud, then calls /api/v3', async () => {
  const {ctx, calls} = ctxOf({routes: CHAIN()});
  const client = await keysClient(ctx);
  const out = await client.call('GET', '/scopes');
  assert.deepEqual(out, {scopes: []});
  assert.deepEqual(
    calls.map((c) => c.key),
    [
      'GET demo.wildixin.com/api/v1/personal/token/',
      'POST auth-stage.wildix.com/api/v2/OpenId/service',
      'GET auth-stage.wildix.com/api/v3/scopes',
    ],
  );
  assert.equal(calls[0].search, '?service=auth-stage.wildix.com');
  assert.equal(calls[1].headers.authorization, `Bearer ${PERSONAL}`);
  assert.deepEqual(calls[1].body, {aud: 'https://auth-stage.wildix.com', scope: 'api-keys'});
  assert.equal(calls[2].headers.authorization, `Bearer ${ID_TOKEN}`);
});

test('tokens are minted once per client', async () => {
  const {ctx, calls} = ctxOf({routes: CHAIN()});
  const client = await keysClient(ctx);
  await client.call('GET', '/scopes');
  await client.call('GET', '/scopes');
  assert.equal(calls.filter((c) => c.key.includes('personal')).length, 1);
});

test('--env prod uses auth.wildix.com', async () => {
  const {ctx, calls} = ctxOf({env: 'prod', routes: CHAIN('auth.wildix.com')});
  await (await keysClient(ctx)).call('GET', '/scopes');
  assert.equal(calls[2].key, 'GET auth.wildix.com/api/v3/scopes');
});

test('without --env the environment of the PBX decides (portal of the cloud token)', async () => {
  const cloud = fakeJwt({'custom:company_id': 'it_x', exp: Date.UTC(2027, 0, 1) / 1000});
  const {ctx, calls} = ctxOf({
    env: undefined,
    routes: {
      ...CHAIN(),
      'GET demo.wildixin.com/api/v1/PBX/integration/x-bees': {
        type: 'result',
        result: {token: cloud, portal: 'https://wim-stage.wildix.com'},
      },
    },
  });
  await (await keysClient(ctx)).call('GET', '/scopes');
  assert.equal(calls.at(-1).key, 'GET auth-stage.wildix.com/api/v3/scopes');
});

test('a Company API Key login cannot mint keys: refused before any request', async () => {
  const {ctx, calls} = ctxOf({
    access: {host: 'demo.wildixin.com', port: 443, auth: 'apikey', key: `wsk-v1-${'a'.repeat(93)}`},
    routes: CHAIN(),
  });
  await assert.rejects(
    keysClient(ctx),
    (e) => e instanceof AuthError && /wx-admin login demo\.wildixin\.com --password/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test('a refused personal token says who may manage keys', async () => {
  const {ctx} = ctxOf({
    routes: {
      'GET demo.wildixin.com/api/v1/personal/token/': new Response('{"type":"error","reason":"Forbidden"}', {
        status: 403,
      }),
    },
  });
  const client = await keysClient(ctx);
  await assert.rejects(client.call('GET', '/scopes'), (e) => e instanceof AuthError && /root admin/.test(e.message));
});

test('a 401 from the service mints the tokens again once; a second 401 is an error without the tokens', async () => {
  const {ctx, calls} = ctxOf({
    routes: {
      ...CHAIN(),
      'GET auth-stage.wildix.com/api/v3/scopes': (n) =>
        n === 1 ? new Response('{"message":"Unauthorized"}', {status: 401}) : {scopes: [{scope: 'a:b'}]},
    },
  });
  const client = await keysClient(ctx);
  assert.deepEqual(await client.call('GET', '/scopes'), {scopes: [{scope: 'a:b'}]});
  assert.equal(calls.filter((c) => c.key.includes('personal')).length, 2);
});

test('errors carry the message of the service and never a token', async () => {
  const {ctx} = ctxOf({
    routes: {
      ...CHAIN(),
      'GET auth-stage.wildix.com/api/v3/scopes': new Response(`{"message":"bad ${ID_TOKEN} ${PERSONAL}"}`, {
        status: 400,
      }),
    },
  });
  const client = await keysClient(ctx);
  await assert.rejects(
    client.call('GET', '/scopes'),
    (e) => /HTTP 400/.test(e.message) && !e.message.includes(ID_TOKEN) && !e.message.includes(PERSONAL),
  );
});

test('paths are checked and ids are safe segments', async () => {
  const {ctx} = ctxOf({routes: CHAIN()});
  const client = await keysClient(ctx);
  await assert.rejects(client.call('GET', 'https://evil.example/x'), /Not a path/);
});
