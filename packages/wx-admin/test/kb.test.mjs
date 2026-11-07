import assert from 'node:assert/strict';
import {test} from 'node:test';
import {envOfTest, fakeCloud, fakeKb} from './fake-cloud.mjs';
import {run} from './helpers.mjs';

const state = () => ({
  kbs: [
    {id: 'kb-a', name: 'Support', description: '', dataSources: ['ds-1'], updatedAt: '2026-11-01T10:00:00Z'},
    {id: 'kb-b', name: 'Public', description: '', dataSources: ['ds-1'], updatedAt: '2026-11-02T10:00:00Z'},
    {id: 'kb-c', name: 'Public', description: '', dataSources: [], updatedAt: '2026-11-03T10:00:00Z'},
  ],
  sources: [
    {id: 'ds-1', name: 'Confluence', type: 'confluence', config: {confluence: {apiKey: 'ATATT-secret'}}},
    {id: 'ds-2', name: 'Files', type: 'files', config: {}},
  ],
  docs: {},
  results: [
    {
      kb: 'kb-a',
      chunkId: 'c1',
      documentId: 'd1',
      documentTitle: 'Reset',
      documentUrl: 'https://x/1',
      dataSourceId: 'ds-1',
      dataSourceType: 'confluence',
      score: 0.5,
      content: 'press reset',
    },
    {
      kb: 'kb-b',
      chunkId: 'c2',
      documentId: 'd2',
      documentTitle: 'Upgrade',
      documentUrl: 'https://x/2',
      dataSourceId: 'ds-1',
      dataSourceType: 'confluence',
      score: 0.9,
      content: 'upgrade it',
    },
  ],
});
const setup = (s = state()) => {
  const f = fakeCloud(fakeKb(s));
  return {f, s, wx: (argv, opts = {}) => run(argv, {env: envOfTest(), fetch: f.fetch, ...opts})};
};

test('list shows data sources by name', async () => {
  const {wx} = setup();
  const r = await wx(['kb', 'list'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Support \(kb-a\).*Confluence/);
});

test('create by source names', async () => {
  const {wx, f} = setup();
  const r = await wx(['kb', 'create', 'New', '--source', 'Confluence', '--source', 'ds-2', '--description', 'd']);
  assert.equal(r.code, 0, r.stderr);
  const post = f.cloudCalls().find((c) => c.method === 'POST');
  assert.deepEqual(post.body, {name: 'New', description: 'd', dataSources: ['ds-1', 'ds-2']});
});

test('update --source needs --yes; update sends the whole object', async () => {
  const {wx, f, s} = setup();
  assert.equal((await wx(['kb', 'update', 'Support', '--source', 'Files'])).code, 64);
  assert.ok(!f.cloudCalls().some((c) => c.method === 'PUT'));
  const r = await wx(['kb', 'update', 'Support', '--source', 'Files', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.cloudCalls().find((c) => c.method === 'PUT').body, {
    name: 'Support',
    description: '',
    dataSources: ['ds-2'],
  });
  assert.equal((await wx(['kb', 'update', 'Support', '--name', 'Help'])).code, 0);
  assert.equal(s.kbs[0].name, 'Help');
});

test('delete needs --yes', async () => {
  const {wx, s} = setup();
  assert.equal((await wx(['kb', 'delete', 'Support'])).code, 64);
  assert.equal(s.kbs.length, 3);
  assert.equal((await wx(['kb', 'delete', 'Support', '--yes'])).code, 0);
  assert.equal(s.kbs.length, 2);
});

test('an ambiguous name asks for the id', async () => {
  const {wx} = setup();
  const r = await wx(['kb', 'get', 'Public']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Several knowledge bases are named Public \(ids kb-b, kb-c\)/);
  assert.equal((await wx(['kb', 'get', 'kb-c'])).code, 0);
});

test('search sends query and searchLimit', async () => {
  const {wx, f} = setup();
  const r = await wx(['kb', 'search', 'Support', 'how to reset', '--limit', '3'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.cloudCalls().find((c) => c.path.endsWith('/search')).body, {
    query: 'how to reset',
    searchLimit: 3,
  });
  assert.match(r.stdout, /0\.50\s+Reset/);
});

test('ask searches each kb then generates from the merged results', async () => {
  const {wx, f} = setup();
  const r = await wx(['kb', 'ask', 'what now', '--kb', 'Support', '--kb', 'kb-b'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  const gen = f.cloudCalls().find((c) => c.path.endsWith('/generate-answer')).body;
  assert.equal(gen.searchQuery, 'what now');
  assert.deepEqual(
    gen.searchResults.map((x) => x.chunkId),
    ['c2', 'c1'],
  );
  assert.match(r.stdout, /^answer to what now$/m);
  assert.match(r.stdout, /Upgrade.*https:\/\/x\/2/);
});

test('history and stats', async () => {
  const {wx, f} = setup();
  assert.equal((await wx(['kb', 'history', '--limit', '5'])).code, 0);
  const h = f.cloudCalls().find((c) => c.path.endsWith('/history/search-queries'));
  assert.equal(h.method, 'POST');
  assert.deepEqual(h.query, {limit: '5'});
  assert.equal((await wx(['kb', 'stats'])).code, 0);
});
