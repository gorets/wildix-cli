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

test('an error keeps the type the service names, without its namespace', async () => {
  const answers = [
    {status: 409, body: {type: 'NothingToPublishException', message: 'nothing'}},
    {status: 409, body: {__type: 'wildix.wilma.common#RevisionConflictException', message: 'conflict'}},
    {status: 400, body: {code: 'ValidationException', message: 'bad'}},
    {status: 500, body: {message: 'plain'}},
    new Response('not json', {status: 502}),
  ];
  const f = fakeCloud(() => answers.shift());
  const c = await cloudClient(ctxOf(f), 'wilma');
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const e = await c.call('POST', '/v2/tools/items/t1/versions').catch((x) => x);
    codes.push([e.status, e.code]);
  }
  assert.deepEqual(codes, [
    [409, 'NothingToPublishException'],
    [409, 'RevisionConflictException'],
    [400, 'ValidationException'],
    [500, undefined],
    [502, undefined],
  ]);
});

test('the type in the x-amzn-errortype header (as live Wilma sends it) wins over the body', async () => {
  const header = (type, body = {message: 'There is nothing new to publish.'}, status = 409) =>
    new Response(JSON.stringify(body), {status, headers: {'x-amzn-errortype': type}});
  const answers = [
    header('NothingToPublishException'),
    header('NothingToPublishException:http://internal.amazon.com/coral/wildix.wilma.common/'),
    header('wildix.wilma.common#RevisionConflictException:http://internal.amazon.com/coral/'),
    header('NothingToPublishException', {type: 'RevisionConflictException', message: 'x'}),
    header('', {type: 'RevisionConflictException', message: 'x'}),
    header(`${CPA}:x`, {message: 'echo'}, 400),
  ];
  const f = fakeCloud(() => answers.shift());
  const c = await cloudClient(ctxOf(f), 'wilma');
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const e = await c.call('POST', '/v2/tools/items/t1/versions').catch((x) => x);
    codes.push([e.status, e.code]);
  }
  assert.deepEqual(codes, [
    [409, 'NothingToPublishException'],
    [409, 'NothingToPublishException'],
    [409, 'RevisionConflictException'],
    [409, 'NothingToPublishException'],
    [409, 'RevisionConflictException'],
    [400, '<token>'],
  ]);
});
