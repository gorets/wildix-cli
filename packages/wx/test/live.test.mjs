// wx live: the commands against a fake live service (a WebSocket constructor injected through liveOptions).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import {groups, liveOptions} from '../src/commands/live.mjs';
import {tokenFile} from 'wldx-core/auth';
import {fakeFetch, fakeJwt, run, tempConfigDir} from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 7, 12);
const TOKEN = fakeJwt({
  company: 'acme',
  'custom:pbx_user_extension': '201',
  'custom:pbx_license': 'premium',
  exp: NOW / 1000 + 3600,
});
const env = {WILDIX_ID_TOKEN: TOKEN};
const registry = {groups};
const defaults = {...liveOptions};

afterEach(() => Object.assign(liveOptions, defaults));

// A fake live service. topics: {topic: [items]} sent as the state of a subscription; errors: {topic: {code,
// message}} refuse it; refuse: the login is refused. on(msg, sock) sees every request after the defaults.
function fakeService({topics = {}, errors = {}, refuse, on} = {}) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      setImmediate(() => this.onopen?.());
    }
    reply(obj) {
      setImmediate(() => !this.closed && this.onmessage?.({data: JSON.stringify(obj)}));
    }
    // the server ends the connection
    drop(code = 1006) {
      setImmediate(() => {
        if (this.closed) return;
        this.closed = true;
        this.onclose?.({code});
      });
    }
    send(text) {
      const m = JSON.parse(text);
      this.sent.push(m);
      if (m.action === 'authorize') {
        if (refuse) this.reply({event: 'error', code: 401, message: `Unauthorized ${m.token}`, source: m});
        else this.reply({event: 'authorized'});
      } else if (m.action === 'subscribe') {
        if (errors[m.topic]) this.reply({event: 'error', ...errors[m.topic], source: {topic: m.topic}});
        else {
          if (m.state)
            for (const item of topics[m.topic] ?? []) this.reply({event: 'broadcast', topic: m.topic, data: [item]});
          this.reply({event: 'subscribed', topic: m.topic});
        }
      }
      on?.(m, this);
    }
    close(code = 1000) {
      if (this.closed) return;
      this.closed = true;
      setImmediate(() => this.onclose?.({code}));
    }
  }
  liveOptions.WebSocket = FakeWebSocket;
  return {sockets, subscriptions: () => sockets.flatMap((s) => s.sent.filter((m) => m.action === 'subscribe'))};
}

const live = (args, options = {}) => run(['live', ...args], {env, registry, ...options});
const lines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const agent = (id, ext, extra = {}) => ({
  id: `q1_${ext}`,
  name: `Agent ${ext}`,
  userExtension: ext,
  department: 'Support',
  status: 'available',
  email: `${ext}@acme.test`,
  ...extra,
});
const queue = (id, name, extra = {}) => ({
  event: 'service',
  id,
  name,
  pbx: 'PBX1',
  strategy: 'ringall',
  maxCalls: '5',
  agents: [],
  calls: [],
  ...extra,
});
const stats = (extra = {}) => ({
  offered: 10,
  answered: 8,
  abandoned: 2,
  shortAbandoned: 1,
  unanswered: 0,
  transferred: 0,
  unknown: 0,
  outbound: 1,
  answeredWithinSl: 6,
  serviceLevelSeconds: 20,
  answeredWaitSumMs: 80_000,
  talkSumMs: 600_000,
  talkCount: 8,
  ringSumMs: 0,
  ringCount: 0,
  maxWaitMs: 30_000,
  acwSumMs: 120_000,
  callsWaiting: 1,
  callsActive: 2,
  longestWaitStartedAt: NOW - 45_000,
  agentsTotal: 3,
  agentsAvailable: 2,
  agentsTalking: 1,
  agentsPaused: 0,
  agentsWrapUp: 0,
  agentsLoggedOff: 0,
  windowStartedAt: NOW - 3_600_000,
  periodSeconds: 3600,
  ...extra,
});

test('queues: logs in at wda-ws, subscribes services v2 with the state, sorts and shortens', async () => {
  const svc = fakeService({
    topics: {
      services: [
        queue('q2', 'Sales', {agents: [agent('q2', '301')]}),
        queue('q1', 'Support', {
          calls: ['c1', 'c2'],
          agents: [agent('q1', '201', {paused: 'true', reason: 'DND', message: 'Lunch'}), agent('q1', '202')],
        }),
        {event: 'other', id: 'x'},
      ],
    },
  });
  const r = await live(['queues']);
  assert.equal(r.code, 0, r.stderr);
  const [ws] = svc.sockets;
  assert.equal(ws.url, 'wss://wda-ws.wildix.com/');
  assert.deepEqual(ws.sent[0], {action: 'authorize', token: TOKEN});
  assert.deepEqual(ws.sent[1], {action: 'subscribe', topic: 'services', version: '2', state: true});
  assert.ok(ws.closed);
  const out = JSON.parse(r.stdout);
  assert.equal(out.total, 2);
  assert.equal(out.callsWaitingOrTalking, 2);
  assert.equal(out.pbxs, undefined);
  assert.equal(out.stats, undefined);
  assert.deepEqual(out.queues[0], {
    id: 'q1',
    name: 'Support',
    pbx: 'PBX1',
    strategy: 'ringall',
    maxCalls: 5,
    calls: 2,
    callIds: ['c1', 'c2'],
    agents: [
      {
        name: 'Agent 201',
        extension: '201',
        department: 'Support',
        status: 'available',
        paused: true,
        reason: 'DND',
        message: 'Lunch',
      },
      {name: 'Agent 202', extension: '202', department: 'Support', status: 'available'},
    ],
  });
  assert.equal(out.queues[1].name, 'Sales');
  assert.doesNotMatch(r.stdout, /acme\.test/);
});

test('queues: --name, --paused, --busy, --pbx filter; several PBXs are counted', async () => {
  fakeService({
    topics: {
      services: [
        queue('q1', 'Support EU', {pbx: 'PBXA', calls: ['c1'], agents: [agent('q1', '201', {paused: true})]}),
        queue('q2', 'Support US', {pbx: 'PBXB', agents: [agent('q2', '202')]}),
        queue('q3', 'Sales', {pbx: 'PBXB'}),
      ],
    },
  });
  assert.deepEqual(JSON.parse((await live(['queues', '--name', 'support'])).stdout).pbxs, {PBXA: 1, PBXB: 1});
  assert.equal(JSON.parse((await live(['queues', '--paused'])).stdout).queues[0].id, 'q1');
  assert.equal(JSON.parse((await live(['queues', '--busy'])).stdout).total, 1);
  assert.equal(JSON.parse((await live(['queues', '--pbx', 'PBXB'])).stdout).total, 2);
});

test('queues --window 30 --sla 10 asks for the stats and adds the figures of queues, agents and the total', async () => {
  const svc = fakeService({
    topics: {
      services: [
        queue('q1', 'Support', {
          agents: [agent('q1', '201')],
          stats: stats({
            agentStats: {
              q1_201: {
                offered: 4,
                answered: 3,
                missed: 1,
                talkSumMs: 90_000,
                talkCount: 3,
                availableMs: 1_800_000,
                busyMs: 600_000,
              },
            },
          }),
        }),
        queue('q2', 'Idle', {
          stats: stats({
            offered: 0,
            answered: 0,
            abandoned: 0,
            shortAbandoned: 0,
            outbound: 0,
            callsWaiting: 0,
            callsActive: 0,
            longestWaitStartedAt: undefined,
          }),
        }),
      ],
    },
  });
  const r = await live(['queues', '--window', '30', '--sla', '10', '--active']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(svc.subscriptions()[0], {
    action: 'subscribe',
    topic: 'services',
    version: '2',
    state: true,
    stats: true,
    serviceLevelSeconds: 10,
    periodMinutes: 30,
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.total, 1, '--active drops the queue without calls');
  const q = out.queues[0];
  assert.equal(q.stats.serviceLevel, 66.7);
  assert.equal(q.stats.abandonRate, 11.1);
  assert.equal(q.stats.asaSeconds, 10);
  assert.equal(q.stats.now.longestWaitSeconds, 45);
  assert.deepEqual(q.agents[0].stats, {
    offered: 4,
    answered: 3,
    missed: 1,
    answerRate: 75,
    avgTalkSeconds: 30,
    avgRingToAnswerSeconds: null,
    loggedInMinutes: null,
    availableMinutes: 30,
    busyMinutes: 10,
    pausedMinutes: null,
    wrapUpMinutes: null,
    occupancy: 25,
  });
  assert.equal(out.stats.offered, 10);
  assert.equal(out.stats.slaSeconds, 20);
});

test('queues text: a table of queues and, for a few queues, their agents', async () => {
  fakeService({
    topics: {
      services: [
        queue('q1', 'Support', {
          calls: ['c1'],
          agents: [agent('q1', '201', {paused: 'true', reason: 'DND'}), agent('q1', '202')],
        }),
      ],
    },
  });
  const r = await live(['queues'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^1 queue, 1 call waiting or talking/);
  assert.match(r.stdout, /QUEUE\s+CALLS\s+AVAILABLE\s+PAUSED\s+STRATEGY/);
  assert.match(r.stdout, /Support\s+1\s+1\/2\s+1\s+ringall/);
  assert.match(r.stdout, /AGENT\s+EXT\s+STATUS\s+REASON/);
  assert.match(r.stdout, /Agent 201\s+201\s+paused\s+DND/);
});

test('queues text: more than 10 queues are listed without their agents, with a hint on stderr', async () => {
  fakeService({
    topics: {
      services: Array.from({length: 11}, (_, i) => queue(`q${i}`, `Queue ${i}`, {agents: [agent(`q${i}`, '201')]})),
    },
  });
  const r = await live(['queues'], {output: 'text'});
  assert.doesNotMatch(r.stdout, /AGENT/);
  assert.match(r.stderr, /10 queues or fewer/);
});

test('queues refuses a bad window, SLA or PBX serial before connecting', async () => {
  const svc = fakeService();
  for (const args of [
    ['--window', '90'],
    ['--sla', '7'],
    ['--pbx', 'a/b'],
    ['--name', 'x'.repeat(101)],
  ]) {
    assert.equal((await live(['queues', ...args])).code, 64, args.join(' '));
  }
  assert.equal(svc.sockets.length, 0);
});

test('a WDA address override is refused without WILDIX_ALLOW_CUSTOM_URL', async () => {
  const svc = fakeService();
  const r = await live(['queues'], {env: {...env, WILDIX_WDA_WS_URL: 'wss://evil.example'}});
  assert.equal(r.code, 64);
  assert.equal(svc.sockets.length, 0);
  const ok = await live(['queues'], {
    env: {...env, WILDIX_WDA_WS_URL: 'ws://127.0.0.1:9', WILDIX_ALLOW_CUSTOM_URL: '1'},
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(svc.sockets[0].url, 'ws://127.0.0.1:9/');
});

test('a refused login exits 2 and never prints the token', async () => {
  fakeService({refuse: true});
  const r = await live(['queues']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /refused the login/);
  assert.ok(!r.stderr.includes(TOKEN));
});

test('conversations without Premium: exit 1 and the license named', async () => {
  fakeService({errors: {conversations: {code: 403, message: 'Forbidden'}}});
  const r = await live(['conversations']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only to users with a Premium license \(this login: premium\)/);
});

const call = (id, start, ext, extra = {}) => ({
  event: 'call',
  id,
  start,
  flows: [
    {
      flowIndex: 0,
      status: 'TALKING',
      direction: 'INBOUND',
      startTime: Date.parse(start),
      talkTime: 61_400,
      caller: {name: 'Customer', phone: '+391', email: 'c@x.test', ip: '1.2.3.4'},
      callee: {name: 'Agent', userExtension: ext, sipCallId: `sip-${id}`},
    },
  ],
  ...extra,
});

test('conversations: newest first, counts by type, --calls --mine and --limit', async () => {
  const svc = fakeService({
    topics: {
      conversations: [
        call('acme_1', '2026-11-07T10:00:00Z', '201'),
        call('acme_2', '2026-11-07T11:00:00Z', '305'),
        {
          event: 'chat',
          id: 'ch1',
          start: '2026-11-07T11:30:00Z',
          status: 'WAITFIRSTREPLY',
          subject: 'Help',
          customers: [{name: 'Guest', email: 'g@x.test'}],
          agents: [{name: 'Bot', bot: true}],
          annotationsByKey: {'copilot.sentiment': {payload: {metric: {value: 'negative'}}}},
        },
        call('acme_3', '2026-11-07T11:45:00Z', '201'),
      ],
    },
  });
  const all = JSON.parse((await live(['conversations'])).stdout);
  assert.deepEqual(svc.subscriptions()[0], {action: 'subscribe', topic: 'conversations', version: '2', state: true});
  assert.deepEqual(all.byType, {call: 3, chat: 1});
  assert.deepEqual(
    all.items.map((i) => i.id),
    ['acme_3', 'ch1', 'acme_2', 'acme_1'],
  );
  assert.deepEqual(all.items[1], {
    id: 'ch1',
    type: 'chat',
    start: '2026-11-07T11:30:00Z',
    status: 'WAITFIRSTREPLY',
    subject: 'Help',
    customers: [{name: 'Guest'}],
    agents: [{name: 'Bot', bot: true}],
    insights: {sentiment: 'negative'},
  });
  assert.deepEqual(all.items[0].flows[0], {
    flowIndex: 0,
    status: 'TALKING',
    direction: 'INBOUND',
    caller: {name: 'Customer', phone: '+391'},
    callee: {name: 'Agent', extension: '201', sipCallId: 'sip-acme_3'},
    start: '2026-11-07T11:45:00.000Z',
    talkSeconds: 61,
  });
  const mine = JSON.parse((await live(['conversations', '--calls', '--mine', '--limit', '1'])).stdout);
  assert.equal(mine.total, 2);
  assert.equal(mine.shown, 1);
  assert.deepEqual(
    mine.items.map((i) => i.id),
    ['acme_3'],
  );
  const waiting = JSON.parse((await live(['conversations', '--status', 'waitfirstreply'])).stdout);
  assert.deepEqual(
    waiting.items.map((i) => i.id),
    ['ch1'],
  );
  const full = JSON.parse((await live(['conversations', '--full', '--calls'])).stdout);
  assert.equal(full.items[0].flows[0].caller.ip, '1.2.3.4');
  assert.equal((await live(['conversations', '--limit', '0'])).code, 64);
  assert.equal((await live(['conversations', '--status', 'A B'])).code, 64);
});

test('conversations text: one line per conversation', async () => {
  fakeService({topics: {conversations: [call('acme_1', '2026-11-07T10:00:00Z', '201')]}});
  const r = await live(['conversations'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^1 in progress \(all: calls 1\)/);
  assert.match(r.stdout, /call\s+TALKING\s+Customer → Agent \(201\)\s+INBOUND/);
});

test('presence: a filter per extension of the company, unknown for nobody', async () => {
  const svc = fakeService({
    topics: {
      presence: [
        {
          company: 'acme',
          extension: '202',
          status: 'DND',
          message: 'Meeting',
          until: '2026-11-07T13:00:00Z',
          telephony: 'REGISTERED',
          lat: 1,
          lng: 2,
        },
      ],
    },
  });
  const r = await live(['presence', '202', '203']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(svc.subscriptions()[0], {
    action: 'subscribe',
    topic: 'presence',
    version: '2',
    state: true,
    filter: [
      [null, 'acme', '202'],
      [null, 'acme', '203'],
    ],
  });
  assert.deepEqual(JSON.parse(r.stdout), {
    presence: [
      {extension: '202', status: 'DND', message: 'Meeting', until: '2026-11-07T13:00:00Z', phone: 'REGISTERED'},
      {extension: '203', status: 'unknown'},
    ],
  });
  const text = await live(['presence', '202'], {output: 'text'});
  assert.match(text.stdout, /202\s+DND\s+Meeting/);
  assert.equal((await live(['presence', '20x'])).code, 64);
  assert.equal((await live(['presence'])).code, 64);
});

const transcription = (id) => [
  call(id, '2026-11-07T11:00:00Z', '201'),
  {
    event: 'transcription',
    flowIndex: 0,
    chunks: {
      a: {speaker: 'callee', text: 'Hello', isFinal: true, start: 2},
      b: {speaker: 'caller', text: 'Hi', isFinal: true, start: 1},
      c: {speaker: 'caller', text: 'par', isFinal: false, start: 3},
    },
  },
  {event: 'call_annotation', key: 'copilot.sentiment', payload: {metric: {value: 'positive'}}},
];

test('transcript by SIP call id: finds the WDA id in the conversations, then reads the transcript', async () => {
  const svc = fakeService({
    topics: {conversations: [call('acme_9', '2026-11-07T11:00:00Z', '201')], transcriptions: transcription('acme_9')},
  });
  const r = await live(['transcript', 'sip-acme_9']);
  assert.equal(r.code, 0, r.stderr);
  const subs = svc.subscriptions();
  assert.equal(subs[0].topic, 'conversations');
  assert.deepEqual(subs[1], {
    action: 'subscribe',
    topic: 'transcriptions',
    version: '2',
    state: true,
    filter: [['call', 'acme_9']],
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.id, 'acme_9');
  assert.equal(out.type, 'call');
  assert.deepEqual(out.transcript, [
    {flow: 0, speaker: 'caller', name: 'Customer', text: 'Hi', final: true, at: 1},
    {flow: 0, speaker: 'callee', name: 'Agent', text: 'Hello', final: true, at: 2},
  ]);
  assert.deepEqual(out.annotations, [{key: 'copilot.sentiment', payload: {metric: {value: 'positive'}}}]);
  const text = await live(['transcript', 'acme_9'], {output: 'text'});
  assert.equal(text.code, 0, text.stderr);
  assert.match(
    text.stdout,
    /^call acme_9: TALKING · Customer → Agent \(201\)\n.*Customer: Hi\n.*Agent: Hello\ncopilot\.sentiment: /,
  );
});

test('transcript: a WDA id goes straight to the transcript; a call that is over is named', async () => {
  const svc = fakeService({errors: {transcriptions: {code: 404, message: 'Call not found'}}});
  const r = await live(['transcript', 'acme_7']);
  assert.equal(r.code, 1);
  assert.equal(svc.subscriptions().length, 1);
  assert.match(r.stderr, /call acme_7 is not going on now/);
  assert.equal((await live(['transcript', 'a/b'])).code, 64);
});

test('transcript conference:<id> --follow: SNAPSHOT, TEXT, CALL, ANNOTATION, END', async () => {
  const svc = fakeService({
    topics: {transcriptions: []},
    on(m, sock) {
      if (m.topic !== 'transcriptions') return;
      sock.reply({
        event: 'broadcast',
        topic: 'transcriptions',
        data: [{event: 'conference', id: 'k1', subject: 'Daily', participants: [{name: 'P1'}]}],
      });
      sock.reply({
        event: 'broadcast',
        topic: 'transcriptions',
        data: [{flowIndex: 0, participant: {name: 'P1'}, chunk: {text: 'good morning', isFinal: false, time: 5}}],
      });
      sock.reply({event: 'broadcast', topic: 'conversations', data: [{event: 'call', id: 'other'}]});
      sock.reply({
        event: 'broadcast',
        topic: 'transcriptions',
        data: [{event: 'conference_annotation', key: 'copilot.topics', payload: {x: 1}}],
      });
      sock.reply({event: 'broadcast', topic: 'transcriptions', data: [{event: 'conference_complete', id: 'k1'}]});
    },
  });
  const r = await live(['transcript', 'conference:k1', '--follow']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(svc.subscriptions()[0].filter, [['conference', 'k1']]);
  const events = lines(r.stdout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['SNAPSHOT', 'CALL', 'TEXT', 'ANNOTATION', 'END'],
  );
  assert.deepEqual(events[0].data, {id: 'k1', type: 'conference', transcript: []});
  assert.deepEqual(events[2].data, {flow: 0, speaker: 'P1', name: 'P1', text: 'good morning', final: false, at: 5});
  assert.deepEqual(events[4].data, {id: 'k1', event: 'conference_complete'});
  assert.ok(svc.sockets[0].closed);
});

test('transcript --follow stops at --for and on Ctrl-C', async () => {
  fakeService({topics: {transcriptions: []}});
  const t0 = Date.now();
  const r = await live(['transcript', 'conference:k1', '--follow', '--for', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Date.now() - t0 >= 900);
  const controller = new AbortController();
  fakeService({
    topics: {transcriptions: []},
    on: (m) => m.topic === 'transcriptions' && setTimeout(() => controller.abort(), 20),
  });
  const stopped = await live(['transcript', 'conference:k1', '--follow'], {signal: controller.signal});
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.deepEqual(
    lines(stopped.stdout).map((e) => e.event),
    ['SNAPSHOT'],
  );
});

test('watch: READY, the events of the topics, until Ctrl-C', async () => {
  const controller = new AbortController();
  const svc = fakeService({
    on(m, sock) {
      if (m.topic !== 'presence') return;
      sock.reply({
        event: 'broadcast',
        topic: 'conversations',
        data: [call('acme_1', '2026-11-07T11:00:00Z', '201', {eventTrigger: 'call.start'})],
      });
      sock.reply({
        event: 'broadcast',
        topic: 'conversations',
        data: [{event: 'call_complete', id: 'acme_1', flows: 1}],
      });
      sock.reply({
        event: 'broadcast',
        topic: 'services',
        data: [
          {
            event: 'service',
            eventTrigger: 'service.agent_update',
            id: 'q1',
            agents: [agent('q1', '201', {paused: true, reason: 'AWAY'})],
          },
        ],
      });
      sock.reply({
        event: 'broadcast',
        topic: 'services',
        data: [
          {
            event: 'serviceCall',
            eventTrigger: 'service.call_init',
            id: 'q1',
            callId: 'c1',
            direction: 'incoming',
            customer: {phone: '+391'},
            relatedAgents: ['a', 'b'],
          },
        ],
      });
      sock.reply({
        event: 'broadcast',
        topic: 'presence',
        data: [{company: 'acme', extension: '202', status: 'AWAY', telephony: 'REGISTERED'}],
      });
      setTimeout(() => controller.abort(), 30);
    },
  });
  const r = await live(['watch', '--conversations', '--queues', '--presence', '202'], {signal: controller.signal});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(svc.subscriptions(), [
    {action: 'subscribe', topic: 'conversations', version: '2', state: false},
    {action: 'subscribe', topic: 'services', version: '2', state: false},
    {action: 'subscribe', topic: 'presence', version: '2', state: false, filter: [[null, 'acme', '202']]},
  ]);
  const events = lines(r.stdout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['READY', 'CALL', 'CALL_COMPLETE', 'QUEUE', 'QUEUE_CALL', 'PRESENCE'],
  );
  assert.deepEqual(events[0].data, {
    extension: '201',
    license: 'premium',
    topics: ['conversations', 'queues', 'presence'],
  });
  assert.equal(events[1].data.trigger, 'call.start');
  assert.deepEqual(events[2].data, {id: 'acme_1', type: 'call_complete', flows: 1});
  assert.deepEqual(events[3].data, {
    trigger: 'service.agent_update',
    id: 'q1',
    calls: 0,
    agents: [
      {name: 'Agent 201', extension: '201', department: 'Support', status: 'available', paused: true, reason: 'AWAY'},
    ],
  });
  assert.deepEqual(events[4].data, {
    queueId: 'q1',
    trigger: 'service.call_init',
    callId: 'c1',
    direction: 'incoming',
    customer: '+391',
    agents: 2,
  });
  assert.deepEqual(events[5].data, {extension: '202', status: 'AWAY', phone: 'REGISTERED'});
  assert.ok(svc.sockets[0].closed);
});

test('watch text: one readable line per event', async () => {
  const controller = new AbortController();
  fakeService({
    on(m, sock) {
      if (m.topic !== 'conversations') return;
      sock.reply({
        event: 'broadcast',
        topic: 'conversations',
        data: [call('acme_1', '2026-11-07T11:00:00Z', '201', {eventTrigger: 'call.start'})],
      });
      setTimeout(() => controller.abort(), 20);
    },
  });
  const r = await live(['watch'], {signal: controller.signal, output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, 2);
  assert.match(out[0], /^\d\d:\d\d:\d\d READY watching conversations · extension 201 · premium$/);
  assert.match(out[1], /^\d\d:\d\d:\d\d CALL call\.start · TALKING · Customer → Agent \(201\) · INBOUND · acme_1$/);
});

test('watch --calls --mine: only the calls of the user, and their ends', async () => {
  const controller = new AbortController();
  fakeService({
    on(m, sock) {
      if (m.topic !== 'conversations') return;
      const send = (data) => sock.reply({event: 'broadcast', topic: 'conversations', data: [data]});
      send({event: 'chat', id: 'ch1'});
      send(call('acme_1', '2026-11-07T11:00:00Z', '305'));
      send(call('acme_2', '2026-11-07T11:00:00Z', '201'));
      send({event: 'call_annotation', id: 'acme_2', key: 'copilot.sentiment'});
      send({event: 'call_annotation', id: 'acme_1', key: 'copilot.sentiment'});
      send({event: 'call_complete', id: 'acme_2'});
      send({event: 'call_complete', id: 'acme_1'});
      setTimeout(() => controller.abort(), 20);
    },
  });
  const r = await live(['watch', '--calls', '--mine'], {signal: controller.signal});
  const events = lines(r.stdout);
  assert.deepEqual(
    events.map((e) => `${e.event} ${e.data.id ?? ''}`.trim()),
    ['READY', 'CALL acme_2', 'CALL_ANNOTATION acme_2', 'CALL_COMPLETE acme_2'],
  );
  assert.equal(events[0].data.calls, true);
  assert.equal(events[0].data.mine, true);
});

test('watch --stats: the queues are read once with the stats, then QUEUES and QUEUE_STATS named', async () => {
  const controller = new AbortController();
  const svc = fakeService({
    topics: {services: [queue('q1', 'Support')]},
    on(m, sock) {
      if (m.topic !== 'services') return;
      sock.reply({
        event: 'broadcast',
        topic: 'services',
        data: [
          {event: 'service_stats_update', id: 'q1', stats: stats({agentStats: {q1_201: {offered: 1, answered: 1}}})},
        ],
      });
      setTimeout(() => controller.abort(), 20);
    },
  });
  const r = await live(['watch', '--window', '60'], {signal: controller.signal});
  assert.equal(r.code, 0, r.stderr);
  const [sub] = svc.subscriptions();
  assert.deepEqual(sub, {
    action: 'subscribe',
    topic: 'services',
    version: '2',
    state: true,
    stats: true,
    serviceLevelSeconds: 20,
    periodMinutes: 60,
  });
  const events = lines(r.stdout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['READY', 'QUEUES', 'QUEUE_STATS'],
  );
  assert.deepEqual(events[0].data.topics, ['queues']);
  assert.deepEqual(events[1].data, {queues: 1, stats: {stats: true, serviceLevelSeconds: 20, periodMinutes: 60}});
  assert.equal(events[2].data.name, 'Support');
  assert.equal(events[2].data.serviceLevel, 66.7);
  assert.equal(events[2].data.agents['201'].answerRate, 100);
});

test('watch: a lost connection is renewed after a wait, with the subscriptions again', async () => {
  liveOptions.retryDelays = [0.01];
  const controller = new AbortController();
  const svc = fakeService({
    on(m, sock) {
      if (svc.sockets.length === 1) sock.drop(1006);
      else setTimeout(() => controller.abort(), 20);
    },
  });
  const r = await live(['watch', '--for', '60'], {signal: controller.signal});
  assert.equal(r.code, 0, r.stderr);
  const events = lines(r.stdout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['READY', 'RECONNECTING', 'RECONNECTED'],
  );
  assert.deepEqual(events[1].data, {code: 1006, attempt: 1, inSeconds: 0.01});
  assert.equal(svc.sockets.length, 2);
  assert.equal(svc.sockets[1].sent[1].topic, 'conversations');
});

test('watch: near the expiry of the token it reconnects at once with a renewed token', async () => {
  const dir = tempConfigDir();
  const email = 'me@example.com';
  const exp = NOW / 1000 + 90;
  const oldToken = fakeJwt({email, company: 'acme', exp});
  const newToken = fakeJwt({email, company: 'acme', exp: exp + 3600});
  fs.mkdirSync(path.join(dir, 'tokens'), {recursive: true});
  fs.writeFileSync(
    tokenFile(email, {WILDIX_CONFIG_DIR: dir}),
    JSON.stringify({IdToken: oldToken, RefreshToken: 'r', ExpiresIn: 3600, email, savedAt: '2026-11-07T11:00:00Z'}),
  );
  const fetch = fakeFetch({body: {AuthenticationResult: {IdToken: newToken, ExpiresIn: 3600}}});
  let clock = NOW;
  const controller = new AbortController();
  const svc = fakeService({
    on(m, sock) {
      if (svc.sockets.length === 1) {
        clock = NOW + 60_000; // 30 s before the expiry: getToken renews it
        sock.drop(1001);
      } else setTimeout(() => controller.abort(), 20);
    },
  });
  const r = await live(['watch'], {env: {WILDIX_CONFIG_DIR: dir}, fetch, now: () => clock, signal: controller.signal});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    lines(r.stdout).map((e) => e.event),
    ['READY', 'RECONNECTING', 'RECONNECTED'],
  );
  assert.deepEqual(lines(r.stdout)[1].data, {reason: 'token'});
  assert.equal(svc.sockets[0].sent[0].token, oldToken);
  assert.equal(svc.sockets[1].sent[0].token, newToken);
  assert.equal(fetch.calls.length, 1);
});

test('watch: a refused subscription (403) prints ERROR and exits 1', async () => {
  fakeService({errors: {services: {code: 403, message: 'Forbidden'}}});
  const r = await live(['watch', '--queues']);
  assert.equal(r.code, 1);
  const events = lines(r.stdout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['READY', 'ERROR'],
  );
  assert.deepEqual(events[1].data, {
    message: 'the live service allows call queues only to users with a Premium license (this login: premium)',
    code: 403,
  });
});

test('watch: gives up after 5 failed connections in a row; --for stops it', async () => {
  liveOptions.retryDelays = [0.01, 0.01, 0.01, 0.01];
  liveOptions.WebSocket = class {
    constructor() {
      setImmediate(() => this.onclose?.({code: 1006}));
    }
    send() {}
    close() {}
  };
  const r = await live(['watch']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /closed the connection \(code 1006\)/);
  fakeService();
  const t0 = Date.now();
  const timed = await live(['watch', '--for', '1']);
  assert.equal(timed.code, 0, timed.stderr);
  assert.ok(Date.now() - t0 >= 900);
  assert.equal((await live(['watch', '--for', '0'])).code, 64);
  assert.equal((await live(['watch', '--presence', 'abc'])).code, 64);
});
