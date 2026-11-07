import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {groups} from '../src/commands/records.mjs';
import {run, tempConfigDir} from './helpers.mjs';

process.env.TZ = 'UTC'; // local times in the text are UTC here

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

const CALL = {
  id: '914',
  start: '2026-03-31 11:14:47',
  answer: '2026-03-31 11:14:50',
  end: '2026-03-31 11:15:47',
  src: '201',
  dst: '0039021234',
  from_number: '201',
  to_number: '0039021234',
  from_name: 'Desk',
  to_name: '',
  billsec: '57',
  duration: '60',
  disposition: 'ANSWERED',
  type: 'call',
  timezone: '+0200',
  lastapp: 'Dial',
  attachments: {
    vm: [],
    faxes: [],
    recordings: [
      {
        url: 'spoolview/recordings/2026.03.31/11/14/rec-[pbx]-0.wav',
        time: 1774948487,
        source: '201',
        destination: '0039021234',
      },
      {url: 'spoolview/recordings/2026.03.31/11/14/rec-[pbx]-1.wav'},
    ],
  },
};
const VM = {
  msg_id: 'msg1793461304-1234',
  path: '201/INBOX/msg1793461304-1234.mp3',
  origtime: '1793461304',
  duration: '7',
  folder: 'INBOX',
  callerid: '"Ann" <0039021234>',
  origmailbox: '201',
};

// A PBX: /api/v1 answers wrapped as the PBX does; /spoolview/recordings/ redirects to a storage link; /spoolview/voicemail/
// answers the bytes. Every request is recorded (method, URL, authorization, JSON body).
function fakePbx({
  history = [CALL],
  voicemails = [VM],
  task = {status: 'success', path: 'https://storage.example/batch.zip?X-Amz-Signature=abc'},
} = {}) {
  const calls = [];
  const reply = (status, body, headers = {}) =>
    new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), {status, headers});
  const result = (r) => reply(200, {type: 'result', result: r});
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({
      method: init.method,
      url: u,
      path: decodeURIComponent(u.pathname),
      authorization: init.headers?.authorization,
      redirect: init.redirect,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const p = u.pathname;
    if (u.host === 'storage.example')
      return reply(200, Buffer.from(p.endsWith('.zip') ? 'PK-zip' : 'RIFF-wav'), {
        'content-type': 'application/octet-stream',
      });
    if (p.startsWith('/spoolview/recordings/'))
      return reply(302, '', {location: `https://storage.example/rec/${p.split('/').pop()}?sig=1`});
    if (p.startsWith('/spoolview/voicemail/'))
      return reply(200, Buffer.from('ID3-mp3'), {'content-type': 'audio/mpeg'});
    if (p === '/api/v1/PBX/CallHistory/') {
      const id = u.searchParams.get('filter[id]');
      const records = id ? history.filter((c) => c.id === id) : history;
      return result({total: id ? records.length : 889, records});
    }
    if (/^\/api\/v1\/User\/\d+\/CallHistory\/$/.test(p)) return result({total: 1, records: history});
    if (p === '/api/v1/PBX/recordings/')
      return result({
        items: [{path: '/spoolview/recordings/2026.11.03-18.18.48-201-0.wav', created: 1793722728, size: 44}],
        nextPage: '/api/v1/pbx/recordings/?count=1&start=eyJuYW1lIjoiYSJ9',
      });
    if (p === '/api/v1/PBX/recordings/download/' && init.method === 'POST')
      return result({id: 'task-1', ...JSON.parse(init.body)});
    if (p === '/api/v1/PBX/recordings/download/task-1') return result(task);
    if (p === '/api/v1/VoiceMail/' && init.method === 'GET')
      return result({total: String(voicemails.length), records: voicemails});
    if (p.startsWith('/api/v1/VoiceMail/') && init.method === 'DELETE')
      return result({errors: [], changed: p.split('/')[4].split(',').length});
    return reply(404, {type: 'error', reason: '404 Not Found'});
  };
  return {fetch, calls};
}

const registry = {groups};
const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry, ...options});

test('history: filters go to the query, newest first; text in local time with the talk time', async () => {
  const pbx = fakePbx();
  const r = await wx(pbx, [
    'records',
    'history',
    '--since',
    '2026-11-01',
    '--until',
    '2026-11-04 19:50',
    '--disposition',
    'no-answer',
    '--type',
    'call',
    '--search',
    '20',
    '--filter',
    'src=201',
    '--count',
    '10',
    '--offset',
    '20',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const q = pbx.calls[0].url.searchParams;
  assert.equal(pbx.calls[0].path, '/api/v1/PBX/CallHistory/');
  assert.equal(pbx.calls[0].authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.fromEntries(q), {
    count: '10',
    start: '20',
    sort: 'id',
    dir: 'DESC',
    search: '20',
    'filter[start][from]': '2026-11-01 00:00:00',
    'filter[start][to]': '2026-11-04 19:50:59',
    'filter[disposition]': 'NO ANSWER',
    'filter[type]': 'call',
    'filter[src]': '201',
  });
  assert.equal(JSON.parse(r.stdout).total, 889);
  const text = await wx(pbx, ['records', 'history'], {output: 'text'});
  assert.equal(
    text.stdout,
    '914  2026-03-31 09:14  201 Desk  →  0039021234  ANSWERED  0:57\n1 of 889 calls (--offset for more)\n',
  );
  assert.equal(new URL(pbx.calls.at(-1).url).searchParams.get('count'), '50');
  assert.equal((await wx(pbx, ['records', 'history', '--since', '1 Nov'])).code, 64);
  assert.equal((await wx(pbx, ['records', 'history', '--filter', 'start][from=x'])).code, 64);
  assert.equal((await wx(pbx, ['records', 'history', '--disposition', 'NO ANSWER'])).code, 64);
  assert.equal((await wx(pbx, ['records', 'history', '--count', '5000'])).code, 64);
});

test('history-user: the history of one extension', async () => {
  const pbx = fakePbx();
  const r = await wx(pbx, ['records', 'history-user', '201', '--asc']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.calls[0].path, '/api/v1/User/201/CallHistory/');
  assert.equal(pbx.calls[0].url.searchParams.get('dir'), 'ASC');
  assert.equal((await wx(pbx, ['records', 'history-user', '../x'])).code, 64);
});

test('call: looked up in the whole history by filter[id]; text lists its recordings', async () => {
  const pbx = fakePbx();
  const r = await wx(pbx, ['records', 'call', '914'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.calls[0].url.searchParams.get('filter[id]'), '914');
  assert.match(r.stdout, /^call 914 {2}call {2}ANSWERED$/m);
  assert.match(r.stdout, /^start {5}2026-03-31 09:14:47$/m);
  assert.match(r.stdout, /^duration {2}1:00 \(talk 0:57\)$/m);
  assert.match(r.stdout, /^recording 2026\.03\.31\/11\/14\/rec-\[pbx\]-0\.wav$/m);
  assert.equal((await wx(pbx, ['records', 'call', '1'])).code, 1);
  assert.equal((await wx(pbx, ['records', 'call', 'x'])).code, 64);
});

test('recordings: unix-second range, the token of the next page', async () => {
  const pbx = fakePbx();
  const r = await wx(
    pbx,
    [
      'records',
      'recordings',
      '--since',
      '2026-11-03',
      '--until',
      '2026-11-03',
      '--count',
      '1',
      '--page',
      'eyJuYW1lIjoiYiJ9',
    ],
    {output: 'text'},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.fromEntries(pbx.calls[0].url.searchParams), {
    count: '1',
    start: 'eyJuYW1lIjoiYiJ9',
    from: String(Date.UTC(2026, 10, 3) / 1000),
    to: String(Date.UTC(2026, 10, 3, 23, 59, 59) / 1000),
  });
  assert.equal(r.stdout, '2026-11-03 16:18  44 B  2026.11.03-18.18.48-201-0.wav\nmore: --page eyJuYW1lIjoiYSJ9\n');
  assert.equal((await wx(pbx, ['records', 'recordings', '--page', 'a&b=c'])).code, 64);
});

test('recording-download: from the PBX root, the storage link followed without the credentials; never overwrites', async () => {
  const pbx = fakePbx();
  const dir = tempConfigDir();
  const file = path.join(dir, 'rec.wav');
  const r = await wx(pbx, [
    'records',
    'recording-download',
    '/spoolview/recordings/2026.11.03-18.18.48-201-0.wav',
    '--to',
    file,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), 'RIFF-wav');
  const [first, second] = pbx.calls;
  assert.equal(
    first.url.origin + first.url.pathname,
    'https://demo.wildixin.com/spoolview/recordings/2026.11.03-18.18.48-201-0.wav',
  );
  assert.equal(first.authorization, `Bearer ${KEY}`);
  assert.equal(first.redirect, 'manual');
  assert.equal(second.url.host, 'storage.example');
  assert.equal(second.authorization, undefined);
  assert.equal(second.redirect, 'error');
  const before = pbx.calls.length;
  assert.equal(
    (await wx(pbx, ['records', 'recording-download', '2026.11.03-18.18.48-201-0.wav', '--to', file])).code,
    64,
  );
  assert.equal(pbx.calls.length, before, 'refused before anything is fetched');
  assert.equal(fs.readFileSync(file, 'utf8'), 'RIFF-wav');
  assert.equal(
    (await wx(pbx, ['records', 'recording-download', 'x.wav', '--to', path.join(dir, '.hidden', 'x.wav')])).code,
    64,
  );
  assert.equal(
    (await wx(pbx, ['records', 'recording-download', '../../etc/passwd', '--to', path.join(dir, 'p')])).code,
    64,
  );
  assert.equal((await wx(pbx, ['records', 'recording-download', 'x.wav'])).code, 64);
});

test('recording-download by call id: the first recording, or --index', async () => {
  const pbx = fakePbx();
  const dir = tempConfigDir();
  const r = await wx(pbx, ['records', 'recording-download', '914', '--to', path.join(dir, 'a.wav')]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /has 2 recordings/);
  assert.equal(pbx.calls[1].path, '/spoolview/recordings/2026.03.31/11/14/rec-[pbx]-0.wav');
  await wx(pbx, ['records', 'recording-download', '914', '--index', '2', '--to', path.join(dir, 'b.wav')]);
  assert.equal(pbx.calls.at(-2).path, '/spoolview/recordings/2026.03.31/11/14/rec-[pbx]-1.wav');
  assert.equal(
    (await wx(pbx, ['records', 'recording-download', '914', '--index', '3', '--to', path.join(dir, 'c.wav')])).code,
    64,
  );
});

test('recordings-batch: a task for the range, polled until it has a link; the archive saved without credentials', async () => {
  const pbx = fakePbx();
  const dir = tempConfigDir();
  const file = path.join(dir, 'batch.zip');
  const r = await wx(pbx, [
    'records',
    'recordings-batch',
    '--since',
    '2026-11-03 18:18',
    '--until',
    '2026-11-03 18:18',
    '--to',
    file,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.calls[0].body, {
    from: Date.UTC(2026, 10, 3, 18, 18) / 1000,
    to: Date.UTC(2026, 10, 3, 18, 18, 59) / 1000,
  });
  assert.equal(pbx.calls[1].path, '/api/v1/PBX/recordings/download/task-1');
  assert.equal(pbx.calls[2].url.host, 'storage.example');
  assert.equal(pbx.calls[2].authorization, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), 'PK-zip');
  const text = await wx(pbx, ['records', 'recordings-batch', '--task', 'task-1'], {output: 'text'});
  assert.match(text.stdout, /ready/);
  assert.doesNotMatch(text.stdout, /Signature/);
  assert.equal((await wx(pbx, ['records', 'recordings-batch', '--since', '2026-11-03'])).code, 64);
  assert.equal((await wx(pbx, ['records', 'recordings-batch'])).code, 64);
  assert.equal((await wx(pbx, ['records', 'recordings-batch', '--task', 'a/b'])).code, 64);
});

test('recordings-batch: not ready within the wait', async () => {
  const pbx = fakePbx({task: {status: 'pending', path: ''}});
  const r = await wx(pbx, ['records', 'recordings-batch', '--task', 'task-1', '--wait-seconds', '0'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Task task-1: pending (check again with --task task-1)\n');
});

test('voicemails: filtered by mailbox and folder, the newest first', async () => {
  const pbx = fakePbx({
    voicemails: [
      VM,
      {...VM, msg_id: 'msg2', origtime: '1793461400', path: '202/Old/msg2.mp3', origmailbox: '202', folder: 'Old'},
    ],
  });
  const all = JSON.parse((await wx(pbx, ['records', 'voicemails'])).stdout);
  assert.deepEqual(
    all.records.map((v) => v.msg_id),
    ['msg2', VM.msg_id],
  );
  const one = JSON.parse((await wx(pbx, ['records', 'voicemails', '--mailbox', '201', '--folder', 'inbox'])).stdout);
  assert.deepEqual(
    one.records.map((v) => v.msg_id),
    [VM.msg_id],
  );
  const text = await wx(pbx, ['records', 'voicemails', '--mailbox', '201'], {output: 'text'});
  assert.equal(text.stdout, `2026-10-31 15:41  201  INBOX  0:07  "Ann" <0039021234>  ${VM.msg_id}\n`);
});

test('voicemail-download by msg_id or path; voicemail-delete needs --yes', async () => {
  const pbx = fakePbx();
  const dir = tempConfigDir();
  const r = await wx(pbx, ['records', 'voicemail-download', VM.msg_id, '--to', path.join(dir, 'vm.mp3')]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.calls[1].path, `/spoolview/voicemail/${VM.path}`);
  assert.equal(fs.readFileSync(path.join(dir, 'vm.mp3'), 'utf8'), 'ID3-mp3');
  assert.equal((await wx(pbx, ['records', 'voicemail-download', VM.path, '--to', path.join(dir, 'vm2.mp3')])).code, 0);
  assert.equal(
    (await wx(pbx, ['records', 'voicemail-download', 'msg-none', '--to', path.join(dir, 'vm3.mp3')])).code,
    1,
  );
  const before = pbx.calls.length;
  assert.equal((await wx(pbx, ['records', 'voicemail-delete', VM.msg_id])).code, 64);
  assert.equal(pbx.calls.length, before);
  const del = await wx(pbx, ['records', 'voicemail-delete', VM.msg_id, 'msg2', '--yes'], {output: 'text'});
  assert.equal(del.code, 0, del.stderr);
  assert.equal(pbx.calls.at(-1).method, 'DELETE');
  assert.equal(pbx.calls.at(-1).path, `/api/v1/VoiceMail/${VM.msg_id},msg2/`);
  assert.equal(del.stdout, 'Deleted 2 voicemails\n');
  assert.equal((await wx(pbx, ['records', 'voicemail-delete', 'a,b', '--yes'])).code, 64);
});
