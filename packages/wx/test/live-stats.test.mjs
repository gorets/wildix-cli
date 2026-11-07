// The queue statistics of wx live (src/live/stats.mjs, the stats.mjs of the wildix-live-monitor skill).
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {
  agentFigures,
  agentStatsByExtension,
  applyServiceEvent,
  queueFigures,
  statsOptions,
  sumStats,
} from '../src/live/stats.mjs';

const TZ = process.env.TZ;
after(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

const NOW = Date.UTC(2026, 10, 7, 12);

test('statsOptions: the last minutes, or today from the local midnight on a whole UTC hour', () => {
  assert.deepEqual(statsOptions('30', 10, NOW), {stats: true, serviceLevelSeconds: 10, periodMinutes: 30});
  process.env.TZ = 'Europe/Rome';
  assert.deepEqual(statsOptions('today', 20, NOW), {
    stats: true,
    serviceLevelSeconds: 20,
    periodStart: 'today',
    utcOffsetMinutes: 60,
  });
  process.env.TZ = 'Asia/Kolkata'; // +5:30: the local midnight 18:30 UTC, the window from 18:00 UTC
  assert.deepEqual(statsOptions('today', 20, NOW), {
    stats: true,
    serviceLevelSeconds: 20,
    periodStartAt: Date.UTC(2026, 10, 6, 18),
  });
});

const raw = {
  offered: 10,
  answered: 8,
  abandoned: 2,
  shortAbandoned: 1,
  unanswered: 1,
  transferred: 1,
  unknown: 0,
  outbound: 3,
  answeredWithinSl: 6,
  serviceLevelSeconds: 20,
  answeredWaitSumMs: 80_000,
  talkSumMs: 600_000,
  talkCount: 8,
  ringSumMs: 12_000,
  ringCount: 4,
  maxWaitMs: 30_000,
  acwSumMs: 90_000,
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
};

test('queueFigures: rates over the calls with a known outcome, short abandons left out', () => {
  const f = queueFigures(raw, NOW);
  // base = 8 + (2 - 1) + 1 = 10
  assert.equal(f.serviceLevel, 60);
  assert.equal(f.abandonRate, 10);
  assert.equal(f.asaSeconds, 10);
  assert.equal(f.avgTalkSeconds, 75);
  assert.equal(f.avgRingSeconds, 3);
  assert.equal(f.maxWaitSeconds, 30);
  assert.equal(f.wrapUpMinutes, 1.5);
  assert.deepEqual(f.window, {from: new Date(NOW - 3_600_000).toISOString(), minutes: 60});
  assert.deepEqual(f.now, {
    waiting: 1,
    longestWaitSeconds: 45,
    talking: 2,
    agents: {total: 3, available: 2, talking: 1, paused: 0, wrapUp: 0, loggedOff: 0},
  });
  assert.equal(queueFigures(undefined), undefined);
  const empty = queueFigures(
    {
      ...raw,
      offered: 0,
      answered: 0,
      abandoned: 0,
      shortAbandoned: 0,
      unanswered: 0,
      maxWaitMs: 0,
      longestWaitStartedAt: undefined,
    },
    NOW,
  );
  assert.equal(empty.serviceLevel, null);
  assert.equal(empty.asaSeconds, null);
  assert.equal(empty.maxWaitSeconds, null);
  assert.equal(empty.now.longestWaitSeconds, 0);
});

test('sumStats: counters added first, rates after; the oldest wait and the widest window', () => {
  const other = {
    ...raw,
    offered: 5,
    answered: 5,
    abandoned: 0,
    shortAbandoned: 0,
    unanswered: 0,
    answeredWithinSl: 5,
    maxWaitMs: 50_000,
    longestWaitStartedAt: NOW - 90_000,
    serviceLevelSeconds: 30,
    periodSeconds: 900,
    windowStartedAt: NOW - 900_000,
  };
  const s = sumStats([raw, undefined, other]);
  assert.equal(s.offered, 15);
  assert.equal(s.answeredWithinSl, 11);
  assert.equal(s.maxWaitMs, 50_000);
  assert.equal(s.longestWaitStartedAt, NOW - 90_000);
  assert.equal(s.periodSeconds, 3600);
  assert.equal(s.windowStartedAt, NOW - 3_600_000);
  assert.equal(s.serviceLevelSeconds, undefined, 'mixed SLAs give none');
  assert.equal(queueFigures(s, NOW).serviceLevel, 73.3); // 11 / (13 + 1 + 1)
  assert.equal(sumStats([undefined]), undefined);
});

test('agentFigures: answer rate and occupancy', () => {
  assert.deepEqual(
    agentFigures({
      offered: 4,
      answered: 3,
      missed: 1,
      talkSumMs: 90_000,
      talkCount: 3,
      ringToAnswerSumMs: 9_000,
      ringToAnswerCount: 3,
      loggedInMs: 3_600_000,
      availableMs: 1_800_000,
      busyMs: 600_000,
      pausedMs: 600_000,
      wrapUpMs: 60_000,
    }),
    {
      offered: 4,
      answered: 3,
      missed: 1,
      answerRate: 75,
      avgTalkSeconds: 30,
      avgRingToAnswerSeconds: 3,
      loggedInMinutes: 60,
      availableMinutes: 30,
      busyMinutes: 10,
      pausedMinutes: 10,
      wrapUpMinutes: 1,
      occupancy: 25,
    },
  );
  assert.equal(agentFigures(undefined), undefined);
  assert.equal(agentFigures({offered: 0, answered: 0}).answerRate, null);
});

test('agentStatsByExtension: the per-queue agent ids added up per person', () => {
  const m = agentStatsByExtension([
    {
      id: 'q1',
      agents: [{id: 'q1_201', userExtension: '201'}],
      stats: {agentStats: {q1_201: {answered: 2, busyMs: 10}}},
    },
    {id: 'q2', agents: [], stats: {agentStats: {q2_201: {answered: 1, busyMs: 5}, q2_202: {answered: 4}}}},
  ]);
  assert.deepEqual(m.get('201'), {answered: 3, busyMs: 15});
  assert.deepEqual(m.get('202'), {answered: 4});
});

test('applyServiceEvent: init, agent join/update/leave, calls of the queue, stats, end', () => {
  const queues = new Map();
  applyServiceEvent(
    queues,
    {
      event: 'service',
      eventTrigger: 'service.init',
      id: 'q1',
      name: 'Support',
      pbx: 'P',
      agents: [{id: 'q1_201', userExtension: '201', status: 'available'}, {id: 'q1_x'}],
      calls: ['c1'],
    },
    NOW,
  );
  const q = queues.get('q1');
  assert.equal(q.name, 'Support');
  assert.deepEqual(
    q.agents.map((a) => a.id),
    ['q1_201'],
    'agents without an extension are left out',
  );
  assert.deepEqual([...q.calls.keys()], ['c1']);

  applyServiceEvent(
    queues,
    {
      event: 'service',
      eventTrigger: 'service.agent_join',
      id: 'q1',
      time: NOW + 1,
      agents: [{id: 'q1_202', userExtension: '202', status: 'available'}],
    },
    NOW,
  );
  assert.equal(q.agents.length, 2);
  assert.equal(q.agents[1].since, NOW + 1);

  applyServiceEvent(
    queues,
    {
      event: 'service',
      eventTrigger: 'service.agent_update',
      id: 'q1',
      time: NOW + 2,
      agents: [{id: 'q1_201', paused: 'true', status: undefined}],
    },
    NOW,
  );
  assert.equal(q.agents[0].paused, 'true');
  assert.equal(q.agents[0].status, 'available', 'an undefined field keeps the value');
  assert.equal(q.agents[0].since, NOW + 2);

  applyServiceEvent(
    queues,
    {event: 'service', eventTrigger: 'service.agent_leave', id: 'q1', agents: [{id: 'q1_202'}]},
    NOW,
  );
  assert.deepEqual(
    q.agents.map((a) => a.id),
    ['q1_201'],
  );

  applyServiceEvent(
    queues,
    {
      event: 'serviceCall',
      eventTrigger: 'service.call_update',
      id: 'q1',
      callId: 'c1',
      action: 'ring',
      relatedAgents: ['q1_201', 'q1_203'],
    },
    NOW,
  );
  applyServiceEvent(
    queues,
    {
      event: 'serviceCall',
      eventTrigger: 'service.call_update',
      id: 'q1',
      callId: 'c1',
      action: 'cancel',
      relatedAgents: ['q1_203'],
    },
    NOW,
  );
  assert.deepEqual(q.calls.get('c1').ringing, ['q1_201']);
  applyServiceEvent(
    queues,
    {
      event: 'serviceCall',
      eventTrigger: 'service.call_update',
      id: 'q1',
      callId: 'c1',
      action: 'answer',
      relatedAgents: ['q1_201'],
      answerTime: NOW + 5,
    },
    NOW,
  );
  assert.equal(q.calls.get('c1').answeredBy, 'q1_201');
  assert.equal(q.calls.get('c1').answeredAt, NOW + 5);

  // an update that no longer lists the answered call keeps it until its call_end; a waiting one is dropped
  applyServiceEvent(
    queues,
    {event: 'serviceCall', eventTrigger: 'service.call_init', id: 'q1', callId: 'c2', startTime: NOW},
    NOW,
  );
  applyServiceEvent(queues, {event: 'service', eventTrigger: 'service.update', id: 'q1', calls: []}, NOW);
  assert.deepEqual([...q.calls.keys()], ['c1']);
  assert.deepEqual(
    q.agents.map((a) => a.id),
    ['q1_201'],
    'an update without agents keeps them',
  );

  applyServiceEvent(queues, {event: 'service_stats_update', id: 'q1', stats: {offered: 3}}, NOW);
  assert.deepEqual(q.stats, {offered: 3});
  applyServiceEvent(queues, {event: 'serviceCall', eventTrigger: 'service.call_end', id: 'q1', callId: 'c1'}, NOW);
  assert.equal(q.calls.size, 0);
  applyServiceEvent(queues, {event: 'service', eventTrigger: 'service.end', id: 'q1'}, NOW);
  assert.equal(queues.size, 0);
  applyServiceEvent(queues, {event: 'serviceCall', id: 'q9', callId: 'c9'}, NOW);
  assert.equal(queues.size, 0, 'a call of an unknown queue is ignored');
});
