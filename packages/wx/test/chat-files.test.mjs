import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {groups as chatGroups} from '../src/commands/chat.mjs';
import {groups as fileGroups} from '../src/commands/file.mjs';
import {refuseSecretPath} from '../src/chat/lib.mjs';
import {fakeJwt, run, tempConfigDir} from './helpers.mjs';

const API = 'https://eu-1.stream.wildix.com/api/v1';
const STORAGE = 'https://storage.example.com/bucket/key?X-Amz-Signature=abc';
const CH = 'abcdefgh-ijkl-mnop-qrst-uvwxyz01';
const TOKEN = fakeJwt({email: 'me@example.com'});
const registry = {groups: {...chatGroups, ...fileGroups}};

// fetch that records the calls (raw bodies as they are) and answers in order.
function recorder(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect});
    const a = answers.shift() ?? {};
    const body = a.raw ?? (a.body === undefined ? '' : JSON.stringify(a.body));
    return new Response(body, {status: a.status ?? 200});
  };
  fn.calls = calls;
  return fn;
}

function setup() {
  const home = tempConfigDir();
  const env = {WILDIX_ID_TOKEN: TOKEN, HOME: home, WILDIX_CONFIG_DIR: path.join(home, '.wildix')};
  return {home, env, wx: (argv, options = {}) => run(argv, {env, registry, ...options})};
}

const uploadAnswers = (name) => [
  {body: {fsId: 'fs1', presignedUploadUrl: STORAGE}},
  {raw: ''},
  {body: {file: {fsId: 'fs1', name, size: 5, mime: 'text/plain', extra: 1}}},
];

test('file upload: the stream service gets the token, the presigned URL gets none', async () => {
  const {home, wx} = setup();
  const file = path.join(home, 'notes.txt');
  fs.writeFileSync(file, 'hello');
  const fetch = recorder(...uploadAnswers('notes.txt'));
  const r = await wx(['file', 'upload', CH, file], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {fsId: 'fs1', name: 'notes.txt', size: 5, mime: 'text/plain'});
  const [ask, put, info] = fetch.calls;
  assert.equal(`${ask.method} ${ask.url}`, `POST ${API}/channels/${CH}/files`);
  assert.deepEqual(JSON.parse(ask.body), {name: 'notes.txt'});
  assert.equal(ask.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(`${put.method} ${put.url}`, `PUT ${STORAGE}`);
  assert.equal(put.headers.authorization, undefined);
  assert.equal(put.headers['content-type'], 'text/plain');
  assert.equal(Buffer.from(put.body).toString(), 'hello');
  assert.equal(put.redirect, 'error');
  assert.equal(`${info.method} ${info.url}`, `GET ${API}/channels/${CH}/files/fs1`);
});

test('chat send --file uploads and attaches', async () => {
  const {home, wx} = setup();
  const file = path.join(home, 'a.txt');
  fs.writeFileSync(file, 'hello');
  const fetch = recorder(...uploadAnswers('a.txt'), {body: {message: {messageId: 'm1'}}});
  const r = await wx(['chat', 'send', CH, '', '--file', file], {fetch});
  assert.equal(r.code, 0, r.stderr);
  const send = fetch.calls[3];
  assert.equal(`${send.method} ${send.url}`, `POST ${API}/channels/${CH}/messages`);
  assert.deepEqual(JSON.parse(send.body), {attachments: [{fsId: 'fs1', name: 'a.txt', size: 5, mime: 'text/plain'}]});
});

test('an upload refuses secrets and credential folders before any request', async () => {
  const {home, env, wx} = setup();
  const files = [
    path.join(home, '.env'),
    path.join(home, 'server.pem'),
    path.join(home, 'my-secret.txt'),
    path.join(home, '.ssh', 'notes.txt'),
    path.join(home, '.wildix', 'tokens', 'x.json'),
    path.join(home, '.npmrc'),
  ];
  for (const f of files) {
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, 'x');
    assert.throws(() => refuseSecretPath(f, env), /Refusing/, f);
    const fetch = recorder();
    const r = await wx(['file', 'upload', CH, f], {fetch});
    assert.equal(r.code, 64, f);
    assert.equal(fetch.calls.length, 0, f);
  }
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'innocent'));
  assert.throws(() => refuseSecretPath(path.join(home, 'innocent', 'notes.txt'), env), /credentials folder/);
  assert.doesNotThrow(() => refuseSecretPath(path.join(home, 'report.pdf'), env));
  const missing = await wx(['file', 'upload', CH, path.join(home, 'nope.txt')], {fetch: recorder()});
  assert.equal(missing.code, 64);
});

test('an upload link that is not https is refused', async () => {
  const {home, wx} = setup();
  const file = path.join(home, 'a.txt');
  fs.writeFileSync(file, 'hello');
  const fetch = recorder({body: {fsId: 'fs1', presignedUploadUrl: 'http://storage.example.com/x'}});
  const r = await wx(['file', 'upload', CH, file], {fetch});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not https/);
  assert.equal(fetch.calls.length, 1);
});

test('file info and download-url', async () => {
  const {wx} = setup();
  let fetch = recorder({body: {file: {fsId: 'fs1'}}});
  let r = await wx(['file', 'info', CH, 'fs1'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(`${fetch.calls[0].method} ${fetch.calls[0].url}`, `GET ${API}/channels/${CH}/files/fs1`);
  fetch = recorder({body: {presignedDownloadUrl: STORAGE}});
  r = await wx(['file', 'download-url', CH, `https://app.x-bees.com/inbox/${CH}/m1`, 'fs1'], {fetch});
  assert.equal(fetch.calls[0].url, `${API}/channels/${CH}/messages/m1/files/fs1/download-url`);
  assert.equal((await wx(['file', 'info', CH, '../x'], {fetch: recorder()})).code, 64);
});

test('file download saves to --to without a token to the storage, and never overwrites', async () => {
  const {home, wx} = setup();
  const to = path.join(home, 'out.bin');
  const fetch = recorder({body: {presignedDownloadUrl: STORAGE}}, {raw: 'binary-data'});
  const r = await wx(['file', 'download', CH, 'm1', 'fs1', '--to', to], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {ok: true, file: to, bytes: 11});
  assert.equal(fs.readFileSync(to, 'utf8'), 'binary-data');
  assert.equal(fetch.calls[0].url, `${API}/channels/${CH}/messages/m1/files/fs1/download-url?download=1`);
  assert.equal(fetch.calls[1].url, STORAGE);
  assert.equal(fetch.calls[1].headers.authorization, undefined);
  assert.deepEqual(
    fs.readdirSync(home).filter((f) => f.startsWith('.download')),
    [],
  );

  const again = recorder();
  const exists = await wx(['file', 'download', CH, 'm1', 'fs1', '--to', to], {fetch: again});
  assert.equal(exists.code, 64);
  assert.match(exists.stderr, /exists already/);
  assert.equal(again.calls.length, 0);
  assert.equal((await wx(['file', 'download', CH, 'm1', 'fs1'], {fetch: recorder()})).code, 64);
  assert.equal(
    (await wx(['file', 'download', CH, 'm1', 'fs1', '--to', path.join(home, 'no', 'dir', 'x')], {fetch: recorder()}))
      .code,
    64,
  );
});
