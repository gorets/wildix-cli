// Queue statistics of the live stream of Wildix Data Analytics (WDA): the subscribe options that ask for them and
// the figures derived from the raw counters. Pure functions, no I/O (ported unchanged from the stats.mjs of the
// wildix-live-monitor skill, which its dashboard shares).
//
// The services topic sends counters, never rates: with stats asked for, every service of the subscribe snapshot
// carries `stats`, and later changes come as `service_stats_update` events (at most one per 5 seconds per queue,
// and at each 15-minute bucket roll-over). Counters of a window are added when a call progresses: offered when it
// enters the queue, answered when it is answered, the rest (abandoned, unanswered, talk, wrap-up) when it ends.

export const SLA_SECONDS = [5, 10, 15, 20, 25, 30];
export const WINDOWS = ['today', '15', '30', '45', '60'];

const round = (n, d = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
const ratio = (a, b) => (b ? a / b : null);
const pct = (a, b) => round(b ? (a / b) * 100 : null, 1);
const sec = (ms) => round(ms === null || ms === undefined ? null : ms / 1000);
const min = (ms) => round(ms === null || ms === undefined ? null : ms / 60000, 1);
const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : undefined);

// The subscribe options of a stats window: `today` from the local midnight (WDA keeps hourly UTC buckets, so the
// day must start on a whole UTC hour: in a zone with a half-hour offset the window starts at the UTC hour before
// the local midnight), or the last 15, 30, 45 or 60 minutes. sla: the answer-within target, one of SLA_SECONDS.
export function statsOptions(window = 'today', sla = 20, now = Date.now()) {
  const base = {stats: true, serviceLevelSeconds: sla};
  if (window !== 'today') return {...base, periodMinutes: Number(window)};
  const offset = -new Date(now).getTimezoneOffset();
  if (offset % 60 === 0) return {...base, periodStart: 'today', utcOffsetMinutes: offset};
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {...base, periodStartAt: Math.floor(midnight.getTime() / 3600000) * 3600000};
}

// The figures of one queue's stats (or of the sum of several, see sumStats). Rates follow the definitions of the
// service: service level = answeredWithinSl / (answered + abandoned - shortAbandoned + unanswered), short abandons
// (within 5 s, likely misdials) left out of the base; ASA = answeredWaitSumMs / answered.
export function queueFigures(s, now = Date.now()) {
  if (!s) return undefined;
  const base = s.answered + (s.abandoned - s.shortAbandoned) + s.unanswered;
  return {
    window: {from: iso(s.windowStartedAt), minutes: round(s.periodSeconds / 60)},
    offered: s.offered,
    answered: s.answered,
    abandoned: s.abandoned,
    shortAbandoned: s.shortAbandoned,
    unanswered: s.unanswered,
    transferred: s.transferred,
    unknown: s.unknown,
    outbound: s.outbound,
    serviceLevel: pct(s.answeredWithinSl, base),
    slaSeconds: s.serviceLevelSeconds,
    answeredWithinSla: s.answeredWithinSl,
    abandonRate: pct(s.abandoned - s.shortAbandoned, base),
    asaSeconds: sec(ratio(s.answeredWaitSumMs, s.answered)),
    avgTalkSeconds: sec(ratio(s.talkSumMs, s.talkCount)),
    avgRingSeconds: sec(ratio(s.ringSumMs, s.ringCount)),
    maxWaitSeconds: sec(s.maxWaitMs || null),
    wrapUpMinutes: min(s.acwSumMs),
    now: {
      waiting: s.callsWaiting,
      longestWaitSeconds: s.longestWaitStartedAt ? sec(now - s.longestWaitStartedAt) : 0,
      talking: s.callsActive,
      agents: {
        total: s.agentsTotal,
        available: s.agentsAvailable,
        talking: s.agentsTalking,
        paused: s.agentsPaused,
        wrapUp: s.agentsWrapUp,
        loggedOff: s.agentsLoggedOff,
      },
    },
  };
}

const SUMMED = [
  'offered',
  'outbound',
  'answered',
  'unanswered',
  'unknown',
  'abandoned',
  'shortAbandoned',
  'transferred',
  'answeredWaitSumMs',
  'abandonedWaitSumMs',
  'unansweredWaitSumMs',
  'waitCount',
  'talkSumMs',
  'talkCount',
  'acwSumMs',
  'ringSumMs',
  'ringCount',
  'answeredWithinSl',
  'callsWaiting',
  'callsActive',
  'agentsTotal',
  'agentsAvailable',
  'agentsTalking',
  'agentsPaused',
  'agentsWrapUp',
  'agentsLoggedOff',
];

// The counters of several queues added up (counters first, rates after: never an average of rates). An agent in
// two queues counts in both agent totals.
export function sumStats(list) {
  const items = list.filter(Boolean);
  if (!items.length) return undefined;
  const out = {};
  for (const k of SUMMED) out[k] = items.reduce((n, s) => n + (s[k] ?? 0), 0);
  out.maxWaitMs = Math.max(...items.map((s) => s.maxWaitMs ?? 0));
  const waits = items.map((s) => s.longestWaitStartedAt).filter(Boolean);
  if (waits.length) out.longestWaitStartedAt = Math.min(...waits);
  out.windowStartedAt = Math.min(...items.map((s) => s.windowStartedAt ?? Infinity));
  out.periodSeconds = Math.max(...items.map((s) => s.periodSeconds ?? 0));
  const slas = [...new Set(items.map((s) => s.serviceLevelSeconds))];
  out.serviceLevelSeconds = slas.length === 1 ? slas[0] : undefined;
  return out;
}

// The figures of one agent in the window. Occupancy: the share of the time ready for calls that was spent on
// calls, busyMs / (availableMs + busyMs).
export function agentFigures(a) {
  if (!a) return undefined;
  return {
    offered: a.offered,
    answered: a.answered,
    missed: a.missed,
    answerRate: pct(a.answered, a.offered),
    avgTalkSeconds: sec(ratio(a.talkSumMs, a.talkCount)),
    avgRingToAnswerSeconds: sec(ratio(a.ringToAnswerSumMs, a.ringToAnswerCount)),
    loggedInMinutes: min(a.loggedInMs),
    availableMinutes: min(a.availableMs),
    busyMinutes: min(a.busyMs),
    pausedMinutes: min(a.pausedMs),
    wrapUpMinutes: min(a.wrapUpMs),
    occupancy: pct(a.busyMs, (a.availableMs ?? 0) + (a.busyMs ?? 0)),
  };
}

// The per-agent counters of a queue are keyed by the agent id, <queue id>_<extension>: the same person has another
// id in every queue. Added up per extension, for a person's figures across queues.
export function agentStatsByExtension(services) {
  const out = new Map();
  for (const s of services) {
    for (const [id, a] of Object.entries(s.stats?.agentStats ?? {})) {
      const ext =
        s.agents?.find((x) => x.id === id)?.userExtension ??
        (id.startsWith(`${s.id}_`) ? id.slice(s.id.length + 1) : id);
      const prev = out.get(ext);
      if (!prev) out.set(ext, {...a});
      else for (const [k, v] of Object.entries(a)) if (typeof v === 'number') prev[k] = (prev[k] ?? 0) + v;
    }
  }
  return out;
}

// ── keeping a queue current from the events of the services topic ─────────────────────────────────────────────
// A `service` event with eventTrigger service.init or service.update carries the whole queue; agent_join the
// agents that joined, agent_leave the ids of those that left (nothing else), agent_update only what changed of the
// agents named; service.end removes the queue. A `serviceCall` event (call_init, call_update, call_end) is one
// call of a queue, with `action` (ring, cancel, answer, …) and the agents it concerns (relatedAgents).
// `service_stats_update` replaces the stats.
export function applyServiceEvent(queues, raw, now = Date.now()) {
  const id = raw?.id;
  if (!id) return;
  const q = queues.get(id);
  const ev = raw.event;
  const trigger = raw.eventTrigger ?? '';
  if (ev === 'service_stats_update' || trigger === 'service.stats_update') {
    if (q && raw.stats) q.stats = raw.stats;
    return;
  }
  if (ev === 'service') {
    if (trigger === 'service.end') {
      queues.delete(id);
      return;
    }
    const next = q ?? {id, agents: [], calls: new Map()};
    for (const k of ['pbx', 'name', 'strategy', 'maxCalls', 'aclGroup', 'timeZone'])
      if (raw[k] !== undefined) next[k] = raw[k];
    const agents = Array.isArray(raw.agents) ? raw.agents : [];
    if (trigger === 'service.agent_leave') {
      const gone = new Set(agents.map((a) => a.id));
      next.agents = next.agents.filter((a) => !gone.has(a.id));
    } else if (trigger === 'service.agent_update' && q) {
      for (const a of agents) {
        const i = next.agents.findIndex((x) => x.id === a.id);
        if (i < 0) continue;
        const prev = next.agents[i];
        const merged = {...prev, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined))};
        if (
          merged.status !== prev.status ||
          String(merged.paused) !== String(prev.paused) ||
          merged.reason !== prev.reason
        )
          merged.since = raw.time ?? now;
        next.agents[i] = merged;
      }
    } else if (trigger === 'service.agent_join' && q) {
      for (const a of agents) {
        const i = next.agents.findIndex((x) => x.id === a.id);
        const added = {...a, since: raw.time ?? now};
        if (i < 0) next.agents.push(added);
        else next.agents[i] = added;
      }
    } else if (agents.length || !q) {
      const prevById = new Map(next.agents.map((a) => [a.id, a]));
      next.agents = agents.filter((a) => a.userExtension).map((a) => ({...a, since: prevById.get(a.id)?.since}));
    }
    // service.init and service.update list the calls waiting in the queue: a waiting call that is no longer listed
    // has left it; answered calls are not listed and stay until their call_end.
    if (Array.isArray(raw.calls) && (trigger === 'service.init' || trigger === 'service.update')) {
      const listed = new Set(raw.calls.map(String));
      for (const [cid, c] of next.calls)
        if (!c.answeredBy && c.direction !== 'outgoing' && !listed.has(cid)) next.calls.delete(cid);
      for (const cid of listed) if (!next.calls.has(cid)) next.calls.set(cid, {callId: cid, direction: 'incoming'});
    }
    if (raw.stats) next.stats = raw.stats;
    queues.set(id, next);
    return;
  }
  if ((ev === 'serviceCall' || ev === 'service_call' || (!ev && raw.callId)) && q && raw.callId) {
    if (trigger === 'service.call_end') {
      q.calls.delete(raw.callId);
      return;
    }
    const c = q.calls.get(raw.callId) ?? {callId: raw.callId, ringing: []};
    c.direction = raw.direction ?? c.direction ?? 'incoming';
    c.start = raw.startTime ?? c.start ?? raw.time ?? now;
    if (raw.customer) c.customer = raw.customer;
    c.ringing ??= [];
    const related = raw.relatedAgents ?? [];
    if (raw.action === 'ring') c.ringing = [...new Set([...c.ringing, ...related])];
    else if (raw.action === 'cancel') c.ringing = c.ringing.filter((x) => !related.includes(x));
    else if (raw.action === 'answer') {
      c.ringing = [];
      c.answeredBy = related[0];
      c.answeredAt = raw.answerTime ?? raw.time ?? now;
    }
    q.calls.set(raw.callId, c);
  }
}
