// The pure parts of wx live: views, the merging of watch frames into events, transcript events, the text lines.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connect, explain} from '../src/live/socket.mjs';
import {eventText, figuresLine} from '../src/live/text.mjs';
import {chunksOf, lastById, makeViews, transcriptEvents, watchFrames} from '../src/live/views.mjs';

const views = makeViews({company: 'acme', myExtension: '201', now: () => 0});
const frames = (o = {}) =>
  watchFrames({
    views,
    wantConv: true,
    wantQueues: true,
    wantStats: false,
    statsOpts: () => ({stats: true}),
    explain: (t, d) => explain(t, d, 'premium'),
    ...o,
  });
const names = (r) => r.events.map((e) => e.event);

test('lastById keeps the last item of every id, in the order of the first', () => {
  assert.deepEqual(lastById([{id: 'a', n: 1}, {id: 'b'}, {id: 'a', n: 2}, null, {}]), [{id: 'a', n: 2}, {id: 'b'}]);
});

test('chunksOf: stored transcripts, live lines, nothing else', () => {
  assert.deepEqual(chunksOf({flowIndex: 1, chunks: {x: {text: 'a'}}}), [{text: 'a', flowIndex: 1}]);
  assert.deepEqual(chunksOf({flowIndex: 0, participant: {name: 'P'}, chunk: {text: 'b'}}), [
    {text: 'b', flowIndex: 0, participant: {name: 'P'}},
  ]);
  assert.deepEqual(chunksOf({event: 'call'}), []);
  assert.deepEqual(chunksOf(undefined), []);
});

test('presence: the company only when it is another one; full gives the item as it is', () => {
  const p = {
    company: 'other',
    extension: '1',
    status: 'ONLINE',
    message: '',
    until: '',
    telephony: 'REGISTERED',
    lat: 1,
  };
  assert.deepEqual(views.presenceView(p), {extension: '1', company: 'other', status: 'ONLINE', phone: 'REGISTERED'});
  assert.equal(makeViews({full: true}).presenceView(p), p);
});

test('watch frames: conversations, queue changes, queue calls, other service events, presence', () => {
  const w = frames();
  const r = w.frame({
    event: 'broadcast',
    topic: 'services',
    data: [
      {event: 'service', eventTrigger: 'service.agent_leave', id: 'q1', agents: [{id: 'q1_201'}]},
      {event: 'service_call', eventTrigger: 'service.call_end', id: 'q1', callId: 'c1', customer: {name: 'N'}},
      {event: 'service_stats_update', id: 'q1', stats: {}},
      {event: 'service_reset', id: 'q1', eventTrigger: 'x'},
      null,
    ],
  });
  assert.deepEqual(names(r), ['QUEUE', 'QUEUE_CALL', 'SERVICE_RESET']);
  assert.deepEqual(r.events[1].data, {queueId: 'q1', trigger: 'service.call_end', callId: 'c1', customer: 'N'});
  assert.deepEqual(r.events[2].data, {id: 'q1', trigger: 'x'});
  assert.deepEqual(
    names(
      w.frame({
        event: 'broadcast',
        topic: 'conversations',
        data: {
          event: 'chat_annotation',
          id: 'ch',
          key: 'copilot.csat',
          annotationsByKey: {'copilot.csat': {payload: {metric: {value: 4}}}},
        },
      }),
    ),
    ['CHAT_ANNOTATION'],
  );
  assert.deepEqual(
    w.frame({
      event: 'broadcast',
      topic: 'conversations',
      data: [
        {
          event: 'chat_annotation',
          id: 'ch',
          key: 'k',
          annotationsByKey: {'copilot.csat': {payload: {metric: {value: 4}}}},
        },
      ],
    }).events[0].data,
    {id: 'ch', type: 'chat_annotation', key: 'k', insights: {csat: 4}},
  );
  assert.deepEqual(names(w.frame({event: 'broadcast', topic: 'presence', data: [{extension: '2', status: 'DND'}]})), [
    'PRESENCE',
  ]);
  assert.deepEqual(names(w.frame({event: 'subscribed', topic: 'conversations'})), []);
});

test('watch frames with stats: queue events wait for the state, then QUEUES; again after a reconnection', () => {
  const w = frames({wantStats: true});
  assert.deepEqual(
    names(
      w.frame({
        event: 'broadcast',
        topic: 'services',
        data: [{event: 'service', eventTrigger: 'service.init', id: 'q1', name: 'Support'}],
      }),
    ),
    [],
  );
  const ready = w.frame({event: 'subscribed', topic: 'services'});
  assert.deepEqual(ready.events, [{event: 'QUEUES', data: {queues: 1, stats: {stats: true}}}]);
  const s = w.frame({
    event: 'broadcast',
    topic: 'services',
    data: [
      {
        event: 'service_stats_update',
        id: 'q1',
        stats: {
          offered: 1,
          answered: 1,
          abandoned: 0,
          shortAbandoned: 0,
          unanswered: 0,
          answeredWithinSl: 1,
          agentStats: {q1_201: {offered: 1, answered: 1}, odd: {offered: 0}},
        },
      },
    ],
  });
  assert.equal(s.events[0].event, 'QUEUE_STATS');
  assert.equal(s.events[0].data.name, 'Support');
  assert.equal(s.events[0].data.serviceLevel, 100);
  assert.deepEqual(Object.keys(s.events[0].data.agents), ['201', 'odd']);
  w.reset();
  assert.deepEqual(
    names(
      w.frame({
        event: 'broadcast',
        topic: 'services',
        data: [{event: 'service', id: 'q1', eventTrigger: 'service.update'}],
      }),
    ),
    [],
  );
  assert.deepEqual(names(w.frame({event: 'subscribed', topic: 'services'})), ['QUEUES']);
  // without stats, a stats update is not printed
  assert.deepEqual(
    names(
      frames().frame({
        event: 'broadcast',
        topic: 'services',
        data: [{event: 'service_stats_update', id: 'q1', stats: {}}],
      }),
    ),
    [],
  );
});

test('watch frames: an error is printed; a 403 is fatal', () => {
  const w = frames();
  const soft = w.frame({event: 'error', code: 500, message: 'oops', source: {topic: 'presence'}});
  assert.deepEqual(soft, {
    events: [
      {event: 'ERROR', data: {message: 'the live service refused the presence subscription (500): oops', code: 500}},
    ],
  });
  const hard = w.frame({event: 'error', code: 403, message: 'no', source: {topic: 'conversations'}});
  assert.match(hard.fatal, /Premium license \(this login: premium\)/);
});

test('watch frames --calls: chats and conferences are left out', () => {
  const w = frames({calls: true});
  assert.deepEqual(
    names(
      w.frame({
        event: 'broadcast',
        topic: 'conversations',
        data: [
          {event: 'chat', id: 'a'},
          {event: 'call_complete', id: 'b'},
          {event: 'conference', id: 'c'},
        ],
      }),
    ),
    ['CALL_COMPLETE'],
  );
});

test('transcriptEvents: the call names the speakers of the lines after it', () => {
  const state = {};
  const call = {event: 'call', id: 'k', flows: [{flowIndex: 0, caller: {name: 'Caller'}, callee: {name: 'Callee'}}]};
  assert.equal(transcriptEvents(call, 'k', state, views).events[0].event, 'CALL');
  const t = transcriptEvents({flowIndex: 0, chunk: {speaker: 'callee', text: 'hi', isFinal: true}}, 'k', state, views);
  assert.deepEqual(t, {
    events: [{event: 'TEXT', data: {flow: 0, speaker: 'callee', name: 'Callee', text: 'hi', final: true}}],
    end: false,
  });
  assert.deepEqual(transcriptEvents({flowIndex: 0, chunk: {text: ''}}, 'k', state, views).events, []);
  assert.deepEqual(transcriptEvents({event: 'call_interrupted'}, 'k', state, views), {
    events: [{event: 'END', data: {id: 'k', event: 'call_interrupted'}}],
    end: true,
  });
});

test('eventText: one line with the time, the event and what it says', () => {
  const ctx = {clock: () => new Date(2026, 10, 7, 9, 5, 7).getTime()};
  assert.equal(
    eventText({event: 'RECONNECTING', data: {code: 1006, attempt: 2, inSeconds: 2}}, ctx),
    '09:05:07 RECONNECTING connection lost (code 1006), attempt 2 in 2 s',
  );
  assert.equal(
    eventText({event: 'RECONNECTING', data: {reason: 'token'}}, ctx),
    '09:05:07 RECONNECTING renewing the login',
  );
  assert.equal(
    eventText(
      {event: 'PRESENCE', data: {extension: '202', status: 'AWAY', message: 'Lunch', phone: 'REGISTERED'}},
      ctx,
    ),
    '09:05:07 PRESENCE 202 · AWAY · "Lunch" · REGISTERED',
  );
  assert.equal(
    eventText(
      {
        event: 'QUEUE',
        data: {
          trigger: 'service.agent_update',
          id: 'q1',
          calls: 0,
          agents: [{name: 'A', extension: '201', status: 'pause', paused: true, reason: 'DND'}],
        },
      },
      ctx,
    ),
    '09:05:07 QUEUE service.agent_update · q1 · A paused DND',
  );
  assert.equal(
    eventText(
      {
        event: 'QUEUE_CALL',
        data: {
          queueId: 'q1',
          trigger: 'service.call_init',
          callId: 'c1',
          direction: 'incoming',
          customer: '+39',
          agents: 2,
        },
      },
      ctx,
    ),
    '09:05:07 QUEUE_CALL service.call_init · queue q1 · call c1 · incoming · +39 · 2 agents',
  );
  assert.equal(
    eventText({event: 'CALL_COMPLETE', data: {id: 'acme_1', type: 'call_complete', flows: 1}}, ctx),
    '09:05:07 CALL_COMPLETE acme_1',
  );
  assert.equal(
    eventText({event: 'TEXT', data: {name: 'Anna', text: 'hello', final: false}}, ctx),
    '09:05:07 TEXT (partial) Anna: hello',
  );
  assert.equal(
    eventText(
      {
        event: 'CHAT',
        data: {
          type: 'chat',
          status: 'WAITFIRSTREPLY',
          customers: [{name: 'G'}],
          subject: 'Help',
          insights: {sentiment: 'neutral'},
          id: 'ch',
        },
      },
      ctx,
    ),
    '09:05:07 CHAT WAITFIRSTREPLY · G · Help · sentiment neutral · ch',
  );
  assert.equal(eventText({event: 'SOMETHING', data: {a: 1}}, ctx), '09:05:07 SOMETHING {"a":1}');
});

test('figuresLine: a queue in one line', () => {
  assert.equal(
    figuresLine({
      offered: 3,
      answered: 2,
      abandoned: 1,
      shortAbandoned: 0,
      serviceLevel: 66.7,
      slaSeconds: 20,
      asaSeconds: 12,
      avgTalkSeconds: 95,
      now: {waiting: 1, longestWaitSeconds: 70, talking: 2},
    }),
    'offered 3 · answered 2 · abandoned 1 · SL 66.7% (20 s) · ASA 0:12 · talk 1:35 · waiting 1 (longest 1:10) · talking 2',
  );
});

test('connect: the token is scrubbed from any message of the service', async () => {
  const token = 'secret.token.value';
  class Ws {
    constructor() {
      setImmediate(() => this.onopen());
    }
    send(t) {
      const m = JSON.parse(t);
      const reply = (o) => setImmediate(() => this.onmessage({data: JSON.stringify(o)}));
      if (m.action === 'authorize') reply({event: 'authorized'});
      else reply({event: 'error', code: 400, message: `bad request ${token}`, source: m});
    }
    close() {}
  }
  const conn = await connect({url: 'wss://x.wildix.com', token, WebSocket: Ws});
  await assert.rejects(conn.snapshot('presence'), (e) => !e.message.includes(token) && /\[token\]/.test(e.message));
});
