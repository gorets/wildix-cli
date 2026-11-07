// Text output of `wx live`: queues, agents, conversations and presence as aligned tables, the events of `watch` and
// `transcript --follow` as one readable line each. The JSON output is the data itself (src/live/views.mjs).
import {duration, localTime, oneLine, paint, table} from 'wldx-core/format';

// Agents are listed under their queue when this many queues or fewer are shown (else the table of queues only).
export const AGENT_LIST_MAX = 10;

const clockTime = (value) => localTime(value, {seconds: true}).slice(11);
const num = (v) => (v === null || v === undefined ? '' : String(v));
const percent = (v) => (v === null || v === undefined ? '-' : `${v}%`);
const secs = (v) => (v === null || v === undefined ? '-' : duration(v));
const isPaused = (a) => a?.paused === true || a?.paused === 'true';

// A person in a call: name, else phone, else extension; the extension in brackets when there is a name.
function who(p) {
  if (!p) return '';
  const ext = p.extension ?? p.userExtension;
  const name = p.name || p.phone || ext || '';
  return ext && name !== ext ? `${name} (${ext})` : String(name);
}

function agentStatus(a, c) {
  const status = isPaused(a) ? 'paused' : String(a.status ?? '');
  if (status === 'available') return c.green(status);
  if (status === 'paused') return c.yellow(status);
  return c.dim(status);
}

function windowLabel(w) {
  if (!w) return '';
  return w.from ? `since ${localTime(w.from)}${w.minutes ? ` (${w.minutes} min)` : ''}` : '';
}

// One line of figures: of a queue, or of all the queues shown.
export function figuresLine(s) {
  if (!s) return '';
  const parts = [
    `offered ${num(s.offered)}`,
    `answered ${num(s.answered)}`,
    `abandoned ${num(s.abandoned)}${s.shortAbandoned ? ` (${s.shortAbandoned} short)` : ''}`,
    `SL ${percent(s.serviceLevel)}${s.slaSeconds ? ` (${s.slaSeconds} s)` : ''}`,
    `ASA ${secs(s.asaSeconds)}`,
    `talk ${secs(s.avgTalkSeconds)}`,
  ];
  if (s.now)
    parts.push(
      `waiting ${num(s.now.waiting)}${s.now.longestWaitSeconds ? ` (longest ${duration(s.now.longestWaitSeconds)})` : ''}`,
      `talking ${num(s.now.talking)}`,
    );
  return parts.join(' · ');
}

function agentsTable(agents, c, withStats) {
  const head = [
    'AGENT',
    'EXT',
    'STATUS',
    'REASON',
    'MESSAGE',
    ...(withStats ? ['ANSWERED', 'MISSED', 'OCCUPANCY'] : []),
  ];
  const rows = agents.map((a) => [
    a.name ?? '',
    a.extension ?? a.userExtension ?? '',
    agentStatus(a, c),
    a.reason ? (a.reason === 'DND' ? c.red(a.reason) : c.yellow(a.reason)) : '',
    oneLine(a.message ?? '', 40),
    ...(withStats ? [num(a.stats?.answered), num(a.stats?.missed), percent(a.stats?.occupancy)] : []),
  ]);
  return table([head.map((h) => c.dim(h)), ...rows]).map((l) => `  ${l}`);
}

export function queuesText(r, ctx) {
  const c = paint(ctx);
  const withStats = Boolean(r.stats);
  const lines = [];
  const pbxCount = r.pbxs ? Object.keys(r.pbxs).length : 0;
  lines.push(
    `${r.total} queue${r.total === 1 ? '' : 's'}${pbxCount ? ` on ${pbxCount} PBXs` : ''}, ${r.callsWaitingOrTalking} call${r.callsWaitingOrTalking === 1 ? '' : 's'} waiting or talking`,
  );
  if (withStats) lines.push(`All shown ${windowLabel(r.stats.window)}: ${figuresLine(r.stats)}`);
  if (!r.queues?.length) return lines;
  lines.push('');
  const head = [
    'QUEUE',
    'CALLS',
    'AVAILABLE',
    'PAUSED',
    'STRATEGY',
    ...(pbxCount ? ['PBX'] : []),
    ...(withStats ? ['OFFERED', 'ANSWERED', 'ABANDONED', 'SL', 'ASA', 'WAITING'] : []),
  ];
  const rows = r.queues.map((q) => {
    const agents = q.agents ?? [];
    const available = agents.filter((a) => a.status === 'available' && !isPaused(a)).length;
    const paused = agents.filter(isPaused).length;
    const s = q.figures ?? q.stats; // with --full: the raw stats and the figures beside them
    return [
      oneLine(q.name ?? q.id, 40),
      q.calls ? c.bold(String(Array.isArray(q.calls) ? q.calls.length : q.calls)) : '0',
      `${available}/${agents.length}`,
      paused ? c.yellow(String(paused)) : '0',
      q.strategy ?? '',
      ...(pbxCount ? [q.pbx ?? ''] : []),
      ...(withStats
        ? [
            num(s?.offered),
            num(s?.answered),
            num(s?.abandoned),
            percent(s?.serviceLevel),
            secs(s?.asaSeconds),
            num(s?.now?.waiting),
          ]
        : []),
    ];
  });
  lines.push(...table([head.map((h) => c.dim(h)), ...rows]));
  if (r.queues.length > AGENT_LIST_MAX) {
    ctx?.info?.(
      `The agents are listed for ${AGENT_LIST_MAX} queues or fewer: narrow with --name, --busy, --paused or --active, or use --output json.`,
    );
    return lines;
  }
  for (const q of r.queues) {
    lines.push(
      '',
      c.bold(`${q.name ?? q.id}`) +
        c.dim(` · ${q.strategy ?? ''}${q.maxCalls ? ` · max ${q.maxCalls} calls` : ''} · ${q.id}`),
    );
    if (Array.isArray(q.callIds) && q.callIds.length) lines.push(`  calls: ${q.callIds.join(', ')}`);
    if (q.figures ?? q.stats) lines.push(`  ${figuresLine(q.figures ?? q.stats)}`);
    if (q.agents?.length) lines.push(...agentsTable(q.agents, c, withStats));
    else lines.push(c.dim('  no agents'));
  }
  return lines;
}

const lastFlow = (item) => (Array.isArray(item.flows) ? item.flows.at(-1) : undefined);

// One conversation: [type, status, who, detail].
function conversationCells(item) {
  if (item.type === 'call' || item.event === 'call') {
    const f = lastFlow(item) ?? {};
    const legs = Array.isArray(item.flows) && item.flows.length > 1 ? ` · ${item.flows.length} legs` : '';
    return [
      'call',
      f.status ?? '',
      `${who(f.caller)} → ${who(f.callee)}`,
      [f.direction, f.queue && `queue ${f.queue}`, f.transcription && `transcription ${f.transcription}`]
        .filter(Boolean)
        .join(' · ') + legs,
    ];
  }
  const sentiment = item.insights?.sentiment !== undefined ? `sentiment ${item.insights.sentiment}` : '';
  if (item.type === 'chat' || item.event === 'chat') {
    const people = (item.customers ?? [])
      .map((p) => p.name)
      .filter(Boolean)
      .join(', ');
    return [
      'chat',
      item.status ?? '',
      people,
      [item.subject && oneLine(item.subject, 60), sentiment].filter(Boolean).join(' · '),
    ];
  }
  if (item.type === 'conference' || item.event === 'conference') {
    return [
      'conference',
      '',
      `${item.participants?.length ?? 0} participants`,
      [item.subject && oneLine(item.subject, 60), sentiment].filter(Boolean).join(' · '),
    ];
  }
  return [String(item.type ?? item.event ?? ''), '', '', item.key ?? ''];
}

export function conversationsText(r, ctx) {
  const c = paint(ctx);
  const counts = Object.entries(r.byType ?? {})
    .map(([k, n]) => `${k}s ${n}`)
    .join(', ');
  const lines = [
    `${r.total} in progress${counts ? ` (all: ${counts})` : ''}${r.shown < r.total ? `, newest ${r.shown} shown` : ''}`,
  ];
  if (!r.items?.length) return lines;
  lines.push('');
  const rows = r.items.map((item) => [
    localTime(item.start),
    ...conversationCells(item).map((v, i) => (i === 1 && v ? c.cyan(v) : oneLine(v, 80))),
    c.dim(item.id ?? ''),
  ]);
  lines.push(...table([['STARTED', 'TYPE', 'STATUS', 'WHO', 'DETAIL', 'ID'].map((h) => c.dim(h)), ...rows]));
  return lines;
}

function presenceStatus(status, c) {
  const s = String(status ?? '');
  if (s === 'ONLINE' || s === 'AVAILABLE') return c.green(s);
  if (s === 'DND') return c.red(s);
  if (s === 'AWAY') return c.yellow(s);
  return c.dim(s);
}

export function presenceText(r, ctx) {
  const c = paint(ctx);
  const rows = (r.presence ?? []).map((p) => [
    p.extension ?? '',
    presenceStatus(p.status, c),
    oneLine(p.message ?? '', 50),
    p.until ? localTime(p.until) : '',
    p.phone ?? p.telephony ?? '',
    p.company ? `company ${p.company}` : '',
  ]);
  return table([['EXT', 'STATUS', 'MESSAGE', 'UNTIL', 'PHONE', ''].map((h) => c.dim(h)), ...rows]);
}

const textLine = (t) =>
  `${t.at !== undefined ? `[${clockTime(t.at)}] ` : ''}${t.name ?? t.speaker ?? '?'}: ${t.text ?? ''}`;

export function transcriptText(r, ctx) {
  const c = paint(ctx);
  const head = [`${r.type} ${r.id}`];
  if (r.call) {
    const [, status, people] = conversationCells(r.call);
    head.push([status, people].filter(Boolean).join(' · '));
  }
  const lines = [c.bold(head.filter(Boolean).join(': '))];
  if (!r.transcript?.length) lines.push(c.dim('nothing transcribed yet'));
  for (const t of r.transcript ?? []) lines.push(textLine(t));
  for (const a of r.annotations ?? []) lines.push(c.dim(`${a.key}: ${oneLine(JSON.stringify(a.payload), 100)}`));
  return lines;
}

// One event of `watch` or `transcript --follow` as one line: the local time, the event, what it says.
export function eventText(e, ctx) {
  const c = paint(ctx);
  const d = e.data ?? {};
  let what;
  switch (e.event) {
    case 'READY':
    case 'RECONNECTED':
      what = `watching ${(d.topics ?? []).join(', ') || 'nothing'}${d.calls ? ' (calls only)' : ''}${d.mine ? ' (my calls)' : ''}${d.extension ? ` · extension ${d.extension}` : ''}${d.license ? ` · ${d.license}` : ''}`;
      break;
    case 'RECONNECTING':
      what =
        d.reason === 'token'
          ? 'renewing the login'
          : `connection lost (code ${d.code}), attempt ${d.attempt} in ${d.inSeconds} s`;
      break;
    case 'ERROR':
      what = c.red(`${d.message}${d.code ? ` (${d.code})` : ''}`);
      break;
    case 'QUEUES':
      what = `${d.queues} queues known${d.stats ? ` · stats ${d.stats.periodMinutes ? `last ${d.stats.periodMinutes} min` : 'today'}, SLA ${d.stats.serviceLevelSeconds} s` : ''}`;
      break;
    case 'QUEUE': {
      const agents = (d.agents ?? []).map((a) =>
        `${a.name ?? a.extension ?? a.userExtension ?? '?'} ${isPaused(a) ? 'paused' : (a.status ?? '')}${a.reason ? ` ${a.reason}` : ''}${a.message ? ` "${oneLine(a.message, 30)}"` : ''}`.trim(),
      );
      what = [d.trigger ?? d.eventTrigger, d.name ?? d.id, d.calls ? `${d.calls} calls` : '', agents.join('; ')]
        .filter(Boolean)
        .join(' · ');
      break;
    }
    case 'QUEUE_CALL':
      what = [
        d.trigger ?? d.eventTrigger,
        `queue ${d.queueId ?? d.id}`,
        `call ${d.callId}`,
        d.direction,
        d.customer && (typeof d.customer === 'object' ? (d.customer.phone ?? d.customer.name) : d.customer),
        d.agents !== undefined && `${d.agents} agents`,
      ]
        .filter(Boolean)
        .join(' · ');
      break;
    case 'QUEUE_STATS':
      what = `${d.name ?? d.id}: ${figuresLine(d)}`;
      break;
    case 'PRESENCE':
      what = [
        d.extension,
        d.status,
        d.message && `"${oneLine(d.message, 40)}"`,
        d.until && `until ${localTime(d.until)}`,
        d.phone ?? d.telephony,
      ]
        .filter(Boolean)
        .join(' · ');
      break;
    case 'SNAPSHOT':
      what = `${d.type} ${d.id}: ${d.transcript?.length ?? 0} lines so far${(d.transcript ?? []).map((t) => `\n  ${textLine(t)}`).join('')}`;
      break;
    case 'TEXT':
      what = `${d.final === false ? c.dim('(partial) ') : ''}${textLine(d)}`;
      break;
    case 'ANNOTATION':
      what = `${d.key}: ${oneLine(JSON.stringify(d.payload), 100)}`;
      break;
    case 'END':
      what = `${d.id} ended (${d.event})`;
      break;
    default: {
      if (/^(CALL|CHAT|CONFERENCE)(_|$)/.test(e.event)) {
        const [, status, people, detail] = conversationCells(d);
        const extra = d.key ? `${d.key}${d.insights ? ` ${oneLine(JSON.stringify(d.insights), 80)}` : ''}` : '';
        what = [d.trigger, status, people, detail, extra, c.dim(d.id ?? '')]
          .filter(Boolean)
          .map((v) => oneLine(v, 100))
          .join(' · ');
      } else {
        what = oneLine(JSON.stringify(d), 140);
      }
    }
  }
  return `${c.dim(clockTime(ctx?.clock ? ctx.clock() : Date.now()))} ${c.bold(e.event)} ${what}`;
}
