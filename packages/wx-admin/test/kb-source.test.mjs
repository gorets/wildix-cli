import assert from 'node:assert/strict';
import {test} from 'node:test';
import {envOfTest, fakeCloud, fakeKb} from './fake-cloud.mjs';
import {run} from './helpers.mjs';

const state = () => ({
  kbs: [],
  sources: [
    {
      id: 'ds-1',
      name: 'Confluence',
      type: 'confluence',
      syncSchedule: 'EVERY_DAY',
      config: {
        confluence: {
          baseUrl: 'https://a.atlassian.net',
          username: 'u@x.com',
          apiKey: 'ATATT-secret',
          spaceId: '1',
          pages: {enabled: ['5'], disabled: []},
        },
      },
    },
    {id: 'ds-2', name: 'Site', type: 'website', config: {website: {urls: ['https://x.com']}}},
  ],
  docs: {},
  results: [],
  describe: {confluence: {spaces: [{id: '7', name: 'Docs', key: 'DOC', type: 'global'}], pages: []}},
});
const setup = (s = state()) => {
  const f = fakeCloud(fakeKb(s));
  return {f, s, wx: (argv, opts = {}) => run(argv, {env: envOfTest(), fetch: f.fetch, ...opts})};
};

test('list masks apiKey; get shows the sync status too', async () => {
  const {wx} = setup();
  let r = await wx(['kb', 'source', 'list']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('ATATT-secret'));
  r = await wx(['kb', 'source', 'get', 'Confluence']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.syncStatus.status, 'idle');
  assert.ok(!r.stdout.includes('ATATT-secret'));
});

test('create confluence then configure with the key from stdin, never in output', async () => {
  const {wx, f, s} = setup();
  let r = await wx(['kb', 'source', 'create', 'New', '--type', 'confluence']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.cloudCalls().find((c) => c.method === 'POST').body, {
    name: 'New',
    description: '',
    type: 'confluence',
  });
  r = await wx(
    [
      'kb',
      'source',
      'configure',
      'New',
      '--url',
      'https://b.atlassian.net',
      '--user',
      'me@x.com',
      '--space',
      '7',
      '--page',
      '9',
      '--schedule',
      'EVERY_WEEK',
    ],
    {stdin: 'ATATT-new-key\n'},
  );
  assert.equal(r.code, 0, r.stderr);
  const put = f.cloudCalls().find((c) => c.path.endsWith('/configure'));
  assert.deepEqual(put.body, {
    config: {
      confluence: {
        baseUrl: 'https://b.atlassian.net',
        username: 'me@x.com',
        apiKey: 'ATATT-new-key',
        spaceId: '7',
        pages: {enabled: ['9'], disabled: []},
      },
    },
    syncSchedule: 'EVERY_WEEK',
  });
  assert.ok(!r.stdout.includes('ATATT-new-key') && !r.stderr.includes('ATATT-new-key'));
  assert.equal(s.sources.at(-1).config.confluence.apiKey, 'ATATT-new-key');
  assert.equal((await wx(['kb', 'source', 'configure', 'New', '--schedule', 'HOURLY'])).code, 64);
});

test('configure keeps the key when only pages or the schedule change', async () => {
  const {wx, f} = setup();
  const r = await wx(['kb', 'source', 'configure', 'Confluence', '--page', '6']);
  assert.equal(r.code, 0, r.stderr);
  const put = f.cloudCalls().find((c) => c.path.endsWith('/configure'));
  assert.equal(put.body.config.confluence.apiKey, 'ATATT-secret');
  assert.deepEqual(put.body.config.confluence.pages, {enabled: ['6'], disabled: []});
});

test('gdrive create is refused', async () => {
  const {wx, f} = setup();
  const r = await wx(['kb', 'source', 'create', 'G', '--type', 'gdrive']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /WIM console/);
  assert.equal(f.cloudCalls().length, 0);
});

test('browse sends describe with the space', async () => {
  const {wx, f} = setup();
  assert.equal((await wx(['kb', 'source', 'browse', 'Confluence'])).code, 0);
  assert.deepEqual(f.cloudCalls().find((c) => c.path.endsWith('/describe')).body, {
    parameters: {confluence: {spaces: {}}},
  });
  await wx(['kb', 'source', 'browse', 'Confluence', '--space', '7']);
  assert.deepEqual(
    f
      .cloudCalls()
      .filter((c) => c.path.endsWith('/describe'))
      .at(-1).body,
    {parameters: {confluence: {pages: {spaceId: '7'}}}},
  );
  await wx(['kb', 'source', 'browse', 'Site']);
  assert.deepEqual(
    f
      .cloudCalls()
      .filter((c) => c.path.endsWith('/describe'))
      .at(-1).body,
    {parameters: {website: {discover: {url: 'https://x.com'}}}},
  );
});

test('sync --full sends syncType full; stop', async () => {
  const {wx, f} = setup();
  assert.equal((await wx(['kb', 'source', 'sync', 'Confluence', '--full'])).code, 0);
  assert.deepEqual(f.cloudCalls().find((c) => c.path.endsWith('/start-sync')).query, {syncType: 'full'});
  assert.equal((await wx(['kb', 'source', 'stop', 'Confluence'])).code, 0);
  assert.ok(f.cloudCalls().some((c) => c.path.endsWith('/stop-sync') && c.method === 'POST'));
});

test('clean and delete need --yes', async () => {
  const {wx, s} = setup();
  assert.equal((await wx(['kb', 'source', 'clean', 'Confluence'])).code, 64);
  assert.equal((await wx(['kb', 'source', 'delete', 'Site'])).code, 64);
  assert.equal((await wx(['kb', 'source', 'clean', 'Confluence', '--yes'])).code, 0);
  assert.equal((await wx(['kb', 'source', 'delete', 'Site', '--yes'])).code, 0);
  assert.equal(s.sources.length, 1);
});

test('status --watch stops when idle', async () => {
  const s = state();
  s.syncStatus = [
    {status: 'running', documentsStats: {completed: 1}},
    {status: 'running', documentsStats: {completed: 2}},
    {status: 'idle', documentsStats: {completed: 3}},
  ];
  const {wx, f} = setup(s);
  const r = await wx(['kb', 'source', 'status', 'Confluence', '--watch', '--every', '0'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.cloudCalls().filter((c) => c.path.endsWith('/sync-status')).length, 3);
  assert.match(r.stdout, /idle/);
});

test('logs passes level, search and limit; stats and clone', async () => {
  const {wx, f} = setup();
  assert.equal(
    (await wx(['kb', 'source', 'logs', 'Confluence', '--level', 'error', '--search', 'fail', '--limit', '5'])).code,
    0,
  );
  assert.deepEqual(f.cloudCalls().find((c) => c.path.endsWith('/sync-logs')).query, {
    logLevel: 'error',
    search: 'fail',
    limit: '5',
  });
  assert.match((await wx(['kb', 'source', 'stats', 'Confluence'], {output: 'text'})).stdout, /2 documents.*9 chunks/);
  assert.equal(
    JSON.parse((await wx(['kb', 'source', 'clone', 'Confluence'])).stdout).dataSourceId.startsWith('ds-'),
    true,
  );
});
