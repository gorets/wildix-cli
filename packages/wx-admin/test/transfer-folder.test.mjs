import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {readExport, writeExport} from '../src/transfer/folder.mjs';
import {tempConfigDir} from './helpers.mjs';

const ctx = () => ({env: {WILDIX_CONFIG_DIR: tempConfigDir()}, cwd: os.tmpdir()});
const portable = (users = 2) => ({
  kinds: {
    dialplans: [{name: 'main', data: {name: 'main', numbers: [{number: '1', apps: []}]}}],
    users: Array.from({length: users}, (_, i) => ({
      name: String(100 + i),
      data: {extension: String(100 + i), name: `U ${i}`},
    })),
  },
  bound: [{kind: 'dialplans', name: 'main', path: 'x', found: 'host'}],
  external: [],
  errors: {queues: 'Access error'},
});
const SOURCE = {host: 'a.wildixin.com', wms: '7.11'};

test('writes one .jsonl per kind and a manifest without the serial; reads back what it wrote', async () => {
  const dir = path.join(tempConfigDir(), 'exp');
  const r = writeExport(ctx(), dir, {source: SOURCE, portable: portable()});
  assert.deepEqual(r.counts, {dialplans: 1, users: 2});
  assert.deepEqual(fs.readdirSync(dir).sort(), ['dialplans.jsonl', 'manifest.json', 'users.jsonl']);
  assert.equal(fs.readFileSync(path.join(dir, 'users.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.statSync(path.join(dir, 'users.jsonl')).mode & 0o777, 0o600);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(m.format, 'wx-admin-export/1');
  assert.deepEqual(m.kinds, {dialplans: 1, users: 2});
  assert.equal(m.source.host, 'a.wildixin.com');
  assert.deepEqual(m.errors, {queues: 'Access error'});
  const back = await readExport(ctx(), dir);
  assert.deepEqual(back.kinds, portable().kinds);
  assert.deepEqual(back.manifest.bound, portable().bound);
});

test('5000 users round-trip', async () => {
  const dir = path.join(tempConfigDir(), 'big');
  writeExport(ctx(), dir, {source: SOURCE, portable: portable(5000)});
  assert.equal((await readExport(ctx(), dir)).kinds.users.length, 5000);
});

test('a broken line is named, without its content', async () => {
  const dir = path.join(tempConfigDir(), 'broken');
  writeExport(ctx(), dir, {source: SOURCE, portable: portable()});
  fs.appendFileSync(path.join(dir, 'users.jsonl'), '{"name": "secret-thing", \n');
  await assert.rejects(
    readExport(ctx(), dir),
    (e) => /users\.jsonl:3 is not JSON/.test(e.message) && !e.message.includes('secret-thing'),
  );
});

test('refuses a used folder and a hidden folder', () => {
  const used = tempConfigDir();
  fs.writeFileSync(path.join(used, 'x'), '');
  assert.throws(() => writeExport(ctx(), used, {source: SOURCE, portable: portable()}), /not empty/);
  const c = ctx();
  const home = tempConfigDir();
  c.env.HOME = home;
  assert.throws(
    () => writeExport(c, path.join(home, '.hidden', 'exp'), {source: SOURCE, portable: portable()}),
    /hidden/i,
  );
  assert.ok(!fs.existsSync(path.join(home, '.hidden')), 'nothing is made before the refusal');
});

test('refuses a folder of another format, and a kind it does not know', async () => {
  const dir = tempConfigDir();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({format: 'other/1'}));
  await assert.rejects(readExport(ctx(), dir), /not a folder of wx-admin config export/);
  const d2 = path.join(tempConfigDir(), 'exp');
  writeExport(ctx(), d2, {source: SOURCE, portable: portable()});
  const m = JSON.parse(fs.readFileSync(path.join(d2, 'manifest.json'), 'utf8'));
  m.kinds['../x'] = 1;
  fs.writeFileSync(path.join(d2, 'manifest.json'), JSON.stringify(m));
  await assert.rejects(readExport(ctx(), d2), /Unknown kind/);
});
