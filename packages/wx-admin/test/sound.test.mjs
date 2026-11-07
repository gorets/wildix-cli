import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {groups} from '../src/commands/sound.mjs';
import {run, tempConfigDir} from './helpers.mjs';

process.env.TZ = 'UTC'; // local times in the text are UTC here

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

const entry = (p, isDir, extra = {}) => ({
  name: path.basename(p).replace(/\.\w+$/, ''),
  path: p,
  size: isDir ? 0 : 4604,
  isDir,
  isDefault: false,
  modified: 1794051803,
  formats: [],
  ...extra,
});

// A PBX with sound folders, as the live one answers: a folder lists ".." first; a missing folder is a 400.
function fakePbx() {
  const items = [
    entry('MusicOnHold', true, {isDefault: true}),
    entry('RingTones', true, {isDefault: true}),
    entry('RingTones/Ring1.wav', false, {isDefault: true, size: 32920}),
    entry('prompts', true),
    entry('prompts/welcome.opus', false),
  ];
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), {status});
  const ok = () => reply(200, {type: 'result', result: 'Success'});
  const fetch = async (url, init) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const call = {method: init.method, path: p, encoded: u.pathname};
    if (init.body instanceof FormData) {
      call.form = {};
      for (const [k, v] of init.body.entries())
        call.form[k] = typeof v === 'string' ? v : {name: v.name, type: v.type, text: await v.text()};
    } else if (init.body) call.body = JSON.parse(init.body);
    calls.push(call);
    const folder = p.match(/^\/api\/v1\/Sounds\/(?:(.+)\/)?$/)?.[1] ?? '';
    if (init.method === 'GET') {
      if (folder && !items.some((i) => i.isDir && i.path === folder))
        return reply(400, {type: 'error', reason: 'Directory not found.'});
      const inside = items.filter(
        (i) => (i.path.includes('/') ? i.path.slice(0, i.path.lastIndexOf('/')) : '') === folder,
      );
      return reply(200, {
        type: 'result',
        result: {records: [...(folder ? [entry('/', true, {name: '..'})] : []), ...inside]},
      });
    }
    if (init.method === 'POST' && p === '/api/v1/Sounds/') {
      const name = call.form.file.name.replace(/\.\w+$/, '');
      items.push(entry(`${call.form.directory ? `${call.form.directory}/` : ''}${name}.opus`, false));
      return ok();
    }
    if (init.method === 'POST' && p === '/api/v1/Sounds/directory/') {
      items.push(entry(call.body.path, true));
      return ok();
    }
    if (init.method === 'DELETE') {
      const target = p.replace(/^\/api\/v1\/Sounds\/(directory\/)?/, '').replace(/\/$/, '');
      for (let i = items.length - 1; i >= 0; i -= 1)
        if (items[i].path === target || items[i].path.startsWith(`${target}/`)) items.splice(i, 1);
      return ok();
    }
    if (init.method === 'PUT') return ok();
    return reply(404, {type: 'error', reason: '404 Not Found'});
  };
  return {fetch, calls, items};
}

const registry = {groups};
const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry, ...options});

test('list: folders first, without ".."; size and local time', async () => {
  const pbx = fakePbx();
  const top = await wx(pbx, ['sound', 'list'], {output: 'text'});
  assert.equal(top.code, 0, top.stderr);
  assert.equal(pbx.calls[0].path, '/api/v1/Sounds/');
  assert.equal(
    top.stdout,
    'MusicOnHold/    2026-11-07 11:43  default\nprompts/        2026-11-07 11:43\nRingTones/      2026-11-07 11:43  default\n',
  );
  const sub = await wx(pbx, ['sound', 'list', 'RingTones/'], {output: 'text'});
  assert.equal(pbx.calls.at(-1).path, '/api/v1/Sounds/RingTones/');
  assert.equal(sub.stdout, 'RingTones/Ring1.wav  32 KB  2026-11-07 11:43  default\n');
  assert.equal((await wx(pbx, ['sound', 'list', 'nope'])).code, 1);
  assert.equal((await wx(pbx, ['sound', 'list', 'a/../b'])).code, 64);
});

test('upload: multipart with the file and the folder; --name; credentials and bad names refused', async () => {
  const pbx = fakePbx();
  const dir = tempConfigDir();
  const file = path.join(dir, 'hello world.wav');
  fs.writeFileSync(file, 'RIFF-data');
  assert.equal((await wx(pbx, ['sound', 'upload', file])).code, 64, 'a space is not in a sound name');
  const r = await wx(pbx, ['sound', 'upload', file, '--to', 'prompts', '--name', 'hello_world'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.calls.at(-1), {
    method: 'POST',
    path: '/api/v1/Sounds/',
    encoded: '/api/v1/Sounds/',
    form: {file: {name: 'hello_world.wav', type: 'audio/wav', text: 'RIFF-data'}, directory: 'prompts'},
  });
  assert.equal(r.stdout, 'Uploaded prompts/hello_world (9 B)\n');
  const plain = path.join(dir, 'beep.mp3');
  fs.writeFileSync(plain, 'ID3');
  await wx(pbx, ['sound', 'upload', plain]);
  assert.deepEqual(pbx.calls.at(-1).form, {file: {name: 'beep.mp3', type: 'audio/mpeg', text: 'ID3'}, directory: ''});
  assert.equal((await wx(pbx, ['sound', 'upload', plain, '--to', 'bad-folder'])).code, 64);
  fs.writeFileSync(path.join(dir, 'id_rsa.wav'), 'key');
  const calls = pbx.calls.length;
  assert.equal((await wx(pbx, ['sound', 'upload', path.join(dir, 'id_rsa.wav')])).code, 64);
  assert.equal((await wx(pbx, ['sound', 'upload', path.join(dir, 'none.wav')])).code, 64);
  assert.equal(pbx.calls.length, calls);
});

test('rename and move: the route of a sound or of a folder, found in the parent folder', async () => {
  const pbx = fakePbx();
  const r = await wx(pbx, ['sound', 'rename', 'prompts/welcome', 'hello']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    pbx.calls.map((c) => `${c.method} ${c.path}`),
    ['GET /api/v1/Sounds/prompts/', 'PUT /api/v1/Sounds/prompts/welcome.opus/'],
  );
  assert.deepEqual(pbx.calls.at(-1).body, {name: 'hello'});
  await wx(pbx, ['sound', 'rename', 'prompts', 'ivr_prompts']);
  assert.equal(pbx.calls.at(-1).path, '/api/v1/Sounds/directory/prompts/');
  assert.deepEqual(pbx.calls.at(-1).body, {name: 'ivr_prompts'});
  assert.equal((await wx(pbx, ['sound', 'rename', 'prompts', 'bad name'])).code, 64);
  await wx(pbx, ['sound', 'move', 'prompts/welcome.opus', 'MusicOnHold/class1']);
  assert.deepEqual(pbx.calls.at(-1).body, {move: 'MusicOnHold/class1'});
  assert.equal((await wx(pbx, ['sound', 'move', 'prompts/none', 'MusicOnHold'])).code, 1);
});

test('delete needs --yes, refuses folders and default sounds; rmdir deletes a folder and says what was in it', async () => {
  const pbx = fakePbx();
  const before = pbx.calls.length;
  assert.equal((await wx(pbx, ['sound', 'delete', 'prompts/welcome'])).code, 64);
  assert.equal(pbx.calls.length, before);
  assert.equal((await wx(pbx, ['sound', 'delete', 'prompts', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['sound', 'delete', 'RingTones/Ring1', '--yes'])).code, 64);
  assert.ok(!pbx.calls.some((c) => c.method === 'DELETE'));
  const d = await wx(pbx, ['sound', 'delete', 'prompts/welcome', '--yes'], {output: 'text'});
  assert.equal(d.code, 0, d.stderr);
  assert.equal(pbx.calls.at(-1).method, 'DELETE');
  assert.equal(pbx.calls.at(-1).path, '/api/v1/Sounds/prompts/welcome.opus/');
  assert.equal((await wx(pbx, ['sound', 'mkdir', 'prompts/old'])).code, 0);
  assert.deepEqual(pbx.calls.at(-1), {
    method: 'POST',
    path: '/api/v1/Sounds/directory/',
    encoded: '/api/v1/Sounds/directory/',
    body: {path: 'prompts/old'},
  });
  assert.equal((await wx(pbx, ['sound', 'mkdir', 'wx-admin'])).code, 64);
  assert.equal((await wx(pbx, ['sound', 'rmdir', 'prompts'])).code, 64);
  assert.equal((await wx(pbx, ['sound', 'rmdir', 'MusicOnHold', '--yes'])).code, 64);
  const rm = await wx(pbx, ['sound', 'rmdir', 'prompts', '--yes'], {output: 'text'});
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal(pbx.calls.at(-1).path, '/api/v1/Sounds/directory/prompts/');
  assert.equal(rm.stdout, 'Deleted the folder prompts/ and the 1 sounds or folders in it\n');
  assert.ok(!pbx.items.some((i) => i.path.startsWith('prompts')));
});
