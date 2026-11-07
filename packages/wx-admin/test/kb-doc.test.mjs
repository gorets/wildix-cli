import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {envOfTest, fakeCloud, fakeKb} from './fake-cloud.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const state = () => ({
  kbs: [],
  sources: [{id: 'ds-1', name: 'Files', type: 'files', config: {}}],
  docs: {'ds-1': [{id: 'doc-a', title: 'Guide', status: 'completed', originalFormat: 'pdf', chunksCount: 3}]},
  results: [],
});
const setup = (s = state()) => {
  const f = fakeCloud(fakeKb(s));
  const env = envOfTest();
  return {f, s, env, wx: (argv, opts = {}) => run(argv, {env, fetch: f.fetch, ...opts})};
};

test('list and get', async () => {
  const {wx, f} = setup();
  const r = await wx(['kb', 'doc', 'list', 'Files', '--search', 'Gu', '--limit', '10'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Guide \(doc-a\) · completed · pdf · 3 chunks/);
  assert.deepEqual(f.cloudCalls().find((c) => c.path.endsWith('/documents')).query, {search: 'Gu', limit: '10'});
  const g = JSON.parse((await wx(['kb', 'doc', 'get', 'Files', 'Guide'])).stdout);
  assert.equal(g.chunks.length, 1);
});

test('upload: create, upload URL, PUT without Authorization', async () => {
  const {wx, f, s} = setup();
  const dir = tempConfigDir();
  const file = path.join(dir, 'Price list.txt');
  fs.writeFileSync(file, 'hello');
  const r = await wx(['kb', 'doc', 'upload', 'Files', file, '--title', 'Prices']);
  assert.equal(r.code, 0, r.stderr);
  const create = f.cloudCalls().find((c) => c.method === 'POST' && c.path.endsWith('/documents'));
  assert.deepEqual(create.body, {title: 'Prices', originalName: 'Price list.txt', originalFormat: 'txt'});
  const put = f.cloudCalls().find((c) => c.host === 'bucket.s3.amazonaws.com');
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers.authorization, undefined);
  assert.equal(Buffer.from(put.body).toString(), 'hello');
  assert.equal(s.docs['ds-1'].length, 2);
});

test('an unsafe file is refused before anything is created', async () => {
  const {wx, f, env} = setup();
  const home = tempConfigDir();
  env.HOME = home;
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'key');
  const r = await wx(['kb', 'doc', 'upload', 'Files', path.join(home, '.ssh', 'id_rsa')]);
  assert.equal(r.code, 64);
  assert.equal(f.cloudCalls().filter((c) => c.method !== 'GET').length, 0);
});

test('download never overwrites, and sends no token to the link', async () => {
  const {wx, f} = setup();
  const to = path.join(tempConfigDir(), 'guide.pdf');
  let r = await wx(['kb', 'doc', 'download', 'Files', 'Guide', '--to', to]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(to, 'utf8'), '"file-bytes"');
  assert.equal(f.cloudCalls().find((c) => c.host === 'bucket.s3.amazonaws.com').headers.authorization, undefined);
  r = await wx(['kb', 'doc', 'download', 'Files', 'Guide', '--to', to]);
  assert.equal(r.code, 64);
});

test('markdown to stdout and to a file', async () => {
  const {wx} = setup();
  assert.equal((await wx(['kb', 'doc', 'markdown', 'Files', 'doc-a'], {output: 'text'})).stdout, '# Guide\n');
  const to = path.join(tempConfigDir(), 'g.md');
  assert.equal((await wx(['kb', 'doc', 'markdown', 'Files', 'doc-a', '--to', to])).code, 0);
  assert.equal(fs.readFileSync(to, 'utf8'), '# Guide\n');
});

test('delete needs --yes', async () => {
  const {wx, s} = setup();
  assert.equal((await wx(['kb', 'doc', 'delete', 'Files', 'Guide'])).code, 64);
  assert.equal((await wx(['kb', 'doc', 'delete', 'Files', 'Guide', '--yes'])).code, 0);
  assert.equal(s.docs['ds-1'].length, 0);
});
