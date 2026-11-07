import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {groups} from '../src/commands/meetings.mjs';
import {fakeJwt, run} from './helpers.mjs';

const env = {WILDIX_ID_TOKEN: fakeJwt({email: 'me@example.com'})};
const WDA = 'https://wda.wildix.com/v2';
const ID = '17e6dbbd-0617-4998-b0ba-ad35ff19-11_1793797253877';
const LINK = `https://app.x-bees.com/insights/conferences/${ID}/?x=1#y`;

function routes(map) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body)});
    const u = new URL(url);
    const r = map[`${init.method} ${u.pathname.replace(/^\/v2/, '')}`] ?? {status: 404, body: {message: 'not found'}};
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {status: r.status ?? 200});
  };
  fn.calls = calls;
  return fn;
}

const wx = (argv, fetch, opts = {}) => run(argv, {env, fetch, registry: {groups}, ...opts});

const conference = {
  id: ID,
  subject: 'Weekly\nsync',
  startTime: 1793876489320,
  duration: 803000,
  status: 'COMPLETED',
  direction: 'INTERNAL',
  transcriptionStatus: 'AVAILABLE',
  transcriptionLanguage: 'en-US',
  recordings: [{url: 'u'}],
  participants: [
    {jid: 'j-b', info: {name: 'Bob', email: 'bob@x', xbsId: 'xb'}, totalSpeakDuration: 120000},
    {jid: 'j-a', info: {name: 'Ann', email: 'ann@x', xbsId: 'xa'}, totalSpeakDuration: 60000},
    {jid: 'j-a2', info: {name: 'Ann', email: 'ann@x', xbsId: 'xa'}, totalSpeakDuration: 90000},
    {jid: 'j-g', info: {}},
  ],
};

test('meetings get takes an id or a link', async () => {
  const fetch = routes({[`GET /history/conferences/${ID}`]: {body: {conference}}});
  const r = await wx(['meetings', 'get', LINK], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${WDA}/history/conferences/${ID}`);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.deepEqual(JSON.parse(r.stdout), {conference});
  const text = await wx(['meetings', 'get', ID], fetch, {output: 'text'});
  assert.match(text.stdout, /^Participants\s+2: Ann, Bob$/m);
});

test('meetings refuse what is not a conference id', async () => {
  const fetch = routes({});
  for (const bad of ['https://app.x-bees.com/insights/conferences/', 'a..b', '-x', 'a b'])
    assert.equal((await wx(['meetings', 'get', bad], fetch)).code, 64, bad);
  assert.equal(fetch.calls.length, 0);
});

test('meetings brief: one card, the participants merged by e-mail, the summary sections', async () => {
  const fetch = routes({
    [`GET /history/conferences/${ID}`]: {body: {conference}},
    [`GET /insights/conferences/${ID}/insights`]: {
      body: {status: 'SUCCEEDED', insights: [{id: 'brief', status: 'SUCCEEDED', fields: [{id: 'title', value: 'T'}]}]},
    },
    [`GET /insights/conferences/${ID}/summary`]: {
      body: {status: 'SUCCEEDED', summary: {title: 'Title', brief: 'Brief', json: {topics: ['t1'], decisions: ['d1']}}},
    },
  });
  const r = await wx(['meetings', 'brief', ID], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    id: ID,
    subject: 'Weekly\nsync',
    start: '2026-11-05T11:01:29Z',
    durationMin: 13,
    status: 'COMPLETED',
    direction: 'INTERNAL',
    participants: [
      {name: 'Ann', email: 'ann@x', xbsId: 'xa', speakMin: 3},
      {name: 'Bob', email: 'bob@x', xbsId: 'xb', speakMin: 2},
    ],
    transcriptionStatus: 'AVAILABLE',
    transcriptionLanguage: 'en-US',
    hasRecording: true,
    summary: {
      title: 'Title',
      brief: 'Brief',
      topics: ['t1'],
      review: [],
      decisions: ['d1'],
      progress: [],
      issues: [],
      actionItems: [],
      nextSteps: [],
    },
    insights: {brief: {title: 'T'}},
  });
  const text = await wx(['meetings', 'brief', ID], fetch, {output: 'text'});
  assert.match(text.stdout, /^Weekly sync\n/);
  assert.match(text.stdout, /Participants: Ann \(3 min\), Bob \(2 min\)/);
  assert.match(text.stdout, /Decisions:\n {4}- d1/);
});

test('meetings brief of several: an array, oldest first; one that fails is skipped with a warning', async () => {
  const other = 'c47f537a-485b-4713-a47c-d072b235-11_1793876489320';
  const fetch = routes({
    [`GET /history/conferences/${ID}`]: {body: {conference: {startTime: 2000_000}}},
    [`GET /history/conferences/${other}`]: {body: {conference: {startTime: 1000_000}}},
  });
  const r = await wx(['meetings', 'brief', ID, other, 'missing-1'], fetch);
  assert.equal(r.code, 0, r.stderr);
  const cards = JSON.parse(r.stdout);
  assert.deepEqual(
    cards.map((c) => c.id),
    [other, ID],
  );
  assert.deepEqual(cards[0].summary, {status: 'UNKNOWN'});
  assert.match(r.stderr, /Warning: skipped missing-1: HTTP 404/);
  const none = await wx(['meetings', 'brief', 'missing-1', 'missing-2'], fetch);
  assert.equal(none.code, 1);
});

const textBody = {
  filename: 'f.txt',
  text: '[00:35] Ann: hello\n[00:38] Bob: hi\n',
  chunks: [
    {id: '1', name: 'Ann', offset: 35000, text: 'hello', time: '00:35'},
    {id: '2', name: 'Bob', offset: 38000, text: 'hi', time: '00:38'},
  ],
};

test('meetings transcript: the header and the dialogue', async () => {
  const fetch = routes({
    [`GET /history/conferences/${ID}/transcription/text`]: {body: textBody},
    [`GET /history/conferences/${ID}`]: {body: {conference}},
  });
  const r = await wx(['meetings', 'transcript', LINK], fetch, {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      '# Weekly sync',
      `# conferenceId: ${ID}`,
      `# url: https://app.x-bees.com/insights/conferences/${ID}`,
      '# start: 2026-11-05T11:01:29Z',
      '# duration: 13 min',
      '# language: en-US',
      '# participants: Ann, Bob',
      '# lines: 2',
      '[00:35] Ann: hello',
      '[00:38] Bob: hi',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    fetch.calls.map((c) => c.url.slice(WDA.length)),
    [`/history/conferences/${ID}/transcription/text`, `/history/conferences/${ID}`],
  );
});

test('meetings transcript --output json: the header fields and the answer of the service', async () => {
  const fetch = routes({
    [`GET /history/conferences/${ID}/transcription/text`]: {body: textBody},
    [`GET /history/conferences/${ID}`]: {body: {conference}},
  });
  const r = await wx(['meetings', 'transcript', ID], fetch);
  assert.deepEqual(JSON.parse(r.stdout), {
    conference: {
      id: ID,
      subject: 'Weekly\nsync',
      url: `https://app.x-bees.com/insights/conferences/${ID}`,
      start: '2026-11-05T11:01:29Z',
      durationMin: 13,
      language: 'en-US',
      participants: ['Ann', 'Bob'],
      transcriptionStatus: 'AVAILABLE',
    },
    ...textBody,
  });
});

test('meetings transcript: none, unavailable, still processing, empty (exit code 3)', async () => {
  const cases = [
    [{}, /This conference has no transcription, or there is no such conference/],
    [
      {
        [`GET /history/conferences/${ID}/transcription/text`]: {body: textBody},
        [`GET /history/conferences/${ID}`]: {body: {conference: {...conference, transcriptionStatus: 'UNAVAILABLE'}}},
      },
      /UNAVAILABLE/,
    ],
    [
      {
        [`GET /history/conferences/${ID}/transcription/text`]: {body: {text: ''}},
        [`GET /history/conferences/${ID}`]: {
          body: {conference: {...conference, transcriptionStatus: 'POST_TRANSCRIPTION'}},
        },
      },
      /still being processed/,
    ],
    [
      {
        [`GET /history/conferences/${ID}/transcription/text`]: {body: {text: ' \n'}},
        [`GET /history/conferences/${ID}`]: {body: {conference}},
      },
      /The transcription is empty/,
    ],
  ];
  for (const [map, message] of cases) {
    const r = await wx(['meetings', 'transcript', ID], routes(map), {output: 'text'});
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, message);
  }
});

test('meetings transcript --to: a private file; the same transcript may be written again, nothing else is replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-meet-'));
  const file = path.join(dir, 't', `${ID}.txt`);
  const fetch = () =>
    routes({
      [`GET /history/conferences/${ID}/transcription/text`]: {body: textBody},
      [`GET /history/conferences/${ID}`]: {body: {conference}},
    });
  const r = await wx(['meetings', 'transcript', ID, '--to', file], fetch());
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {file});
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, new RegExp(`^# Weekly sync\\n# conferenceId: ${ID}\\n`));
  assert.ok(content.endsWith('[00:38] Bob: hi\n'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await wx(['meetings', 'transcript', ID, '--to', file], fetch())).code, 0);
  const other = path.join(dir, 'notes.txt');
  fs.writeFileSync(other, 'line 1\nline 2\n');
  const refused = await wx(['meetings', 'transcript', ID, '--to', other], fetch());
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /exists: choose another path/);
  assert.equal(fs.readFileSync(other, 'utf8'), 'line 1\nline 2\n');
  const link = path.join(dir, 'dangling.txt');
  fs.symlinkSync(path.join(dir, 'target.txt'), link);
  assert.equal((await wx(['meetings', 'transcript', ID, '--to', link], fetch())).code, 1);
  assert.equal(fs.existsSync(path.join(dir, 'target.txt')), false);
});

test('meetings transcript --structured: the record; as text with the names of the participants', async () => {
  const rec = {
    transcription: {transcriptions: [{start: 1000, chunks: [{jid: 'j-a', start: 66000, text: 'hello'}]}]},
    interaction: {},
  };
  const fetch = routes({
    [`GET /history/conferences/${ID}/transcription`]: {body: rec},
    [`GET /history/conferences/${ID}`]: {body: {conference}},
  });
  const json = await wx(['meetings', 'transcript', ID, '--structured'], fetch);
  assert.deepEqual(JSON.parse(json.stdout), rec);
  assert.equal(fetch.calls.length, 1);
  const text = await wx(['meetings', 'transcript', ID, '--structured'], fetch, {output: 'text'});
  assert.equal(text.stdout, '[01:05] Ann: hello\n');
});

test('meetings insights, summary, state, annotations and timeframes read their paths', async () => {
  const fetch = routes({
    [`GET /insights/conferences/${ID}/insights`]: {
      body: {status: 'SUCCEEDED', insights: [{id: 'p', status: 'SUCCEEDED', fields: [{id: 'f', value: 1}]}]},
    },
    [`GET /insights/conferences/${ID}/summary`]: {body: {status: 'STARTED'}},
    [`GET /insights/conferences/${ID}/state`]: {body: {state: {}}},
    [`GET /history/conferences/${ID}/annotations`]: {body: {annotations: {annotations: []}}},
    [`GET /insights/conferences/${ID}/timeframes`]: {
      body: {timeFrames: [{jid: 'j-a', frames: [{start: 1793876489320 + 5000, end: 1793876489320 + 65000}]}]},
    },
  });
  assert.deepEqual(JSON.parse((await wx(['meetings', 'insights', ID], fetch)).stdout), {
    status: 'SUCCEEDED',
    insights: {p: {f: 1}},
  });
  assert.equal((await wx(['meetings', 'summary', ID], fetch, {output: 'text'})).stdout, 'No summary: STARTED\n');
  assert.equal((await wx(['meetings', 'state', ID], fetch)).code, 0);
  assert.equal((await wx(['meetings', 'annotations', ID], fetch, {output: 'text'})).stdout, 'No annotations.\n');
  const tf = await wx(['meetings', 'timeframes', ID], fetch);
  assert.deepEqual(JSON.parse(tf.stdout), {
    timeFrames: [{jid: 'j-a', frames: [{start: 1793876494320, end: 1793876554320}]}],
  });
  assert.ok(!fetch.calls.some((c) => c.url === `${WDA}/history/conferences/${ID}`), 'no record fetched for JSON');
});

test('meetings timeframes as text: who spoke, how long, when', async () => {
  const fetch = routes({
    [`GET /insights/conferences/${ID}/timeframes`]: {
      body: {timeFrames: [{jid: 'j-a', frames: [{start: 1793876489320 + 5000, end: 1793876489320 + 65000}]}]},
    },
    [`GET /history/conferences/${ID}`]: {body: {conference}},
  });
  const r = await wx(['meetings', 'timeframes', ID], fetch, {output: 'text'});
  assert.equal(r.stdout, 'Ann  1:00  1 time  0:05-1:05\n');
});

test('meetings recording-url asks for a presigned link', async () => {
  const fetch = routes({
    'GET /insights/conferences/recording/download_url': {body: {presignedDownloadUrl: 'https://s3.example/x?sig=1'}},
  });
  const r = await wx(
    ['meetings', 'recording-url', '--file-id', 'rec/1.mp4', '--category', 'wizyconfRecordings', '--download'],
    fetch,
    {output: 'text'},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'https://s3.example/x?sig=1\n');
  assert.equal(
    fetch.calls[0].url,
    `${WDA}/insights/conferences/recording/download_url?fileId=rec%2F1.mp4&category=wizyconfRecordings&download=1`,
  );
  assert.equal((await wx(['meetings', 'recording-url', '--file-id', 'x'], fetch)).code, 64);
  assert.equal((await wx(['meetings', 'recording-url', '--file-id', 'x', '--category', 'other'], fetch)).code, 64);
});

test('meetings schedule-summary posts to the service', async () => {
  const fetch = routes({[`POST /insights/conferences/${ID}/schedule_summary_generation`]: {}});
  const r = await wx(['meetings', 'schedule-summary', ID], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(r.stdout), {ok: true});
});
