import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthError, UsageError} from 'wldx-core/errors';
import {cloudClient} from '../src/cloud/client.mjs';
import {CPA, ctxOf, fakeCloud} from './fake-cloud.mjs';

test('sends the token only to the base of the service, with the query and the JSON body', async () => {
  const f = fakeCloud(() => ({body: {ok: true}}));
  const c = await cloudClient(ctxOf(f), 'kb');
  assert.equal(c.env, 'stage');
  assert.equal(c.company, 'it_x');
  assert.deepEqual(await c.call('POST', '/api/v1/knowledge-bases', {query: {company: 'it_x'}, json: {name: 'n'}}), {
    ok: true,
  });
  const [call] = f.cloudCalls();
  assert.equal(call.url, 'https://kb.wim-stage.wildix.com/api/v1/knowledge-bases?company=it_x');
  assert.equal(call.headers.authorization, `Bearer ${CPA}`);
  assert.deepEqual(call.body, {name: 'n'});
  for (const bad of ['//evil.com/x', 'https://evil.com/x', '/a/../b', 'x', '/a b'])
    await assert.rejects(c.call('GET', bad), UsageError, bad);
  assert.equal(f.cloudCalls().length, 1);
});

test('env from --env over portal', async () => {
  const f = fakeCloud(() => ({body: {}}));
  const c = await cloudClient(ctxOf(f, {cloudEnv: 'prod'}), 'kb');
  await c.call('GET', '/api/v1/knowledge-bases');
  assert.equal(f.cloudCalls()[0].host, 'kb.wim.wildix.com');
  await assert.rejects(cloudClient(ctxOf(f, {cloudEnv: 'stable'}), 'kb'), /no stable environment/);
});

test('the token never appears in an error', async () => {
  const f = fakeCloud((m, u, {headers}) => ({status: 500, body: {message: `bad header ${headers.authorization}`}}));
  const c = await cloudClient(ctxOf(f), 'wilma');
  await assert.rejects(
    c.call('GET', '/v2/agents/agents'),
    (e) => /wilma answered 500/.test(e.message) && !e.message.includes(CPA) && e.message.includes('<token>'),
  );
});

test('401 is an AuthError naming the company', async () => {
  const f = fakeCloud(() => ({status: 401, body: {message: 'Unauthorized'}}));
  const c = await cloudClient(ctxOf(f), 'voicebots');
  await assert.rejects(
    c.call('GET', '/v2/voicebots/bots'),
    (e) => e instanceof AuthError && /refused the token of it_x for voicebots \(401\)/.test(e.message),
  );
});

test('raw sends no Authorization', async () => {
  const f = fakeCloud(() => ({body: {}}));
  const c = await cloudClient(ctxOf(f), 'kb');
  const res = await c.raw('PUT', 'https://bucket.s3.amazonaws.com/doc?sig=1', {body: Buffer.from('x')});
  assert.equal(res.status, 200);
  assert.equal(f.cloudCalls()[0].headers.authorization, undefined);
});
