import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups} from '../src/commands/reports.mjs';
import {fakeJwt, run} from './helpers.mjs';

// The days of a report are cut in the local zone of the machine: pin it.
process.env.TZ = 'UTC';

const env = {WILDIX_ID_TOKEN: fakeJwt({email: 'me@example.com'})};
const WDA = 'https://wda.wildix.com/v2';
const NOW = () => Date.UTC(2026, 10, 7, 12);
const Q = 'it_acme_42010af0c6a8_116';

function routes(map) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body)});
    const key = `${init.method} ${new URL(url).pathname.replace(/^\/v2/, '')}`;
    let r = map[key] ?? {status: 404, body: {message: 'not found'}};
    if (Array.isArray(r)) r = r.shift();
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {status: r.status ?? 200});
  };
  fn.calls = calls;
  return fn;
}

const wx = (argv, fetch, opts = {}) => run(argv, {env, fetch, now: NOW, registry: {groups}, ...opts});

test('reports list: the queues by PBX and name, with a count per PBX', async () => {
  const services = [
    {id: 'q3', name: 'Sales', pbx: 'B222', aclGroup: ''},
    {id: 'q1', name: 'Support EN', pbx: 'A111', aclGroup: 'g1'},
    {id: 'q2', name: 'support IT', pbx: 'A111'},
    {id: 'q4', pbx: 'A111'},
  ];
  const fetch = routes({'POST /stream/services': {body: {services}}});
  const r = await wx(['reports', 'list'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${WDA}/stream/services`);
  assert.deepEqual(fetch.calls[0].body, {});
  assert.deepEqual(JSON.parse(r.stdout), {
    total: 4,
    pbxs: {A111: 3, B222: 1},
    queues: [
      {id: 'q4', pbx: 'A111'},
      {id: 'q1', name: 'Support EN', pbx: 'A111', aclGroup: 'g1'},
      {id: 'q2', name: 'support IT', pbx: 'A111'},
      {id: 'q3', name: 'Sales', pbx: 'B222'},
    ],
  });
  const named = await wx(['reports', 'list', '--name', 'SUPPORT', '--pbx', 'A111'], fetch);
  assert.deepEqual(
    JSON.parse(named.stdout).queues.map((q) => q.id),
    ['q1', 'q2'],
  );
  const text = await wx(['reports', 'list'], fetch, {output: 'text'});
  assert.match(text.stdout, /^4 queues · PBX A111: 3, PBX B222: 1\nA111\s+q4\n/);
  assert.equal((await wx(['reports', 'list', '--pbx', 'a/b'], fetch)).code, 64);
});

test('reports summary: today by default; the PBX of the first queue', async () => {
  const fetch = routes({
    'POST /xcaracal/distribution/summary/query': {
      body: {
        timeZone: 'Europe/Rome',
        pbx: '42010af0c6a8',
        metrics: {counts: {offered: 3}, sla: {answeredWithin: 0, eligible: 0, thresholdSeconds: 20}},
      },
    },
  });
  const r = await wx(['reports', 'summary', '--queue', Q, '--queue', 'it_acme_42010af0c6a8_117'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].method, 'POST');
  assert.equal(fetch.calls[0].url, `${WDA}/xcaracal/distribution/summary/query`);
  assert.deepEqual(fetch.calls[0].body, {
    filter: {
      date: {from: '2026-11-07', to: '2026-11-07'},
      pbx: '42010af0c6a8',
      serviceIds: [Q, 'it_acme_42010af0c6a8_117'],
    },
  });
  const text = await wx(['reports', 'summary', '--queue', Q], fetch, {output: 'text'});
  assert.match(text.stdout, /^2026-11-07 · PBX 42010af0c6a8 · Europe\/Rome\nOffered\s+3\n/);
  assert.match(text.stdout, /^Service level\s+no calls within 20 s$/m);
});

test('reports: every filter option goes into the filter', async () => {
  const fetch = routes({'POST /xcaracal/distribution/by-service/query': {body: {groups: []}}});
  const r = await wx(
    [
      'reports',
      'by-queue',
      '--days',
      '7',
      '--tz',
      'Europe/Rome',
      '--pbx',
      'ABCD1234',
      '--queue',
      Q,
      '--extension',
      '201',
      '--outcome',
      'lost',
      '--outcome',
      'overflow',
      '--hours',
      '09:00-24:00',
      '--weekday',
      '1',
      '--weekday',
      '7',
      '--wait',
      '10-',
      '--talk',
      '0-60',
      '--reason',
      'HANGUP',
      '--sla',
      '30',
      '--queue-sla',
      `${Q}=45`,
    ],
    fetch,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {
    filter: {
      date: {from: '2026-11-01', to: '2026-11-07', timeZone: 'Europe/Rome'},
      pbx: 'ABCD1234',
      serviceIds: [Q],
      extensions: ['201'],
      outcomes: ['lost', 'overflow'],
      disconnectReasons: ['HANGUP'],
      daysOfWeek: [1, 7],
      hourRange: {from: '09:00', to: '24:00'},
      waitSecondsRange: {from: 10},
      talkSecondsRange: {from: 0, to: 60},
      slaSeconds: 30,
      serviceSlaSeconds: [{serviceId: Q, slaSeconds: 45}],
    },
  });
});

test('reports: --from and --to are days; --to alone is one day; --days wins', async () => {
  const fetch = routes({'POST /xcaracal/distribution/summary/query': {body: {}}});
  await wx(['reports', 'summary', '--from', '2026-10-01', '--to', '2026-10-31'], fetch);
  await wx(['reports', 'summary', '--to', '2026-10-05'], fetch);
  await wx(['reports', 'summary', '--from', '2026-11-03'], fetch);
  await wx(['reports', 'summary', '--days', '1', '--from', '2026-01-01'], fetch);
  assert.deepEqual(
    fetch.calls.map((c) => c.body.filter.date),
    [
      {from: '2026-10-01', to: '2026-10-31'},
      {from: '2026-10-05', to: '2026-10-05'},
      {from: '2026-11-03', to: '2026-11-07'},
      {from: '2026-11-07', to: '2026-11-07'},
    ],
  );
});

test('reports refuse bad days, bands, hours, SLAs and ids before any request', async () => {
  const fetch = routes({});
  const bad = [
    ['--from', '2026-11-08', '--to', '2026-11-07'],
    ['--from', '2026-02-30'],
    ['--to', '07.11.2026'],
    ['--days', '91'],
    ['--days', '0'],
    ['--tz', 'Europe/Rome;'],
    ['--pbx', 'x'],
    ['--queue', 'a/b'],
    ['--extension', '20a'],
    ['--outcome', 'missed'],
    ['--hours', '9-13'],
    ['--hours', '24:00-24:00'],
    ['--weekday', '0'],
    ['--wait', '-10'],
    ['--talk', '1-2-3'],
    ['--reason', 'HANG UP'],
    ['--sla', '22'],
    ['--sla', '125'],
    ['--queue-sla', `${Q}=7`],
    ['--queue-sla', 'nope'],
  ];
  for (const args of bad) assert.equal((await wx(['reports', 'summary', ...args], fetch)).code, 64, args.join(' '));
  assert.equal(fetch.calls.length, 0);
});

test('reports by-period: the granularity (weekday is dayOfWeek); --by is required', async () => {
  const fetch = routes({
    'POST /xcaracal/distribution/by-period/query': {
      body: {
        granularity: 'dayOfWeek',
        buckets: [
          {bucketKey: '1', metrics: {counts: {offered: 2, completed: 1}, sla: {answeredWithin: 1, eligible: 2}}},
        ],
      },
    },
  });
  const r = await wx(['reports', 'by-period', '--by', 'weekday'], fetch, {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {
    filter: {date: {from: '2026-11-07', to: '2026-11-07'}},
    granularity: 'dayOfWeek',
  });
  assert.match(r.stdout, /\nPeriod\s+Offered\s+Answered.*\nMonday\s+2\s+1\s+0\s+0\s+0\s+1\/2 50%/);
  await wx(['reports', 'by-period', '--by', 'hour'], fetch);
  assert.equal(fetch.calls[1].body.granularity, 'hour');
  assert.equal((await wx(['reports', 'by-period'], fetch)).code, 64);
  assert.equal((await wx(['reports', 'by-period', '--by', 'year'], fetch)).code, 64);
});

test('reports answered: the summary, a breakdown, the talk-time ladder', async () => {
  const fetch = routes({
    'POST /xcaracal/answered/summary/query': {
      body: {completed: 3, transferred: 1, sla: {answeredWithin: 4, eligible: 4, thresholdSeconds: 20}},
    },
    'POST /xcaracal/answered/breakdown/query': {
      body: {
        dimension: 'byAgent',
        total: 4,
        groups: [
          {
            userName: 'Ann',
            userExtension: '201',
            serviceName: 'Support',
            calls: 4,
            completed: 3,
            transferred: 1,
            avgWaitMs: 5000,
            avgTalkMs: 60000,
            totalTalkMs: 240000,
          },
        ],
      },
    },
  });
  const sum = await wx(['reports', 'answered'], fetch, {output: 'text'});
  assert.match(sum.stdout, /^Answered\s+4 \(completed 3, transferred 1\)$/m);
  assert.match(sum.stdout, /^Service level\s+4\/4 100% within 20 s$/m);
  const by = await wx(['reports', 'answered', '--by', 'agent'], fetch, {output: 'text'});
  assert.deepEqual(fetch.calls[1].body, {filter: {date: {from: '2026-11-07', to: '2026-11-07'}}, dimension: 'byAgent'});
  assert.match(by.stdout, /\nAnn \(201\) · Support\s+4\s+3\s+1\s+0:05\s+1:00\s+4:00\n/);
  await wx(['reports', 'answered', '--by', 'talk-time', '--band', '60', '--steps', '5'], fetch);
  assert.deepEqual(fetch.calls[2].body, {
    filter: {date: {from: '2026-11-07', to: '2026-11-07'}},
    talkBandSeconds: 60,
    talkBandSteps: 5,
    dimension: 'byTalkTime',
  });
  for (const [by, d] of [
    ['queue', 'byService'],
    ['user', 'byUser'],
    ['reason', 'byDisconnectReason'],
  ]) {
    await wx(['reports', 'answered', '--by', by], fetch);
    assert.equal(fetch.calls.at(-1).body.dimension, d);
  }
  assert.equal((await wx(['reports', 'answered', '--band', '60'], fetch)).code, 64);
  assert.equal((await wx(['reports', 'answered', '--by', 'talk-time', '--steps', '61'], fetch)).code, 64);
});

test('reports unanswered: the summary or a breakdown by queue or reason', async () => {
  const fetch = routes({
    'POST /xcaracal/unanswered/summary/query': {body: {abandoned: 2, lost: 1, overflow: 1}},
    'POST /xcaracal/unanswered/breakdown/query': {
      body: {dimension: 'byDisconnectReason', groups: [{disconnectReason: 'TIMEOUT', unanswered: 1}]},
    },
  });
  const sum = await wx(['reports', 'unanswered'], fetch, {output: 'text'});
  assert.equal(sum.code, 0, sum.stderr);
  assert.match(sum.stdout, /^Lost\s+1 \(abandoned 0, unanswered 0\)$/m);
  const by = await wx(['reports', 'unanswered', '--by', 'reason'], fetch, {output: 'text'});
  assert.equal(fetch.calls[1].url, `${WDA}/xcaracal/unanswered/breakdown/query`);
  assert.equal(fetch.calls[1].body.dimension, 'byDisconnectReason');
  assert.match(by.stdout, /\nTIMEOUT\s+0\s+1\s+0\s+0/);
  await wx(['reports', 'unanswered', '--by', 'queue'], fetch);
  assert.equal(fetch.calls[2].body.dimension, 'byService');
  assert.equal((await wx(['reports', 'unanswered', '--by', 'agent'], fetch)).code, 64);
});

test('reports service-level answered|unanswered with the wait ladder', async () => {
  const fetch = routes({
    'POST /xcaracal/unanswered/service-level/query': {
      body: {total: 3, lost: 2, overflow: 1, bands: [{withinSeconds: 10, count: 2, delta: 2, lost: 1, overflow: 1}]},
    },
    'POST /xcaracal/answered/service-level/query': {body: {bands: []}},
  });
  const r = await wx(['reports', 'service-level', 'unanswered', '--band', '10', '--steps', '6'], fetch, {
    output: 'text',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {
    filter: {date: {from: '2026-11-07', to: '2026-11-07'}},
    waitBandSeconds: 10,
    waitBandSteps: 6,
  });
  assert.match(r.stdout, /3 not answered \(lost 2, overflow 1\)\nwithin 10 s\s+2\s+\+2\s+lost 1\s+overflow 1\n/);
  assert.equal((await wx(['reports', 'service-level', 'answered'], fetch)).code, 0);
  assert.equal(fetch.calls[1].url, `${WDA}/xcaracal/answered/service-level/query`);
  assert.equal((await wx(['reports', 'service-level', 'abandoned'], fetch)).code, 64);
  assert.equal((await wx(['reports', 'service-level'], fetch)).code, 64);
});

const row = (id) => ({
  callId: id,
  flowIndex: 0,
  serviceName: 'Support',
  enteredAt: '2026-11-06T15:07:26.745Z',
  waitMs: 2000,
  outcome: 'abandoned',
  callerPhone: '+390211',
  callerName: 'Customer',
  lost: true,
});

test('reports calls: pages followed with the cursor; the caller only with --full', async () => {
  const fetch = routes({
    'POST /xcaracal/services/calls/query': [
      {body: {timeZone: 'Europe/Rome', pbx: 'P1', items: [row('a')], nextCursor: 'cur1'}},
      {body: {timeZone: 'Europe/Rome', pbx: 'P1', items: [row('b')], nextCursor: 'cur2'}},
    ],
  });
  const r = await wx(
    ['reports', 'calls', '--limit', '1', '--pages', '2', '--outcome', 'lost', '--call', 'it_x_1.2', '--cursor', 'cur0'],
    fetch,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    fetch.calls.map((c) => c.body),
    [
      {
        filter: {date: {from: '2026-11-07', to: '2026-11-07'}, outcomes: ['lost']},
        limit: 1,
        callId: 'it_x_1.2',
        cursor: 'cur0',
      },
      {
        filter: {date: {from: '2026-11-07', to: '2026-11-07'}, outcomes: ['lost']},
        limit: 1,
        callId: 'it_x_1.2',
        cursor: 'cur1',
      },
    ],
  );
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['timeZone', 'pbx', 'count', 'items', 'nextCursor']);
  assert.equal(out.count, 2);
  assert.equal(out.nextCursor, 'cur2');
  assert.ok(out.items.every((i) => !('callerPhone' in i) && !('callerName' in i)));

  const full = await wx(
    ['reports', 'calls', '--full'],
    routes({'POST /xcaracal/services/calls/query': {body: {timeZone: 'Z', pbx: 'P', items: [row('a')]}}}),
  );
  assert.deepEqual(JSON.parse(full.stdout), {timeZone: 'Z', pbx: 'P', count: 1, items: [row('a')]});
  const text = await wx(
    ['reports', 'calls', '--full'],
    routes({'POST /xcaracal/services/calls/query': {body: {items: [row('a')]}}}),
    {output: 'text'},
  );
  assert.match(text.stdout, /Support\s+abandoned\s+wait 0:02\s+Customer \(\+390211\)\s+a 0\n$/);
  for (const args of [
    ['--limit', '201'],
    ['--pages', '21'],
    ['--cursor', 'a b'],
    ['--call', '../x'],
  ])
    assert.equal((await wx(['reports', 'calls', ...args], fetch)).code, 64, args.join(' '));
});

test('reports events: one call in one queue, the caller only with --full', async () => {
  const answer = {
    call: row('it_x_1.2'),
    events: [
      {
        time: '2026-11-06T15:07:27Z',
        action: 'RING',
        reason: 'RINGING',
        userName: 'Ann',
        userExtension: '201',
        queuePosition: 1,
      },
    ],
  };
  const fetch = routes({'GET /xcaracal/services/calls/it_x_1.2/flows/3/events': {body: answer}});
  const r = await wx(['reports', 'events', 'it_x_1.2', '3', '--queue', Q], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, `${WDA}/xcaracal/services/calls/it_x_1.2/flows/3/events?serviceId=${Q}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.call.callerPhone, undefined);
  assert.deepEqual(out.events, answer.events);
  assert.deepEqual(JSON.parse((await wx(['reports', 'events', 'it_x_1.2', '3', '--full'], fetch)).stdout), answer);
  assert.equal(fetch.calls[1].url, `${WDA}/xcaracal/services/calls/it_x_1.2/flows/3/events`);
  const text = await wx(['reports', 'events', 'it_x_1.2', '3'], fetch, {output: 'text'});
  assert.match(text.stdout, /\n {2}2026-11-06 15:07:27\s+RING\s+RINGING\s+Ann \(201\)\s+place 1\n$/);
  assert.equal((await wx(['reports', 'events', 'it_x_1.2', 'x'], fetch)).code, 64);
  assert.equal((await wx(['reports', 'events', 'it_x_1.2'], fetch)).code, 64);
});
