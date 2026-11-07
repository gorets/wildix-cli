// What the live commands print, from the items of the WDA live stream: short views by default, the raw items with
// `full`. Ported from live.mjs of the wildix-live-monitor skill (same fields, same order, same filters), as pure
// functions: the commands in src/commands/live.mjs only connect, subscribe and hand the items over.
import {agentFigures, queueFigures, sumStats} from './stats.mjs';

export const drop = (o) => JSON.parse(JSON.stringify(o)); // removes the undefined fields

const isPaused = (a) => a?.paused === 'true' || a?.paused === true;

// The view functions bound to one run: full (raw items), company and extension of the login, the clock.
export function makeViews({full = false, company, myExtension, now = () => Date.now()} = {}) {
  // Left out unless full: e-mail, public IP address, geographic location and user agent of people.
  function party(p) {
    if (!p) return undefined;
    if (full) return p;
    return drop({
      name: p.name,
      phone: p.phone,
      extension: p.userExtension,
      department: p.userDepartment,
      group: p.groupName,
      type: p.type,
      role: p.role,
      device: p.userDevice,
      sipCallId: p.sipCallId,
    });
  }

  function flowView(f) {
    return drop({
      flowIndex: f.flowIndex,
      status: f.status,
      direction: f.direction,
      caller: party(f.caller),
      callee: party(f.callee),
      destination: f.destination,
      queue: f.queue ?? f.service,
      start: f.startTime ? new Date(f.startTime).toISOString() : undefined,
      talkSeconds: f.talkTime ? Math.round(f.talkTime / 1000) : undefined,
      waitSeconds: f.waitTime ? Math.round(f.waitTime / 1000) : undefined,
      holdSeconds: f.holdTime ? Math.round(f.holdTime / 1000) : undefined,
      recording: f.recordings?.length ? true : undefined,
      transcription: f.transcriptionStatus,
      tags: f.tags?.length ? f.tags : undefined,
    });
  }

  function insights(a) {
    if (!a) return undefined;
    const v = (k) => a[`copilot.${k}`]?.payload?.metric?.value;
    return drop({sentiment: v('sentiment'), csat: v('csat'), topics: v('topics'), signals: v('signals')});
  }

  function conversationView(c) {
    if (full) return c;
    const base = {id: c.id, type: c.event, trigger: c.eventTrigger, start: c.start};
    if (c.event === 'call') return drop({...base, flows: (Array.isArray(c.flows) ? c.flows : []).map(flowView)});
    if (c.event === 'chat') {
      return drop({
        ...base,
        status: c.status,
        subject: c.subject,
        direction: c.direction,
        channelId: c.channelId,
        customers: c.customers?.map((p) => drop({name: p.name, company: p.company})),
        agents: c.agents?.map((p) => drop({name: p.name, bot: p.bot || undefined})),
        tags: c.tags?.length ? c.tags : undefined,
        insights: insights(c.annotationsByKey),
      });
    }
    if (c.event === 'conference') {
      return drop({
        ...base,
        subject: c.subject,
        participants: c.participants?.map((p) => drop({name: p.name, role: p.role, type: p.type})),
        insights: insights(c.annotationsByKey),
      });
    }
    // completions and annotations: say what ended or changed, not more
    return drop({
      ...base,
      flows: typeof c.flows === 'number' ? c.flows : undefined,
      key: c.key,
      insights: insights(c.annotationsByKey),
    });
  }

  function agentView(a, stats) {
    if (full) return stats ? {...a, stats: agentFigures(stats)} : a;
    return drop({
      name: a.name,
      extension: a.userExtension,
      department: a.department,
      status: a.status,
      paused: isPaused(a) || undefined,
      reason: a.reason || undefined,
      message: a.message || undefined,
      stats: stats ? agentFigures(stats) : undefined,
    });
  }

  function queueView(s) {
    const agentStats = s.stats?.agentStats ?? {};
    if (full) return s.stats ? {...s, figures: queueFigures(s.stats, now())} : s;
    return drop({
      id: s.id,
      name: s.name,
      pbx: s.pbx,
      strategy: s.strategy,
      maxCalls: s.maxCalls ? Number(s.maxCalls) : undefined,
      calls: s.calls?.length ?? 0,
      callIds: s.calls?.length ? s.calls : undefined,
      stats: queueFigures(s.stats, now()),
      agents: s.agents?.map((a) => agentView(a, s.stats ? agentStats[a.id] : undefined)),
    });
  }

  function serviceCallView(c) {
    if (full) return c;
    return drop({
      queueId: c.id,
      trigger: c.eventTrigger,
      callId: c.callId,
      direction: c.direction,
      customer: c.customer?.phone ?? c.customer?.name,
      start: c.startTime ? new Date(c.startTime).toISOString() : undefined,
      agents: c.relatedAgents?.length,
    });
  }

  function presenceView(p) {
    if (full) return p;
    return drop({
      extension: p.extension,
      company: p.company !== company ? p.company : undefined,
      status: p.status,
      message: p.message || undefined,
      until: p.until || undefined,
      phone: p.telephony,
    });
  }

  function textView(chunk, call) {
    const flow = Array.isArray(call?.flows) ? call.flows.find((f) => f.flowIndex === chunk.flowIndex) : undefined;
    const who = chunk.speaker === 'caller' ? flow?.caller : chunk.speaker === 'callee' ? flow?.callee : undefined;
    return drop({
      flow: chunk.flowIndex,
      speaker: chunk.speaker ?? chunk.participant?.name,
      name: who?.name ?? chunk.participant?.name ?? chunk.name,
      text: chunk.text,
      final: chunk.isFinal,
      at: chunk.start ?? chunk.time,
      language: chunk.language,
      sentiment: chunk.sentiment,
    });
  }

  const isMineCall = (c) =>
    Boolean(myExtension) &&
    Array.isArray(c.flows) &&
    c.flows.some((f) => f.caller?.userExtension === myExtension || f.callee?.userExtension === myExtension);

  return {
    full,
    company,
    myExtension,
    now,
    party,
    flowView,
    insights,
    conversationView,
    agentView,
    queueView,
    serviceCallView,
    presenceView,
    textView,
    isMineCall,
  };
}

// The last item of every id, in the order of their first appearance.
export const lastById = (items) => {
  const m = new Map();
  for (const it of items) if (it?.id) m.set(it.id, it);
  return [...m.values()];
};

// Transcription items: a stored transcript ({flowIndex, chunks: {id: chunk}}), a live line ({chunk}), or a
// conference transcript; each becomes chunks with the flow index kept.
export function chunksOf(item) {
  if (item?.chunk) return [{...item.chunk, flowIndex: item.flowIndex, participant: item.participant}];
  if (item?.chunks && typeof item.chunks === 'object')
    return Object.values(item.chunks).map((c) => ({...c, flowIndex: item.flowIndex}));
  return [];
}

// `queues`: the snapshot of the services topic, filtered and sorted, the queues with calls first.
//   filters: {pbx, name, busy, paused, active}; stats: whether the statistics were asked for
export function queuesResult(items, {pbx, name, busy, paused, active, stats} = {}, views = makeViews()) {
  let qs = lastById(items.filter((i) => i?.event === 'service'));
  if (pbx) qs = qs.filter((q) => q.pbx === pbx);
  const text = name?.toLowerCase();
  if (text) qs = qs.filter((q) => q.name?.toLowerCase().includes(text));
  if (busy) qs = qs.filter((q) => q.calls?.length);
  if (paused) qs = qs.filter((q) => q.agents?.some(isPaused));
  if (active) qs = qs.filter((q) => q.calls?.length || q.stats?.offered || q.stats?.outbound);
  qs.sort(
    (a, b) =>
      (b.calls?.length ?? 0) - (a.calls?.length ?? 0) ||
      (b.stats?.offered ?? 0) - (a.stats?.offered ?? 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const pbxs = [...new Set(qs.map((q) => q.pbx))];
  return drop({
    total: qs.length,
    callsWaitingOrTalking: qs.reduce((n, q) => n + (q.calls?.length ?? 0), 0),
    pbxs: pbxs.length > 1 ? Object.fromEntries(pbxs.map((p) => [p, qs.filter((q) => q.pbx === p).length])) : undefined,
    stats: stats ? queueFigures(sumStats(qs.map((q) => q.stats)), views.now()) : undefined,
    queues: qs.map(views.queueView),
  });
}

// `conversations`: the calls, chats and conferences of the snapshot, newest first.
//   kinds: ['call', 'chat', 'conference'] to keep (none: all); mine; status; limit (50)
export function conversationsResult(items, {kinds = [], mine, status, limit = 50} = {}, views = makeViews()) {
  let cs = lastById(items.filter((i) => ['call', 'chat', 'conference'].includes(i?.event)));
  const byType = {};
  for (const c of cs) byType[c.event] = (byType[c.event] ?? 0) + 1;
  if (kinds.length) cs = cs.filter((c) => kinds.includes(c.event));
  if (mine) cs = cs.filter(views.isMineCall);
  const want = status?.toUpperCase();
  if (want)
    cs = cs.filter(
      (c) =>
        String(c.status ?? (Array.isArray(c.flows) ? c.flows.at(-1)?.status : undefined) ?? '').toUpperCase() === want,
    );
  cs.sort((a, b) => String(b.start).localeCompare(String(a.start)));
  return {
    total: cs.length,
    byType,
    shown: Math.min(limit, cs.length),
    items: cs.slice(0, limit).map(views.conversationView),
  };
}

// `presence`: one entry per extension asked for, in the order given; `status: unknown` for nobody.
export function presenceResult(items, extensions, views = makeViews()) {
  const found = new Map(items.filter(Boolean).map((p) => [String(p.extension), p]));
  return {
    presence: extensions.map((ext) =>
      found.has(ext) ? views.presenceView(found.get(ext)) : {extension: ext, status: 'unknown'},
    ),
  };
}

// The WDA id of a call from the conversations snapshot, by the SIP call id of one of its parties.
export function callIdBySip(items, sipCallId) {
  const call = items.find(
    (c) =>
      c?.event === 'call' &&
      Array.isArray(c.flows) &&
      c.flows.some((f) => f.caller?.sipCallId === sipCallId || f.callee?.sipCallId === sipCallId),
  );
  return call?.id;
}

// `transcript`: what was said so far (final lines only), the call and its annotations.
export function transcriptSnapshot(items, id, kind, views = makeViews()) {
  const call = items.find((i) => i?.event === 'call' || i?.event === 'conference');
  const lines = items
    .flatMap(chunksOf)
    .filter((c) => c.text)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const annotations = items.filter((i) => String(i?.event).endsWith('_annotation'));
  return {
    call,
    snapshot: drop({
      id,
      type: kind,
      call: call ? views.conversationView(call) : undefined,
      transcript: lines.filter((c) => c.isFinal !== false).map((c) => views.textView(c, call)),
      annotations: annotations.length ? annotations.map((a) => drop({key: a.key, payload: a.payload})) : undefined,
    }),
  };
}

// `transcript --follow`: the events of one broadcast item. state.call is the call last seen (names the speakers).
// Returns {events: [{event, data}], end: boolean}.
export function transcriptEvents(it, id, state, views = makeViews()) {
  if (!it) return {events: [], end: false};
  if (it.event === 'call' || it.event === 'conference') {
    state.call = it;
    return {events: [{event: 'CALL', data: views.conversationView(it)}], end: false};
  }
  if (/_complete$|_interrupted$/.test(String(it.event)))
    return {events: [{event: 'END', data: {id, event: it.event}}], end: true};
  if (String(it.event).endsWith('_annotation'))
    return {events: [{event: 'ANNOTATION', data: drop({key: it.key, payload: it.payload})}], end: false};
  return {
    events: chunksOf(it)
      .filter((c) => c.text)
      .map((c) => ({event: 'TEXT', data: views.textView(c, state.call)})),
    end: false,
  };
}

// `watch`: turns the frames of the connection into events. o: {views, wantConv, wantQueues, wantStats, calls, mine,
// statsOpts(), explain(topic, d)}. frame(d) returns {events: [{event, data}], fatal?: message}; reset() is called
// on every (re)connection (with stats the queues are read again before QUEUE_STATS lines).
export function watchFrames(o) {
  const {views} = o;
  const full = views.full;
  const queueNames = new Map();
  const mineIds = new Set();
  let queuesReady = !o.wantStats;
  const ev = (event, data) => ({event, data: data ?? {}});

  function frame(d) {
    const events = [];
    if (d.event === 'error') {
      events.push(ev('ERROR', {message: o.explain(d.source?.topic ?? 'subscription', d), code: d.code}));
      return d.code === 403 ? {events, fatal: events[0].data.message} : {events};
    }
    if (d.event === 'subscribed' && d.topic === 'services' && !queuesReady) {
      queuesReady = true;
      events.push(ev('QUEUES', {queues: queueNames.size, stats: o.statsOpts()}));
      return {events};
    }
    if (d.event !== 'broadcast') return {events};
    for (const it of Array.isArray(d.data) ? d.data : [d.data]) {
      if (!it || typeof it !== 'object') continue;
      if (d.topic === 'presence') events.push(ev('PRESENCE', views.presenceView(it)));
      else if (d.topic === 'services') {
        if (it.event === 'service' && it.name) queueNames.set(it.id, it.name);
        if (!queuesReady) continue;
        if (it.event === 'service_stats_update') {
          if (!o.wantStats) continue;
          const agentStats = it.stats?.agentStats ?? {};
          events.push(
            ev(
              'QUEUE_STATS',
              full
                ? it
                : drop({
                    id: it.id,
                    name: queueNames.get(it.id),
                    ...queueFigures(it.stats, views.now()),
                    agents: Object.keys(agentStats).length
                      ? Object.fromEntries(
                          Object.entries(agentStats).map(([k, v]) => [
                            k.startsWith(`${it.id}_`) ? k.slice(String(it.id).length + 1) : k,
                            agentFigures(v),
                          ]),
                        )
                      : undefined,
                  }),
            ),
          );
          continue;
        }
        // A change names what changed (eventTrigger) and carries only that: usually one agent, no queue name.
        if (it.event === 'service')
          events.push(ev('QUEUE', full ? it : drop({trigger: it.eventTrigger, ...views.queueView(it)})));
        else if (it.event === 'serviceCall' || it.event === 'service_call')
          events.push(ev('QUEUE_CALL', views.serviceCallView(it)));
        else events.push(ev(String(it.event).toUpperCase(), full ? it : drop({id: it.id, trigger: it.eventTrigger})));
      } else if (d.topic === 'conversations') {
        const type = String(it.event);
        if (o.calls && !type.startsWith('call')) continue;
        if (o.mine) {
          if (type === 'call' && views.isMineCall(it)) mineIds.add(it.id);
          if (!mineIds.has(it.id)) continue;
          // The skill forgot the call at any other event (an annotation too); here only when it ends.
          if (/_complete$|_interrupted$/.test(type)) mineIds.delete(it.id);
        }
        events.push(ev(type.toUpperCase(), views.conversationView(it)));
      }
    }
    return {events};
  }

  return {
    frame,
    reset() {
      queuesReady = !o.wantStats;
    },
    get queueNames() {
      return queueNames;
    },
  };
}
