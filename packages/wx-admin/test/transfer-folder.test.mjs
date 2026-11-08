import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import crypto from 'node:crypto';
import {readExport, writeExport} from '../src/transfer/folder.mjs';
import {TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
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

const FK = 'fake-files';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function withFakeKind(t) {
  TRANSFER_KINDS[FK] = {};
  t.after(() => delete TRANSFER_KINDS[FK]);
}
const fileObj = (bytes, rel = 'files/wilma-skills/s/a.txt', hash = sha(bytes)) => ({
  name: 's',
  data: {files: [{$file: rel, sha256: hash, path: 'a.txt', name: 'a.txt'}]},
  files: {[rel]: bytes},
});

test('skill files round-trip with sha256', async (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  const bytes = Buffer.from([0, 1, 2, 255]);
  writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {[FK]: [fileObj(bytes)]}}});
  const f = path.join(dir, 'files/wilma-skills/s/a.txt');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${FK}.jsonl`), 'utf8')).files, undefined);
  const back = await readExport(ctx(), dir);
  assert.deepEqual(back.kinds[FK][0].files, {'files/wilma-skills/s/a.txt': bytes});
});

test('$file outside the folder is refused', async (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {[FK]: [fileObj(Buffer.from('x'))]}}});
  const line = {name: 's', data: {f: {$file: '../x', sha256: sha(Buffer.from('x'))}}};
  fs.writeFileSync(path.join(dir, `${FK}.jsonl`), `${JSON.stringify(line)}\n`);
  await assert.rejects(readExport(ctx(), dir), (e) => e.name === 'UsageError' && /fake-files\/s/.test(e.message));
  for (const bad of ['/etc/hosts', 'files/../../x']) {
    line.data.f.$file = bad;
    fs.writeFileSync(path.join(dir, `${FK}.jsonl`), `${JSON.stringify(line)}\n`);
    await assert.rejects(readExport(ctx(), dir), /not a path inside/);
  }
});

test('$file through a symbolic link is refused', async (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  const bytes = Buffer.from('x');
  writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {[FK]: [fileObj(bytes)]}}});
  const real = path.join(dir, 'files/wilma-skills/s/a.txt');
  const moved = path.join(tempConfigDir(), 'moved.txt');
  fs.renameSync(real, moved);
  fs.symlinkSync(moved, real);
  await assert.rejects(readExport(ctx(), dir), /symbolic link/);
});

test('$file with a wrong sha256 is refused', async (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {[FK]: [fileObj(Buffer.from('x'))]}}});
  fs.writeFileSync(path.join(dir, 'files/wilma-skills/s/a.txt'), 'tampered');
  await assert.rejects(readExport(ctx(), dir), /sha256/);
});

test('manifest keeps company and env, and warnings only when there are any', () => {
  const dir = path.join(tempConfigDir(), 'exp');
  writeExport(ctx(), dir, {
    source: {...SOURCE, company: 'demo', env: 'stage'},
    portable: {...portable(), warnings: [{kind: 'users', name: '1', path: 'p', text: 't'}]},
  });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(m.source.company, 'demo');
  assert.equal(m.source.env, 'stage');
  assert.equal(m.warnings.length, 1);
  const dir2 = path.join(tempConfigDir(), 'exp2');
  writeExport(ctx(), dir2, {source: SOURCE, portable: portable()});
  const m2 = JSON.parse(fs.readFileSync(path.join(dir2, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(m2.source), ['host', 'wms', 'exportedAt']);
  assert.equal('warnings' in m2, false);
});

const exportOf = (obj) => ({source: SOURCE, portable: {kinds: {[FK]: [obj]}}});
const refused = (re) => (e) => e.name === 'UsageError' && /fake-files\/s/.test(e.message) && re.test(e.message);

test('write refuses a marker without bytes, naming kind, name and path', (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  const o = fileObj(Buffer.from('x'));
  delete o.files;
  assert.throws(() => writeExport(ctx(), dir, exportOf(o)), refused(/files\/wilma-skills\/s\/a\.txt/));
});

test('write refuses bytes whose sha256 differs from the marker', (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  const o = fileObj(Buffer.from('x'), undefined, sha(Buffer.from('y')));
  assert.throws(() => writeExport(ctx(), dir, exportOf(o)), refused(/sha256/));
});

test('write refuses a files key that no marker names', (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  const o = fileObj(Buffer.from('x'));
  o.files['files/wilma-skills/s/extra.txt'] = Buffer.from('z');
  assert.throws(() => writeExport(ctx(), dir, exportOf(o)), refused(/extra\.txt/));
});

test('write refuses paths outside the folder and writes nothing outside', (t) => {
  withFakeKind(t);
  const root = tempConfigDir();
  for (const bad of ['../x', 'files/../../x', '/tmp/wx-admin-abs-x']) {
    const dir = path.join(root, 'exp');
    const o = fileObj(Buffer.from('x'), bad);
    assert.throws(() => writeExport(ctx(), dir, exportOf(o)), refused(/not a path inside/));
    assert.equal(fs.existsSync(path.join(root, 'x')), false);
    assert.equal(fs.existsSync('/tmp/wx-admin-abs-x'), false);
  }
});

test('a refused export leaves the folder absent or empty', (t) => {
  withFakeKind(t);
  const root = tempConfigDir();
  const good = fileObj(Buffer.from('a'));
  const bad = {...fileObj(Buffer.from('b'), 'files/wilma-skills/t/b.txt', sha(Buffer.from('c'))), name: 't'};
  const dir = path.join(root, 'exp');
  assert.throws(() => writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {[FK]: [good, bad]}}}), /sha256/);
  assert.equal(fs.existsSync(dir), false);
  fs.mkdirSync(path.join(root, 'empty'));
  assert.throws(
    () => writeExport(ctx(), path.join(root, 'empty'), {source: SOURCE, portable: {kinds: {[FK]: [good, bad]}}}),
    /sha256/,
  );
  assert.deepEqual(fs.readdirSync(path.join(root, 'empty')), []);
});

test('a $file marker without a sha256 is refused on write and on read', async (t) => {
  withFakeKind(t);
  const root = tempConfigDir();
  const o = {name: 's', data: {f: {$file: '../x'}}};
  assert.throws(() => writeExport(ctx(), path.join(root, 'exp'), exportOf(o)), refused(/\.\.\/x/));
  const dir = path.join(root, 'exp2');
  writeExport(ctx(), dir, exportOf({name: 's', data: {}}));
  fs.writeFileSync(path.join(dir, `${FK}.jsonl`), `${JSON.stringify(o)}\n`);
  await assert.rejects(readExport(ctx(), dir), refused(/\.\.\/x/));
});

test('a kind whose file name looks like a secret reads back; a kind file that is a link is refused', async () => {
  const dir = path.join(tempConfigDir(), 'exp');
  const secrets = [{name: 'openai', data: {name: 'openai', value: {$secret: 'value'}}}];
  writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {'wilma-secrets': secrets}}});
  assert.deepEqual((await readExport(ctx(), dir)).kinds, {'wilma-secrets': secrets});
  const file = path.join(dir, 'wilma-secrets.jsonl');
  const moved = path.join(tempConfigDir(), 'moved.jsonl');
  fs.renameSync(file, moved);
  fs.symlinkSync(moved, file);
  await assert.rejects(readExport(ctx(), dir), /Not a file/);
  fs.rmSync(file);
  fs.linkSync(moved, file);
  await assert.rejects(readExport(ctx(), dir), /other hard links/);
});

test('a skill file named like a secret reads back (its name is the source skill’s, not a file of this disk)', async (t) => {
  withFakeKind(t);
  const dir = path.join(tempConfigDir(), 'exp');
  const bytes = Buffer.from('notes');
  const rel = 'files/wilma-skills/s/secret-notes.md';
  writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {[FK]: [fileObj(bytes, rel)]}}});
  assert.deepEqual((await readExport(ctx(), dir)).kinds[FK][0].files, {[rel]: bytes});
  // the other checks stay: a link in its place is refused
  const full = path.join(dir, rel);
  const moved = path.join(tempConfigDir(), 'moved.md');
  fs.renameSync(full, moved);
  fs.linkSync(moved, full);
  await assert.rejects(readExport(ctx(), dir), /other hard links/);
});

test('an object holding the mask of a secret is refused, named with its path', async () => {
  const dir = path.join(tempConfigDir(), 'exp');
  const data = {name: 'openai', description: 'd', headers: [{name: 'X-Key', value: '********'}]};
  writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {'wilma-secrets': [{name: 'openai', data}]}}});
  await assert.rejects(
    readExport(ctx(), dir),
    (e) => e.name === 'UsageError' && /wilma-secrets\/openai: headers\[0\]\.value holds the mask/.test(e.message),
  );
});

test('the mask is a whole value or a masked URI query value: other asterisks are text', async () => {
  const read = async (data) => {
    const dir = path.join(tempConfigDir(), 'exp');
    writeExport(ctx(), dir, {source: SOURCE, portable: {kinds: {'wilma-agents': [{name: 'bot', data}]}}});
    return readExport(ctx(), dir);
  };
  const instructions = 'Never say the code. ********** marks a section; ******** too.';
  const ok = await read({name: 'bot', engine: {ai: {instructions}}, voice: 'tts://v1?model=a&apiKey=secrets:S1'});
  assert.equal(ok.kinds['wilma-agents'][0].data.engine.ai.instructions, instructions);
  await assert.rejects(read({name: 'bot', voice: 'tts://v1?model=a&apiKey=********'}), /voice holds the mask/);
  await assert.rejects(read({name: 'bot', url: 'https://h.example/in?token=********&x=1'}), /url holds the mask/);
  await assert.rejects(read({name: 'bot', headers: {'********': 'x'}}), /headers\.\*{8} holds the mask/);
});
