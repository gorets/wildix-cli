import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups} from '../src/commands/conversations.mjs';
import {fakeJwt, run} from './helpers.mjs';

const env = {WILDIX_ID_TOKEN: fakeJwt({email: 'Me@Example.com'}), TZ: 'Europe/Rome'};
const WDA = 'https://wda.wildix.com/v2';

function routes(map) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body)});
    const r = map[`${init.method} ${new URL(url).pathname.replace(/^\/v2/, '')}`] ?? {
      status: 404,
      body: {message: 'not found'},
    };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {status: r.status ?? 200});
  };
  fn.calls = calls;
  return fn;
}

const wx = (argv, fetch, opts = {}) => run(argv, {env, fetch, registry: {groups}, ...opts});

const items = [
  {
    event: {
      conference: {
        id: 'conf-1',
        startTime: 1793876489320,
        duration: 803000,
        subject: 'Sync',
        direction: 'INTERNAL',
        status: 'COMPLETED',
        participants: [{info: {name: 'Bob'}}, {info: {email: 'ann@x'}}, {info: {name: 'Bob'}}, {info: {}}],
      },
    },
    summary: {status: 'SUCCEEDED', title: 'T', brief: 'B', json: {}},
  },
  {
    event: {
      call: {
        id: 'call-1',
        flowIndex: 1,
        startTime: 1793956057204,
        duration: 122045,
        direction: 'INBOUND',
        callStatus: 'MISSED',
      },
    },
    summary: {status: 'NONE'},
  },
  {event: {chat: {chatId: 'chat-1', startTime: 0}}},
];

test('conversations find: your own conversations by default, the filter, the cursor', async () => {
  const fetch = routes({'POST /insights/conversations': {body: {items: [], lastEvaluatedKey: 'next'}}});
  const r = await wx(
    [
      'conversations',
      'find',
      '--entity',
      'call',
      '--entity',
      'conference',
      '--transcribed',
      '--recorded',
      '--direction',
      'inbound',
      '--when',
      'YESTERDAY',
      '--tz',
      'Europe/Rome',
      '--tag',
      'a',
      '--language',
      'en',
      '--cursor',
      'c1',
    ],
    fetch,
  );
  assert.equal(r.code, 0, r.stderr);
  const [call] = fetch.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${WDA}/insights/conversations`);
  assert.deepEqual(call.body, {
    filter: {
      entity: {call: true, conference: true},
      participants: [{email: 'me@example.com'}],
      transcribed: true,
      recorded: true,
      direction: {inbound: true},
      date: {predefined: {type: 'YESTERDAY', timeZone: 'Europe/Rome'}},
      tag: ['a'],
      language: ['en'],
    },
    exclusiveStartKey: 'c1',
  });
  assert.deepEqual(JSON.parse(r.stdout), {items: [], lastEvaluatedKey: 'next'});
});

test('conversations find: named participants or --everyone replace the default; --from/--to are absolute', async () => {
  const fetch = routes({'POST /insights/conversations': {body: {items: []}}});
  await wx(
    [
      'conversations',
      'find',
      '--email',
      'a@x',
      '--phone',
      '+39',
      '--extension',
      '201',
      '--from',
      '2026-11-01T00:00:00Z',
      '--to',
      '2026-11-02',
    ],
    fetch,
  );
  assert.deepEqual(fetch.calls[0].body.filter, {
    participants: [{email: 'a@x'}, {phone: '+39'}, {extension: '201'}],
    date: {absolute: {from: '2026-11-01T00:00:00Z', to: '2026-11-02'}},
  });
  await wx(['conversations', 'find', '--everyone'], fetch);
  assert.deepEqual(fetch.calls[1].body, {filter: {}});
});

test('conversations find --brief: one short object per conversation', async () => {
  const fetch = routes({'POST /insights/conversations': {body: {items, lastEvaluatedKey: 'k2'}}});
  const r = await wx(['conversations', 'find', '--brief'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    items: [
      {
        type: 'conference',
        id: 'conf-1',
        flowIndex: null,
        start: '2026-11-05T11:01:29Z',
        durationSec: 803,
        title: 'Sync',
        direction: 'INTERNAL',
        status: 'COMPLETED',
        participants: ['Bob', 'ann@x'],
        summary: {status: 'SUCCEEDED', title: 'T', brief: 'B'},
      },
      {
        type: 'call',
        id: 'call-1',
        flowIndex: 1,
        start: '2026-11-06T09:07:37Z',
        durationSec: 122,
        title: null,
        direction: 'INBOUND',
        status: 'MISSED',
        participants: null,
        summary: {status: 'NONE', title: null, brief: null},
      },
      {
        type: 'chat',
        id: 'chat-1',
        flowIndex: null,
        start: '1970-01-01T00:00:00Z',
        durationSec: 0,
        title: null,
        direction: null,
        status: null,
        participants: null,
        summary: {status: null, title: null, brief: null},
      },
    ],
    nextCursor: 'k2',
  });
  const text = await wx(['conversations', 'find'], fetch, {output: 'text'});
  const lines = text.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /conference\s+13:23\s+INTERNAL COMPLETED\s+Sync\s+conf-1$/);
  assert.match(lines[1], /call\s+2:02\s+INBOUND MISSED\s+call-1 1$/);
  assert.equal(lines[3], 'More: --cursor k2');
});

test('conversations count posts the filter', async () => {
  const fetch = routes({'POST /insights/conversations/count': {body: {count: 7}}});
  const r = await wx(['conversations', 'count', '--entity', 'conference', '--when', 'THIS_MONTH'], fetch, {
    output: 'text',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '7 conversations (your own)\n');
  assert.deepEqual(fetch.calls[0].body, {
    filter: {
      entity: {conference: true},
      participants: [{email: 'me@example.com'}],
      date: {predefined: {type: 'THIS_MONTH'}},
    },
  });
  assert.equal((await wx(['conversations', 'count', '--cursor', 'x'], fetch)).code, 64);
});

test('conversations refuse a bad period, entity, direction, zone or time before any request', async () => {
  const fetch = routes({});
  for (const args of [
    ['--when', 'LAST_YEAR'],
    ['--entity', 'sms'],
    ['--direction', 'INBOUND'],
    ['--tz', '1/x'],
    ['--from', 'monday'],
  ])
    assert.equal((await wx(['conversations', 'find', ...args], fetch)).code, 64, args.join(' '));
  assert.equal(fetch.calls.length, 0);
});

const aggAnswer = {
  count: 9,
  result: [
    {
      aggregation: {direction: {}},
      buckets: [
        {key: 'INBOUND', count: 2, filter: {}},
        {key: 'INTERNAL', count: 6, filter: {}},
        {key: 'OUTBOUND', count: 1},
      ],
    },
    {
      aggregation: {dayOfWeek: {timeZone: 'Europe/Rome'}},
      buckets: [
        {key: '5', count: 4},
        {key: '1', count: 3},
        {key: '0', count: 2},
      ],
    },
    {
      aggregation: {date: {timeZone: 'Europe/Rome'}},
      buckets: [
        {key: '2026-11-01', count: 1, interval: 'day'},
        {key: '2026-11-02', count: 8, interval: 'day'},
      ],
    },
  ],
};

test('conversations aggregate --by a,b: each dimension on its own, weekdays named, the biggest kept', async () => {
  const fetch = routes({'POST /insights/conversations/aggregations': {body: aggAnswer}});
  const r = await wx(
    [
      'conversations',
      'aggregate',
      '--by',
      'direction,dayOfWeek,date',
      '--top',
      '2',
      '--everyone',
      '--when',
      'LAST_30_DAYS',
    ],
    fetch,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {
    filter: {date: {predefined: {type: 'LAST_30_DAYS'}}},
    insights: [{direction: {}}, {dayOfWeek: {timeZone: 'Europe/Rome'}}, {date: {timeZone: 'Europe/Rome'}}],
  });
  assert.deepEqual(JSON.parse(r.stdout), {
    count: 9,
    timeZone: 'Europe/Rome',
    results: [
      {
        by: 'direction',
        buckets: [
          {key: 'INTERNAL', count: 6},
          {key: 'INBOUND', count: 2},
        ],
      },
      {
        by: 'dayOfWeek',
        buckets: [
          {key: '0', count: 2, day: 'Sunday'},
          {key: '1', count: 3, day: 'Monday'},
          {key: '5', count: 4, day: 'Friday'},
        ],
      },
      {
        by: 'date',
        buckets: [
          {key: '2026-11-01', count: 1, interval: 'day'},
          {key: '2026-11-02', count: 8, interval: 'day'},
        ],
      },
    ],
  });
  const raw = await wx(['conversations', 'aggregate', '--by', 'direction', '--raw'], fetch);
  assert.deepEqual(JSON.parse(raw.stdout), aggAnswer);
  const text = await wx(['conversations', 'aggregate', '--by', 'direction,dayOfWeek', '--tz', 'UTC'], fetch, {
    output: 'text',
  });
  assert.equal(fetch.calls[2].body.insights[1].dayOfWeek.timeZone, 'UTC');
  assert.match(
    text.stdout,
    /^9 conversations \(your own\), times in UTC\n\nby direction:\n {2}INBOUND {3}2\n {2}INTERNAL {2}6\n {2}OUTBOUND {2}1\n\nby dayOfWeek:\n {2}Sunday {2}2\n {2}Monday {2}3\n {2}Friday {2}4\n/,
  );
});

test('conversations aggregate --by a --then b: nested levels', async () => {
  const answer = {
    count: 5,
    result: {
      aggregation: {entity: {}},
      buckets: [
        {key: 'call', count: 1, aggregation: {aggregation: {direction: {}}, buckets: [{key: 'INBOUND', count: 1}]}},
        {
          key: 'conference',
          count: 4,
          aggregation: {aggregation: {projection: {id: 'csat', fieldId: 'score'}}, buckets: [{key: '5', count: 4}]},
        },
      ],
    },
  };
  const fetch = routes({'POST /insights/conversations/aggregations/nested': {body: answer}});
  const r = await wx(
    [
      'conversations',
      'aggregate',
      '--by',
      'entity',
      '--then',
      'direction',
      '--then',
      'projection:csat:score',
      '--tz',
      'UTC',
    ],
    fetch,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body.aggregations, [
    {entity: {}},
    {direction: {}},
    {projection: {id: 'csat', fieldId: 'score'}},
  ]);
  assert.deepEqual(JSON.parse(r.stdout), {
    count: 5,
    timeZone: 'UTC',
    by: 'entity',
    buckets: [
      {key: 'call', count: 1, then: {by: 'direction', buckets: [{key: 'INBOUND', count: 1}]}},
      {key: 'conference', count: 4, then: {by: 'projection:csat:score', buckets: [{key: '5', count: 4}]}},
    ],
  });
  const text = await wx(['conversations', 'aggregate', '--by', 'entity', '--then', 'direction', '--tz', 'UTC'], fetch, {
    output: 'text',
  });
  assert.match(
    text.stdout,
    /by entity, then direction:\n {2}call {8}1\n {4}INBOUND {3}1\n {2}conference {2}4\n {4}5 {9}4\n/,
  );
});

test('conversations aggregate refuses a bad dimension, too many levels, no --by', async () => {
  const fetch = routes({});
  for (const args of [
    ['--by', 'colour'],
    ['--by', 'projection:csat'],
    ['--by', 'a,b', '--then', 'entity'],
    ['--by', 'entity', '--then', 'direction', '--then', 'tag', '--then', 'pbx'],
    [],
    ['--by', 'entity', '--top', '0'],
    ['--by', Array(11).fill('entity').join(',')],
  ]) {
    assert.equal((await wx(['conversations', 'aggregate', ...args], fetch)).code, 64, args.join(' '));
  }
  assert.equal(fetch.calls.length, 0);
});

test('conversations aggregate --projections: the AI fields with values and their biggest values', async () => {
  const answer = {
    count: 3,
    result: [
      {
        aggregation: {projection: {id: 'sentiment', fieldId: 'overall'}},
        buckets: [
          {key: 'neutral', count: 1},
          {key: 'positive', count: 2},
        ],
      },
      {aggregation: {projection: {id: 'x', fieldId: 'y'}}, buckets: []},
      {aggregation: {direction: {}}, buckets: [{key: 'IN', count: 3}]},
    ],
  };
  const fetch = routes({'POST /insights/conversations/aggregations': {body: answer}});
  const r = await wx(['conversations', 'aggregate', '--projections'], fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {filter: {participants: [{email: 'me@example.com'}]}});
  assert.deepEqual(JSON.parse(r.stdout), {
    count: 3,
    projections: [
      {
        by: 'projection:sentiment:overall',
        values: 3,
        top: [
          {key: 'positive', count: 2},
          {key: 'neutral', count: 1},
        ],
      },
    ],
  });
});

test('conversations tags: the prefix and the limit go into the query', async () => {
  const fetch = routes({'GET /insights/conversations/tags': {body: {tags: ['sales', 'support']}}});
  const r = await wx(['conversations', 'tags', 's & p', '--limit', '5'], fetch, {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${WDA}/insights/conversations/tags?tagPrefix=s+%26+p&limit=5`);
  assert.equal(r.stdout, 'sales\nsupport\n');
  assert.equal((await wx(['conversations', 'tags', 's', '--limit', '21'], fetch)).code, 64);
});
