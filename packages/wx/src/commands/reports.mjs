// wx reports: the reports of the call queues (services, call groups) of the company over whole days, from the
// x-caracal service of WDA, and the list of the queues. Read only. Counts, never percentages from the service: a
// rate is computed from the counts (in the text only). A report covers one PBX: the one named by --pbx, else the
// PBX of the first --queue (its id is <company>_<pbx>_<number>), else the PBX of the login.
import {UsageError} from 'wldx-core/errors';
import {localTime, oneLine, table} from 'wldx-core/format';
import {apiPath, query} from 'wldx-core/http';
import {millis} from '../history/text.mjs';
import {callFlow, checkId, checkZone, intOption, plural, wdaClient} from '../history/wda.mjs';

export const OUTCOMES = [
  'offered',
  'received',
  'answered',
  'completed',
  'transferred',
  'abandoned',
  'unanswered',
  'lost',
  'lostAbandoned',
  'lostUnanswered',
  'overflow',
  'unknown',
];

const FILTER_OPTIONS = {
  from: {
    type: 'string',
    placeholder: 'YYYY-MM-DD',
    description: 'the first day (today when --from and --to are left out)',
  },
  to: {type: 'string', placeholder: 'YYYY-MM-DD', description: 'the last day, inclusive (today by default)'},
  days: {type: 'string', placeholder: 'N', description: 'the last N days, today included (1-90)'},
  tz: {type: 'string', placeholder: 'ZONE', description: "the zone the days are cut in (the PBX's own by default)"},
  pbx: {
    type: 'string',
    placeholder: 'SERIAL',
    description: 'the PBX of the report (else the PBX of the first --queue, else of the login)',
  },
  queue: {
    type: 'string',
    multiple: true,
    placeholder: 'ID',
    description: 'only these queues (ids from wx reports list)',
  },
  extension: {
    type: 'string',
    multiple: true,
    placeholder: 'EXT',
    description: 'only the calls these users answered, or that rang them unanswered',
  },
  outcome: {type: 'string', multiple: true, choices: OUTCOMES, description: 'only calls of these outcomes'},
  hours: {
    type: 'string',
    placeholder: 'HH:MM-HH:MM',
    description: 'the time of day the call entered the queue (slow: reads every call)',
  },
  weekday: {type: 'string', multiple: true, placeholder: '1-7', description: '1 = Monday … 7 = Sunday (slow)'},
  wait: {
    type: 'string',
    placeholder: 'FROM-TO',
    description: 'a band of wait seconds: more than FROM, at most TO (TO may be left out) (slow)',
  },
  talk: {type: 'string', placeholder: 'FROM-TO', description: 'a band of talk seconds (slow)'},
  reason: {
    type: 'string',
    multiple: true,
    placeholder: 'R',
    description: 'disconnect reasons: HANGUP, TRANSFER, TIMEOUT, EMPTY, EXITWITHKEY, … (slow)',
  },
  sla: {
    type: 'string',
    placeholder: 'S',
    description: 'the SLA threshold in seconds, 5 to 120 in steps of 5 (20 by default)',
  },
  'queue-sla': {type: 'string', multiple: true, placeholder: 'ID=S', description: 'the SLA threshold of one queue'},
};

const LADDER = {
  band: {type: 'string', placeholder: 'S', description: 'the width of a band in seconds (1-3600)'},
  steps: {type: 'string', placeholder: 'N', description: 'how many bands (1-60)'},
};

const pad2 = (n) => String(n).padStart(2, '0');
// The day N days before now, in the local time zone of the machine (as the script's strflocaltime).
const localDay = (now, back) => {
  const d = new Date(now);
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

function checkDay(name, value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3])
    throw new UsageError(`${name} must be a day as YYYY-MM-DD: ${value}`);
  return value;
}

function checkPbx(value) {
  if (!/^[A-Za-z0-9]{4,32}$/.test(value)) throw new UsageError(`not a PBX serial: ${value}`);
  return value;
}

function band(name, value) {
  const m = /^(\d{1,5})-(\d{1,5})?$/.exec(value);
  if (!m) throw new UsageError(`${name} is a band of seconds as FROM-TO or FROM-: ${value}`);
  return m[2] === undefined ? {from: Number(m[1])} : {from: Number(m[1]), to: Number(m[2])};
}

function slaSeconds(name, value) {
  const s = intOption(name, value, 5, 120);
  if (s % 5) throw new UsageError(`${name} is a multiple of 5: ${value}`);
  return s;
}

// The filter of a report (and of the calls) from the options.
export function reportFilter(v, now) {
  let from;
  let to;
  const days = intOption('--days', v.days, 1, 90);
  if (days !== undefined) {
    from = localDay(now, days - 1);
    to = localDay(now, 0);
  } else {
    to = v.to ? checkDay('--to', v.to) : localDay(now, 0);
    from = v.from ? checkDay('--from', v.from) : to;
  }
  if (from > to) throw new UsageError('--from is after --to');
  const f = {date: {from, to}};
  const tz = checkZone(v.tz);
  if (tz) f.date.timeZone = tz;
  const queues = (v.queue ?? []).map((q) => checkId('the queue id', q));
  let pbx = v.pbx === undefined ? undefined : checkPbx(v.pbx);
  if (!pbx && queues.length) {
    const parts = queues[0].split('_');
    const guess = parts.length > 1 ? parts[parts.length - 2] : '';
    if (/^[A-Za-z0-9]{4,32}$/.test(guess)) pbx = guess;
  }
  if (pbx) f.pbx = pbx;
  if (queues.length) f.serviceIds = queues;
  if (v.extension?.length) {
    for (const e of v.extension) if (!/^\d{1,15}$/.test(e)) throw new UsageError(`an extension is digits only: ${e}`);
    f.extensions = v.extension;
  }
  if (v.outcome?.length) f.outcomes = v.outcome;
  if (v.reason?.length) {
    for (const r of v.reason) if (!/^[A-Za-z_]{1,40}$/.test(r)) throw new UsageError(`not a disconnect reason: ${r}`);
    f.disconnectReasons = v.reason;
  }
  if (v.weekday?.length) {
    for (const d of v.weekday)
      if (!/^[1-7]$/.test(d)) throw new UsageError(`--weekday is 1 (Monday) to 7 (Sunday): ${d}`);
    f.daysOfWeek = v.weekday.map(Number);
  }
  if (v.hours !== undefined) {
    const m = /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.exec(v.hours);
    if (!m) throw new UsageError(`--hours is HH:MM-HH:MM: ${v.hours}`);
    f.hourRange = {from: m[1], to: m[2]};
  }
  if (v.wait !== undefined) f.waitSecondsRange = band('--wait', v.wait);
  if (v.talk !== undefined) f.talkSecondsRange = band('--talk', v.talk);
  if (v.sla !== undefined) f.slaSeconds = slaSeconds('--sla', v.sla);
  if (v['queue-sla']?.length) {
    f.serviceSlaSeconds = v['queue-sla'].map((x) => {
      const m = /^([A-Za-z0-9_+][A-Za-z0-9_.:+-]*)=(\d{1,3})$/.exec(x);
      if (!m) throw new UsageError(`--queue-sla is QUEUE_ID=SECONDS: ${x}`);
      return {serviceId: m[1], slaSeconds: slaSeconds('the SLA of a queue', m[2])};
    });
  }
  return f;
}

// The days of the report, for the heading of the text (not part of the JSON).
const withWindow = (r, filter) => Object.defineProperty(r, 'window', {value: filter.date, enumerable: false});

async function report(ctx, p, extra = {}) {
  const filter = reportFilter(ctx.values, ctx.now);
  const r = await ctx.client(wdaClient).post(`/xcaracal/${p}`, {filter, ...extra});
  return withWindow(r, filter);
}

function ladder(v, widthKey, stepsKey) {
  const o = {};
  const b = intOption('--band', v.band, 1, 3600);
  const s = intOption('--steps', v.steps, 1, 60);
  if (b !== undefined) o[widthKey] = b;
  if (s !== undefined) o[stepsKey] = s;
  return o;
}

// The queues: {total, pbxs: {pbx: n}, queues: [{id, name, pbx, aclGroup?}]}, by PBX and name.
export function shapeQueues(r, {pbx, name} = {}) {
  const needle = (name ?? '').toLowerCase();
  const list = (r.services ?? []).filter(
    (s) =>
      (!pbx || s.pbx === pbx) &&
      (!needle ||
        String(s.name ?? '')
          .toLowerCase()
          .includes(needle)),
  );
  const pbxs = {};
  for (const s of [...list].sort((a, b) => cmp(a.pbx, b.pbx))) pbxs[s.pbx] = (pbxs[s.pbx] ?? 0) + 1;
  const queues = [...list]
    .sort((a, b) => cmp(a.pbx, b.pbx) || cmp(a.name ?? '', b.name ?? ''))
    .map((s) =>
      Object.fromEntries(
        Object.entries({id: s.id, name: s.name, pbx: s.pbx, aclGroup: s.aclGroup ? s.aclGroup : null}).filter(
          ([, x]) => x !== null && x !== undefined,
        ),
      ),
    );
  return {total: list.length, pbxs, queues};
}

const cmp = (a, b) =>
  a === b ? 0 : a === undefined || a === null ? -1 : b === undefined || b === null ? 1 : a < b ? -1 : 1;

// Customers' numbers and names are shown only with --full.
const CALLER = ['callerPhone', 'callerName'];
const dropCaller = (row) => (row ? Object.fromEntries(Object.entries(row).filter(([k]) => !CALLER.includes(k))) : row);

// Text.

const n = (x) => (Number.isFinite(x) ? String(x) : '');
const rate = (within, eligible) =>
  eligible ? `${within}/${eligible} ${Math.round((100 * within) / eligible)}%` : 'no calls';
const slaText = (s) =>
  s ? `${rate(s.answeredWithin ?? s.abandonedWithin ?? 0, s.eligible ?? 0)} within ${s.thresholdSeconds ?? 20} s` : '';

function heading(r) {
  const w = r.window;
  const days = w ? (w.from === w.to ? w.from : `${w.from} … ${w.to}`) : '';
  return [days, r.pbx && `PBX ${r.pbx}`, r.timeZone].filter(Boolean).join(' · ');
}

function metricsRows(m = {}) {
  const c = m.counts ?? {};
  return [
    ['Offered', n(c.offered)],
    ['Received', n(c.received)],
    [
      'Answered',
      `${(c.completed ?? 0) + (c.transferred ?? 0)} (completed ${c.completed ?? 0}, transferred ${c.transferred ?? 0})`,
    ],
    ['Abandoned', `${c.abandoned ?? 0}${c.shortAbandoned ? ` (within 5 s: ${c.shortAbandoned})` : ''}`],
    ['Unanswered', n(c.unanswered ?? 0)],
    ['Lost', `${c.lost ?? 0} (abandoned ${c.lostAbandoned ?? 0}, unanswered ${c.lostUnanswered ?? 0})`],
    ['Overflow', n(c.overflow ?? 0)],
    ...(c.unknown ? [['Unknown', n(c.unknown)]] : []),
    ['Service level', slaText(m.sla)],
    ['Wait', `avg ${millis(m.avgWaitMs)}, max ${millis(m.maxWaitMs)}`],
    ['Talk', `avg ${millis(m.avgTalkMs)}, total ${millis(m.totalTalkMs)}`],
    ['Ring', `avg ${millis(m.avgRingMs)}`],
    ['Place in line', `deepest ${m.maxStartPosition ?? 0}`],
  ];
}

const METRIC_HEAD = ['Offered', 'Answered', 'Abandoned', 'Lost', 'Overflow', 'SLA', 'Avg wait', 'Max wait', 'Avg talk'];
const metricCells = (m = {}) => {
  const c = m.counts ?? {};
  return [
    n(c.offered ?? 0),
    n((c.completed ?? 0) + (c.transferred ?? 0)),
    n(c.abandoned ?? 0),
    n(c.lost ?? 0),
    n(c.overflow ?? 0),
    m.sla ? rate(m.sla.answeredWithin ?? 0, m.sla.eligible ?? 0) : '',
    millis(m.avgWaitMs),
    millis(m.maxWaitMs),
    millis(m.avgTalkMs),
  ];
};

// 1 = Monday … 7 = Sunday, as in the --weekday filter.
const ISO_WEEKDAYS = [undefined, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const periodLabel = (b, granularity) =>
  granularity === 'dayOfWeek'
    ? (ISO_WEEKDAYS[Number(b.bucketKey)] ?? b.bucketKey)
    : (b.bucketKey ?? b.bucketStart ?? '');

const who = (name, ext) => [name, ext && `(${ext})`].filter(Boolean).join(' ');

function groupKey(g, dimension) {
  switch (dimension) {
    case 'byAgent':
      return `${who(g.userName, g.userExtension) || g.agentId || '?'} · ${g.serviceName ?? g.serviceId ?? ''}`;
    case 'byUser':
      return who(g.userName, g.userExtension) || g.agentId || '?';
    case 'byDisconnectReason':
      return g.disconnectReason || '(none)';
    case 'byTalkTime':
      return g.band ? `${g.band.fromSeconds ?? 0}-${g.band.toSeconds ?? ''} s` : '?';
    default:
      return g.serviceName ?? g.serviceId ?? '?';
  }
}

function callLine(c, full) {
  return [
    localTime(c.enteredAt, {seconds: true}),
    oneLine(c.serviceName ?? c.serviceId ?? '', 30),
    c.outcome ?? '',
    `wait ${millis(c.waitMs)}`,
    c.answered ? `talk ${millis(c.talkMs)}` : '',
    c.answered ? who(c.answeredByName, c.answeredByExtension) : '',
    full ? oneLine(who(c.callerName, c.callerPhone), 40) : '',
    `${c.callId ?? ''} ${c.flowIndex ?? 0}`,
  ];
}

const group = {
  summary: 'reports of the call queues over days: service level, abandoned, lost, waits, agents',
  auth: true,
  commands: {
    list: {
      summary: 'the queues of the company: id, name, PBX (and how many on each PBX)',
      usage: 'wx reports list [--name TEXT] [--pbx SERIAL]',
      options: {
        name: {type: 'string', placeholder: 'TEXT', description: 'only queues whose name contains this text'},
        pbx: {type: 'string', placeholder: 'SERIAL', description: 'only the queues of this PBX'},
      },
      args: [0, 0],
      async run(ctx) {
        const {name, pbx} = ctx.values;
        if (pbx !== undefined) checkPbx(pbx);
        if (name !== undefined && name.length > 100) throw new UsageError('--name is too long');
        return shapeQueues(await ctx.client(wdaClient).post('/stream/services', {}), {pbx, name});
      },
      text(r) {
        const lines = [
          `${plural(r.total, 'queue')} · ${
            Object.entries(r.pbxs)
              .map(([p, k]) => `PBX ${p}: ${k}`)
              .join(', ') || 'no PBX'
          }`,
        ];
        if (r.queues.length) lines.push(...table(r.queues.map((q) => [q.pbx ?? '', oneLine(q.name ?? '', 50), q.id])));
        return lines;
      },
    },
    summary: {
      summary: 'every queue call of the filter: offered, answered, abandoned, lost, waits, talk, ring, the SLA counts',
      usage: 'wx reports summary [filter]',
      details:
        'Filter: --from/--to days or --days N (today by default; at most 90 days), --tz, --pbx, --queue, --extension, --outcome, --sla, --queue-sla; slow ones: --hours, --weekday, --wait, --talk, --reason.',
      options: FILTER_OPTIONS,
      args: [0, 0],
      run: (ctx) => report(ctx, 'distribution/summary/query'),
      text: (r) => [heading(r), ...table(metricsRows(r.metrics))],
    },
    'by-queue': {
      summary: 'the same figures per queue',
      usage: 'wx reports by-queue [filter]',
      options: FILTER_OPTIONS,
      args: [0, 0],
      run: (ctx) => report(ctx, 'distribution/by-service/query'),
      text: (r) => [
        heading(r),
        ...table([
          ['Queue', ...METRIC_HEAD],
          ...(r.groups ?? []).map((g) => [oneLine(g.serviceName ?? g.serviceId ?? '', 40), ...metricCells(g.metrics)]),
        ]),
      ],
    },
    'by-period': {
      summary: 'the same figures as a series (hour: the 24 hours of the day over the window)',
      usage: 'wx reports by-period --by hour|day|week|month|weekday [filter]',
      options: {
        ...FILTER_OPTIONS,
        by: {
          type: 'string',
          choices: ['hour', 'day', 'week', 'month', 'weekday'],
          description: 'the period of a bucket',
        },
      },
      args: [0, 0],
      run(ctx) {
        if (!ctx.values.by) throw new UsageError('by-period needs --by hour|day|week|month|weekday', ctx.usage());
        return report(ctx, 'distribution/by-period/query', {
          granularity: ctx.values.by === 'weekday' ? 'dayOfWeek' : ctx.values.by,
        });
      },
      text: (r) => [
        heading(r),
        ...table([
          ['Period', ...METRIC_HEAD],
          ...(r.buckets ?? []).map((b) => [periodLabel(b, r.granularity), ...metricCells(b.metrics)]),
        ]),
      ],
    },
    answered: {
      summary: 'the answered calls: summary, or grouped by queue, agent, user, reason or talk time',
      usage: 'wx reports answered [--by queue|agent|user|reason|talk-time] [--band S --steps N] [filter]',
      details:
        'agent: a person in one queue; user: a person over every queue; talk-time: bands of --band seconds, --steps of them. The breakdowns read every call of the window (slow).',
      options: {
        ...FILTER_OPTIONS,
        by: {
          type: 'string',
          choices: ['queue', 'agent', 'user', 'reason', 'talk-time'],
          description: 'group the calls',
        },
        ...LADDER,
      },
      args: [0, 0],
      run(ctx) {
        const v = ctx.values;
        if (v.by !== 'talk-time' && (v.band !== undefined || v.steps !== undefined))
          throw new UsageError('--band and --steps go with --by talk-time');
        if (!v.by) return report(ctx, 'answered/summary/query');
        const dimension = {
          queue: 'byService',
          agent: 'byAgent',
          user: 'byUser',
          reason: 'byDisconnectReason',
          'talk-time': 'byTalkTime',
        }[v.by];
        return report(ctx, 'answered/breakdown/query', {
          ...(dimension === 'byTalkTime' ? ladder(v, 'talkBandSeconds', 'talkBandSteps') : {}),
          dimension,
        });
      },
      text(r) {
        if (!r.groups) {
          return [
            heading(r),
            ...table([
              [
                'Answered',
                `${(r.completed ?? 0) + (r.transferred ?? 0)} (completed ${r.completed ?? 0}, transferred ${r.transferred ?? 0})`,
              ],
              ...(r.unknown ? [['Unknown', n(r.unknown)]] : []),
              ['Service level', slaText(r.sla)],
              ['Wait', `avg ${millis(r.avgWaitMs)}, max ${millis(r.maxWaitMs)}`],
              ['Talk', `avg ${millis(r.avgTalkMs)}, total ${millis(r.totalTalkMs)}`],
            ]),
          ];
        }
        return [
          `${heading(r)} · ${r.total ?? 0} answered`,
          ...table([
            ['', 'Calls', 'Completed', 'Transferred', 'Avg wait', 'Avg talk', 'Total talk'],
            ...r.groups.map((g) => [
              oneLine(groupKey(g, r.dimension), 60),
              n(g.calls ?? 0),
              n(g.completed ?? 0),
              n(g.transferred ?? 0),
              millis(g.avgWaitMs),
              millis(g.avgTalkMs),
              millis(g.totalTalkMs),
            ]),
          ]),
        ];
      },
    },
    unanswered: {
      summary: 'the abandoned and unanswered calls: summary (lost, overflow), or grouped by queue or reason',
      usage: 'wx reports unanswered [--by queue|reason] [filter]',
      options: {...FILTER_OPTIONS, by: {type: 'string', choices: ['queue', 'reason'], description: 'group the calls'}},
      args: [0, 0],
      run(ctx) {
        if (!ctx.values.by) return report(ctx, 'unanswered/summary/query');
        return report(ctx, 'unanswered/breakdown/query', {
          dimension: ctx.values.by === 'queue' ? 'byService' : 'byDisconnectReason',
        });
      },
      text(r) {
        if (!r.groups) {
          return [
            heading(r),
            ...table([
              ['Abandoned', `${r.abandoned ?? 0}${r.shortAbandoned ? ` (within 5 s: ${r.shortAbandoned})` : ''}`],
              ['Unanswered', n(r.unanswered ?? 0)],
              ['Lost', `${r.lost ?? 0} (abandoned ${r.lostAbandoned ?? 0}, unanswered ${r.lostUnanswered ?? 0})`],
              ['Overflow', n(r.overflow ?? 0)],
              ...(r.unknown ? [['Unknown', n(r.unknown)]] : []),
              ['Given up', slaText(r.sla)],
              [
                'Wait',
                `avg ${millis(r.avgWaitMs)}, max ${millis(r.maxWaitMs)}, abandoned avg ${millis(r.abandonedAvgWaitMs)}`,
              ],
              ['Place in line', `avg start ${n(r.avgStartPosition ?? 0)}, avg final ${n(r.avgFinalPosition ?? 0)}`],
            ]),
          ];
        }
        return [
          `${heading(r)} · ${r.total ?? 0} not answered`,
          ...table([
            ['', 'Abandoned', 'Unanswered', 'Lost', 'Overflow', 'Avg wait', 'Max wait'],
            ...r.groups.map((g) => [
              oneLine(groupKey(g, r.dimension), 60),
              n(g.abandoned ?? 0),
              n(g.unanswered ?? 0),
              n(g.lost ?? 0),
              n(g.overflow ?? 0),
              millis(g.avgWaitMs),
              millis(g.maxWaitMs),
            ]),
          ]),
        ];
      },
    },
    'service-level': {
      summary: 'how many calls were answered (or given up) within 20, 40, … seconds',
      usage: 'wx reports service-level answered|unanswered [--band S] [--steps N] [filter]',
      options: {...FILTER_OPTIONS, ...LADDER},
      args: [1, 1],
      run(ctx) {
        const kind = ctx.positionals[0];
        if (kind !== 'answered' && kind !== 'unanswered')
          throw new UsageError('service-level answered|unanswered', ctx.usage());
        return report(ctx, `${kind}/service-level/query`, ladder(ctx.values, 'waitBandSeconds', 'waitBandSteps'));
      },
      text(r, ctx) {
        const unanswered = ctx.positionals[0] === 'unanswered';
        const head = `${heading(r)} · ${r.total ?? 0} ${unanswered ? 'not answered' : 'answered'}${unanswered ? ` (lost ${r.lost ?? 0}, overflow ${r.overflow ?? 0})` : ''}`;
        const rows = (r.bands ?? []).map((b) => [
          `within ${b.withinSeconds} s`,
          n(b.count),
          `+${b.delta ?? 0}`,
          ...(unanswered ? [`lost ${b.lost ?? 0}`, `overflow ${b.overflow ?? 0}`] : []),
        ]);
        return [head, ...table(rows)];
      },
    },
    calls: {
      summary: 'the queue calls one by one, newest first: queue, times, wait, talk, outcome, who answered',
      usage: 'wx reports calls [--limit N] [--pages N] [--cursor C] [--call CALLID] [--full] [filter]',
      details:
        '50 a page (--limit up to 200); --pages follows the next pages (up to 20); --call: every queue a phone call went through. The caller (number and name) only with --full: show it when the user asks for the callers.',
      options: {
        ...FILTER_OPTIONS,
        limit: {type: 'string', placeholder: 'N', description: 'calls per page (1-200, 50 by default)'},
        pages: {type: 'string', placeholder: 'N', description: 'follow the next pages, up to N pages (1-20)'},
        cursor: {type: 'string', placeholder: 'C', description: 'the next page (nextCursor of the previous answer)'},
        call: {type: 'string', placeholder: 'CALLID', description: 'every queue this phone call went through'},
        full: {type: 'boolean', description: "with the caller's number and name"},
      },
      args: [0, 0],
      async run(ctx) {
        const v = ctx.values;
        const limit = intOption('--limit', v.limit, 1, 200);
        const pages = intOption('--pages', v.pages, 1, 20) ?? 1;
        if (v.cursor !== undefined && (v.cursor.length > 2048 || !/^[A-Za-z0-9_=+/.:-]+$/.test(v.cursor)))
          throw new UsageError('not a cursor');
        const filter = reportFilter(v, ctx.now);
        const x = {};
        if (limit !== undefined) x.limit = limit;
        if (v.call !== undefined) x.callId = checkId('the call id', v.call);
        if (v.cursor) x.cursor = v.cursor;
        const wda = ctx.client(wdaClient);
        let items = [];
        let meta = {};
        let next = '';
        for (let i = 1; i <= pages; i += 1) {
          const r = await wda.post('/xcaracal/services/calls/query', {filter, ...x});
          items = items.concat(r.items ?? []);
          meta = {timeZone: r.timeZone ?? null, pbx: r.pbx ?? null};
          next = r.nextCursor ?? '';
          if (!next) break;
          x.cursor = next;
        }
        if (!v.full) items = items.map(dropCaller);
        return withWindow({...meta, count: items.length, items, ...(next ? {nextCursor: next} : {})}, filter);
      },
      text(r, ctx) {
        const lines = [`${heading(r)} · ${r.count} calls`];
        if (r.items.length) lines.push(...table(r.items.map((c) => callLine(c, ctx.values.full))));
        if (r.nextCursor) lines.push(`More: --cursor ${r.nextCursor}`);
        return lines;
      },
    },
    events: {
      summary: 'one call in one queue: its row and its events (INIT, RING, CANCEL, ANSWER, END) with the agents rung',
      usage: 'wx reports events <callId> <flowIndex> [--queue ID] [--full]',
      options: {
        queue: {type: 'string', placeholder: 'ID', description: 'the queue (when the call went through several)'},
        full: {type: 'boolean', description: "with the caller's number and name"},
      },
      args: [2, 2],
      async run(ctx) {
        const {callId, flow} = callFlow(ctx.positionals);
        const q = ctx.values.queue === undefined ? undefined : checkId('the queue id', ctx.values.queue);
        const r = await ctx
          .client(wdaClient)
          .get(apiPath`/xcaracal/services/calls/${callId}/flows/${String(flow)}/events` + query({serviceId: q}));
        return ctx.values.full ? r : {...r, call: dropCaller(r.call)};
      },
      text(r, ctx) {
        const lines = r.call ? table([callLine(r.call, ctx.values.full)]) : [];
        const rows = (r.events ?? []).map((e) => [
          localTime(e.time, {seconds: true}),
          e.action ?? '',
          e.reason ?? '',
          who(e.userName, e.userExtension),
          e.queuePosition === undefined ? '' : `place ${e.queuePosition}`,
        ]);
        return [...lines, ...(rows.length ? table(rows).map((l) => `  ${l}`) : ['  No events.'])];
      },
    },
  },
};

export const groups = {reports: group};
