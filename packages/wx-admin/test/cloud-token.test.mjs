import assert from 'node:assert/strict';
import {beforeEach, test} from 'node:test';
import {clearCloudTokens, cloudToken} from '../src/cloud/token.mjs';
import {fakeJwt, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const EXP = Date.UTC(2026, 10, 7, 20) / 1000;
const TOKEN = fakeJwt({'custom:company_id': 'it_x', 'custom:company_name': 'X Inc', exp: EXP});

// A PBX that answers the CPA route; counts the requests.
function pbx(
  answer = () => ({
    status: 200,
    body: {type: 'result', result: {token: TOKEN, portal: 'https://wim-console-stage.wildix.com'}},
  }),
) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const a = answer();
    return new Response(JSON.stringify(a.body), {status: a.status});
  };
  return {fetch, calls};
}
const ctxOf = (p, now = Date.UTC(2026, 10, 7, 12)) => ({
  env: {WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'},
  fetch: p.fetch,
  values: {},
  info: () => {},
  clock: () => now,
  now,
});

beforeEach(() => clearCloudTokens());

test('reads company, portal and expiry from the CPA route', async () => {
  const p = pbx();
  const t = await cloudToken(ctxOf(p));
  assert.deepEqual(
    {...t, token: t.token === TOKEN},
    {
      token: true,
      company: 'it_x',
      companyName: 'X Inc',
      portal: 'https://wim-console-stage.wildix.com',
      expiresAt: EXP * 1000,
      pbx: 'demo.wildixin.com',
    },
  );
  assert.match(
    p.calls[0],
    /^https:\/\/demo\.wildixin\.com\/api\/v1\/PBX\/integration\/x-bees\/?\?skip-basic-auth-header=true$/,
  );
});

test('a second call in the same process asks the PBX once', async () => {
  const p = pbx();
  await cloudToken(ctxOf(p));
  await cloudToken(ctxOf(p));
  assert.equal(p.calls.length, 1);
});

test('a token near its end is taken again', async () => {
  const p = pbx();
  await cloudToken(ctxOf(p));
  await cloudToken(ctxOf(p, EXP * 1000 - 30_000));
  assert.equal(p.calls.length, 2);
});

test('a 403 of the PBX is the administrator hint', async () => {
  const p = pbx(() => ({status: 403, body: {type: 'error', reason: 'Access error'}}));
  await assert.rejects(cloudToken(ctxOf(p)), (e) => e.exitCode === 2 || /administrator/.test(e.message));
  await assert.rejects(cloudToken(ctxOf(p)), /gives its cloud token only to an administrator/);
});

test('an answer without a token is an error that holds no secret', async () => {
  const p = pbx(() => ({status: 200, body: {type: 'result', result: {portal: 'x', other: 'secret-value'}}}));
  await assert.rejects(
    cloudToken(ctxOf(p)),
    (e) => /no cloud token/.test(e.message) && !e.message.includes('secret-value'),
  );
});
