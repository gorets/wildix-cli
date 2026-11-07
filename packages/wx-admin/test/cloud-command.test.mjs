import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CPA, envOfTest, fakeCloud} from './fake-cloud.mjs';
import {run} from './helpers.mjs';

const DS = {
  id: 'ds1',
  name: 'Docs',
  type: 'confluence',
  config: {confluence: {apiKey: 'ATATT-secret-value', username: 'a@b.c'}},
};
const cloud = () =>
  fakeCloud((method, u) => {
    if (u.pathname === '/api/v1/data-sources/ds1') return {body: {dataSource: DS}};
    if (u.pathname === '/api/v1/data-sources/ds1/documents')
      return {body: {documents: [], query: Object.fromEntries(u.searchParams)}};
    if (u.pathname === '/api/v1/knowledge-bases' && method === 'POST') return {body: {knowledgeBase: {id: 'kb1'}}};
    return {status: 404, body: {message: 'nope'}};
  });
const wx = (f, argv, opts = {}) => run(argv, {env: envOfTest(), fetch: f.fetch, ...opts});

test('lists the services', async () => {
  const r = await wx(cloud(), ['cloud'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  for (const s of ['kb', 'voicebots', 'tools', 'wilma']) assert.match(r.stdout, new RegExp(`^${s}\\b`, 'm'));
});

test('lists the operations of kb', async () => {
  const r = await wx(cloud(), ['cloud', 'kb'], {output: 'text'});
  assert.match(r.stdout, /^ListDocuments\s+GET\s+\/api\/v1\/data-sources\/\{dataSourceId\}\/documents/m);
});

test('GET with path and query params', async () => {
  const f = cloud();
  const r = await wx(f, ['cloud', 'kb', 'ListDocuments', '--param', 'dataSourceId=ds1', '--param', 'limit=2']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).query, {limit: '2'});
  assert.equal(f.cloudCalls()[0].headers.authorization, `Bearer ${CPA}`);
});

test('an unknown operation lists the known ones (exit 64)', async () => {
  const r = await wx(cloud(), ['cloud', 'kb', 'Nope']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Unknown operation of kb: Nope/);
});

test('a missing required parameter is named; an unknown one too', async () => {
  let r = await wx(cloud(), ['cloud', 'kb', 'ListDocuments']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /needs --param dataSourceId=/);
  r = await wx(cloud(), ['cloud', 'kb', 'ListDocuments', '--param', 'dataSourceId=ds1', '--param', 'zzz=1']);
  assert.match(r.stderr, /ListDocuments has no parameter zzz/);
});

test('a body for an operation without one is refused', async () => {
  const r = await wx(cloud(), ['cloud', 'kb', 'GetDataSource', '--param', 'dataSourceId=ds1', '--data', '{}']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /takes no body/);
});

test('POST without --yes is refused before any request', async () => {
  const f = cloud();
  const r = await wx(f, ['cloud', 'kb', 'CreateKnowledgeBase', '--data', '{"name":"x","dataSources":[]}']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--yes/);
  assert.equal(f.cloudCalls().length, 0);
  const ok = await wx(f, ['cloud', 'kb', 'CreateKnowledgeBase', '--data', '{"name":"x","dataSources":[]}', '--yes']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(f.cloudCalls()[0].body, {name: 'x', dataSources: []});
});

test('apiKey of a data source is masked; --show-secrets shows it', async () => {
  let r = await wx(cloud(), ['cloud', 'kb', 'GetDataSource', '--param', 'dataSourceId=ds1']);
  assert.ok(!r.stdout.includes('ATATT-secret-value'));
  assert.equal(JSON.parse(r.stdout).dataSource.config.confluence.username, 'a@b.c');
  r = await wx(cloud(), ['cloud', 'kb', 'GetDataSource', '--param', 'dataSourceId=ds1', '--show-secrets']);
  assert.ok(r.stdout.includes('ATATT-secret-value'));
});

test('--env stable with kb is refused', async () => {
  const f = cloud();
  const r = await wx(f, ['--env', 'stable', 'cloud', 'kb', 'ListKnowledgeBases']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /no stable environment/);
  assert.equal(f.cloudCalls().length, 0);
});
