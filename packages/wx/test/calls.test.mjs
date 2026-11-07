import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {groups} from '../src/commands/calls.mjs';
import {fakeJwt, run} from './helpers.mjs';

const env = {WILDIX_ID_TOKEN: fakeJwt({email: 'me@example.com'})};
const WDA = 'https://wda.wildix.com/v2';

// fetch that answers by "METHOD path" (path without the /v2 prefix and the query); records every call.
function routes(map) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const u = new URL(url);
    const r = map[`${init.method} ${u.pathname.replace(/^\/v2/, '')}`] ?? {status: 404, body: {message: 'not found'}};
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {status: r.status ?? 200});
  };
  fn.calls = calls;
  return fn;
}

const wx = (argv, fetch, opts = {}) => run(argv, {env, fetch, registry: {groups}, ...opts});

const historyCall = {
  id: 'it_x_1.2',
  flowIndex: 0,
  startTime: 1793956057000,
  endTime: 1793956179000,
  duration: 122,
  direction: 'INBOUND',
  callStatus: 'COMPLETED',
  caller: {name: 'Anna', phone: '+3902111', userExtension: '201'},
  callee: {phone: '+3902222'},
  attachments: [{recording: {fileName: 'a.mp3', url: 'https://pbx.example/a.mp3', start: 1, end: 2}}],
};

test('calls list posts the filter of the user call history', async () => {
  const fetch = routes({'POST /history/user/calls': {body: {calls: [historyCall]}}});
  const r = await wx(
    [
      'calls',
      'list',
      '--direction',
      'INBOUND',
      '--status',
      'MISSED',
      '--flag',
      'FAX',
      '--flag',
      'VOICEMAIL',
      '--from',
      '2026-11-01T00:00:00Z',
      '--to',
      '2026-11-07',
      '--search',
      'anna',
      '--tag',
      't1',
      '--has-attachment',
      '--user-direction',
      'INCOMING',
      '--limit',
      '20',
      '--offset',
      '40',
    ],
    fetch,
  );
  assert.equal(r.code, 0, r.stderr);
  const [call] = fetch.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${WDA}/history/user/calls`);
  assert.equal(call.headers.authorization, `Bearer ${env.WILDIX_ID_TOKEN}`);
  assert.deepEqual(call.body, {
    filter: {
      direction: 'INBOUND',
      status: 'MISSED',
      flags: ['FAX', 'VOICEMAIL'],
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-07',
      search: 'anna',
      tags: ['t1'],
      hasAttachment: true,
      userDirection: 'INCOMING',
    },
    limit: 20,
    offset: 40,
  });
  assert.deepEqual(JSON.parse(r.stdout), {calls: [historyCall]});
});

test('calls list --brief: one short object per call, the length from the start and the end', async () => {
  const fetch = routes({
    'POST /history/user/calls': {
      body: {calls: [historyCall, {id: 'c2', startTime: 0, duration: 7, caller: {userExtension: '300'}}]},
    },
  });
  const r = await wx(['calls', 'list', '--brief'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {filter: {}});
  assert.deepEqual(JSON.parse(r.stdout).calls, [
    {
      id: 'it_x_1.2',
      flowIndex: 0,
      start: '2026-11-06T09:07:37Z',
      durationSec: 122,
      direction: 'INBOUND',
      status: 'COMPLETED',
      from: 'Anna',
      to: '+3902222',
      transcriptionStatus: null,
      hasRecording: true,
    },
    {
      id: 'c2',
      flowIndex: null,
      start: '1970-01-01T00:00:00Z',
      durationSec: 7,
      direction: null,
      status: null,
      from: '300',
      to: null,
      transcriptionStatus: null,
      hasRecording: false,
    },
  ]);
});

test('calls list as text: one line per call', async () => {
  const fetch = routes({'POST /history/user/calls': {body: {calls: [historyCall]}}});
  const r = await wx(['calls', 'list'], fetch, {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /INBOUND\s+COMPLETED\s+Anna → \+3902222\s+2:02\s+recording\s+it_x_1\.2$/);
});

test('calls missed asks for the missed calls only', async () => {
  const fetch = routes({'POST /history/user/calls': {body: {calls: []}}});
  const r = await wx(['calls', 'missed', '--limit', '5'], fetch, {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {filter: {status: 'MISSED'}, limit: 5});
  assert.equal(r.stdout, 'No calls.\n');
  assert.equal((await wx(['calls', 'missed', '--status', 'COMPLETED'], fetch)).code, 64);
});

test('calls list refuses a limit, an offset, a direction or a time out of range before any request', async () => {
  const fetch = routes({});
  for (const args of [
    ['--limit', '101'],
    ['--limit', '0'],
    ['--offset', '-1'],
    ['--direction', 'UP'],
    ['--from', 'yesterday'],
    ['--flag', 'SMS'],
  ]) {
    const r = await wx(['calls', 'list', ...args], fetch);
    assert.equal(r.code, 64, args.join(' '));
  }
  assert.equal(fetch.calls.length, 0);
});

test('calls get: the call id and the flow (0 by default) go into the path', async () => {
  const fetch = routes({
    'GET /history/calls/it_x_1.2/flows/0': {body: {call: historyCall}},
    'GET /history/calls/it_x_1.2/flows/2': {body: {call: {}}},
  });
  const r = await wx(['calls', 'get', 'it_x_1.2'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {call: historyCall});
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal((await wx(['calls', 'get', 'it_x_1.2', '2'], fetch)).code, 0);
  assert.equal(fetch.calls[1].url, `${WDA}/history/calls/it_x_1.2/flows/2`);
  const text = await wx(['calls', 'get', 'it_x_1.2'], fetch, {output: 'text'});
  assert.match(text.stdout, /^From\s+Anna \(201\) \+3902111$/m);
});

test('calls refuse an unsafe call id or a flow that is not a number', async () => {
  const fetch = routes({});
  for (const args of [['a/b'], ['..'], ['x?y'], ['ok', 'x'], ['ok', '-1']])
    assert.equal((await wx(['calls', 'get', ...args], fetch)).code, 64, args.join(' '));
  assert.equal(fetch.calls.length, 0);
});

test('calls brief: record, summary and insights as one object', async () => {
  const fetch = routes({
    'GET /history/calls/c1/flows/1': {
      body: {
        call: {
          flowIndex: 1,
          startTime: 1793956057204,
          duration: 122045,
          talkTime: 117138,
          direction: 'INTERNAL',
          callStatus: 'COMPLETED',
          caller: {name: 'A', userExtension: '1', email: 'a@x'},
          tags: ['t'],
          transcriptionStatus: 'AVAILABLE',
          recordingsData: [{url: 'u'}],
        },
      },
    },
    'GET /insights/calls/c1/flows/1/summary': {
      body: {status: 'SUCCEEDED', summary: {title: 'T', brief: 'B', json: {}}},
    },
    'GET /insights/calls/c1/flows/1/insights': {
      body: {
        status: 'SUCCEEDED',
        insights: [
          {id: 'csat', status: 'SUCCEEDED', fields: [{id: 'score', value: 5}]},
          {id: 'x', status: 'FAILED', fields: [{id: 'y', value: 1}]},
          {id: 'empty', status: 'SUCCEEDED', fields: []},
        ],
      },
    },
  });
  const r = await wx(['calls', 'brief', 'c1', '1'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    id: 'c1',
    flowIndex: 1,
    start: '2026-11-06T09:07:37Z',
    durationSec: 122,
    talkSec: 117,
    direction: 'INTERNAL',
    status: 'COMPLETED',
    caller: {name: 'A', phone: null, extension: '1', email: 'a@x'},
    callee: {name: null, phone: null, extension: null, email: null},
    queue: null,
    service: null,
    tags: ['t'],
    transcriptionStatus: 'AVAILABLE',
    hasRecording: true,
    summary: {title: 'T', brief: 'B'},
    insights: {csat: {score: 5}},
  });
  assert.deepEqual(
    fetch.calls.map((c) => c.method),
    ['GET', 'GET', 'GET'],
  );
});

test('calls brief: a missing summary is UNKNOWN, another failure is a warning', async () => {
  const fetch = routes({
    'GET /history/calls/c1/flows/0': {body: {call: {}}},
    'GET /insights/calls/c1/flows/0/insights': {status: 500, body: {message: 'boom'}},
  });
  const r = await wx(['calls', 'brief', 'c1'], fetch);
  assert.equal(r.code, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  assert.deepEqual(b.summary, {status: 'UNKNOWN'});
  assert.deepEqual(b.insights, {});
  assert.match(r.stderr, /Warning: HTTP 500/);
});

test('calls transcript prints the dialogue; --output json gives the answer of the service', async () => {
  const body = {filename: 'f.txt', text: '[00:01] A: hi\n[00:02] B: hello\n', chunks: [{id: '1'}, {id: '2'}]};
  const fetch = routes({'GET /history/calls/c1/flows/0/transcription/text': {body}});
  const text = await wx(['calls', 'transcript', 'c1'], fetch, {output: 'text'});
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stdout, '[00:01] A: hi\n[00:02] B: hello\n');
  const json = await wx(['calls', 'transcript', 'c1'], fetch);
  assert.deepEqual(JSON.parse(json.stdout), body);
});

test('calls transcript without a transcription fails with exit code 3 and says so', async () => {
  const r = await wx(['calls', 'transcript', 'c1'], routes({}), {output: 'text'});
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /This call has no transcription, or there is no such call/);
  const empty = await wx(
    ['calls', 'transcript', 'c1'],
    routes({'GET /history/calls/c1/flows/0/transcription/text': {body: {text: '  '}}}),
    {output: 'text'},
  );
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr, /The transcription is empty/);
});

test('calls transcript --structured reads the transcription record; not with --to', async () => {
  const rec = {
    transcription: {callStartTime: 1000, chunks: [{start: 6000, speaker: 'caller', text: 'hi  there'}]},
    interaction: {},
  };
  const fetch = routes({'GET /history/calls/c1/flows/0/transcription': {body: rec}});
  const json = await wx(['calls', 'transcript', 'c1', '--structured'], fetch);
  assert.deepEqual(JSON.parse(json.stdout), rec);
  const text = await wx(['calls', 'transcript', 'c1', '--structured'], fetch, {output: 'text'});
  assert.equal(text.stdout, '[00:05] caller: hi there\n');
  assert.equal((await wx(['calls', 'transcript', 'c1', '--structured', '--to', 'x.txt'], fetch)).code, 64);
});

test('calls transcript --to writes a new private file and never replaces one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-calls-'));
  const file = path.join(dir, 'sub', 't.txt');
  const fetch = routes({'GET /history/calls/c1/flows/0/transcription/text': {body: {text: '[00:01] A: hi'}}});
  const r = await wx(['calls', 'transcript', 'c1', '--to', file], fetch, {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), file);
  assert.equal(fs.readFileSync(file, 'utf8'), '[00:01] A: hi\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const again = await wx(['calls', 'transcript', 'c1', '--to', file], fetch);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /exists: choose another path \(nothing was overwritten\)/);
});

test('calls insights: compact by default, as the service gives it with --raw', async () => {
  const answer = {
    status: 'SUCCEEDED',
    insights: [{id: 'brief', status: 'SUCCEEDED', fields: [{id: 'title', value: 'T'}]}],
  };
  const fetch = routes({'GET /insights/calls/c1/flows/0/insights': {body: answer}});
  assert.deepEqual(JSON.parse((await wx(['calls', 'insights', 'c1'], fetch)).stdout), {
    status: 'SUCCEEDED',
    insights: {brief: {title: 'T'}},
  });
  assert.deepEqual(JSON.parse((await wx(['calls', 'insights', 'c1', '--raw'], fetch)).stdout), answer);
  const text = await wx(['calls', 'insights', 'c1'], fetch, {output: 'text'});
  assert.equal(text.stdout, 'brief:\n  title: T\n');
});

test('calls summary, characteristics, state and annotations read their paths', async () => {
  const fetch = routes({
    'GET /insights/calls/c1/flows/0/summary': {
      body: {status: 'SUCCEEDED', summary: {title: 'T', brief: 'B', json: {decisions: ['d1'], actionItems: ['a1']}}},
    },
    'GET /insights/calls/c1/flows/0/characteristics': {body: {status: 'SUCCEEDED', characteristics: {duration: 60000}}},
    'GET /insights/calls/c1/flows/0/state': {body: {state: {playlists: []}}},
    'GET /history/calls/c1/flows/0/annotations': {body: {annotations: {annotations: []}}},
  });
  const sum = await wx(['calls', 'summary', 'c1'], fetch, {output: 'text'});
  assert.equal(sum.stdout, 'T\nB\n\nDecisions:\n  - d1\nAction items:\n  - a1\n');
  for (const c of ['characteristics', 'state', 'annotations'])
    assert.equal((await wx(['calls', c, 'c1'], fetch)).code, 0, c);
  assert.deepEqual(
    fetch.calls.map((c) => c.url.slice(WDA.length)),
    [
      '/insights/calls/c1/flows/0/summary',
      '/insights/calls/c1/flows/0/characteristics',
      '/insights/calls/c1/flows/0/state',
      '/history/calls/c1/flows/0/annotations',
    ],
  );
});

test('calls recordings: the files of the record, each once', async () => {
  const rec = {fileName: 'a.mp3', url: 'https://pbx.example/a.mp3', start: 1, end: 2, owner: 'x'};
  const fetch = routes({
    'GET /history/calls/c1/flows/0': {
      body: {call: {attachments: [{recording: rec}, {fax: {}}], recordingsData: [rec, {fileName: 'b.mp3', url: 'u2'}]}},
    },
  });
  const r = await wx(['calls', 'recordings', 'c1'], fetch);
  assert.deepEqual(JSON.parse(r.stdout), {
    recordings: [
      {fileName: 'a.mp3', url: 'https://pbx.example/a.mp3', start: 1, end: 2},
      {fileName: 'b.mp3', url: 'u2', start: null, end: null},
    ],
  });
});

test('calls schedule-summary posts to the service', async () => {
  const fetch = routes({'POST /insights/calls/c1/flows/0/schedule_summary_generation': {body: {}}});
  const r = await wx(['calls', 'schedule-summary', 'c1'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].body, undefined);
});

test('a 403 says the login has no access; the token is never printed', async () => {
  const r = await wx(
    ['calls', 'get', 'c1'],
    routes({'GET /history/calls/c1/flows/0': {status: 403, body: {message: 'Forbidden'}}}),
  );
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP 403 from WDA/);
  assert.match(r.stderr, /The login has no access to this record/);
  assert.ok(!r.stderr.includes(env.WILDIX_ID_TOKEN));
});

test('WILDIX_WDA_URL outside wildix.com is refused before any request', async () => {
  const fetch = routes({});
  const r = await run(['calls', 'list'], {
    env: {...env, WILDIX_WDA_URL: 'https://evil.example'},
    fetch,
    registry: {groups},
  });
  assert.equal(r.code, 64);
  assert.equal(fetch.calls.length, 0);
});
