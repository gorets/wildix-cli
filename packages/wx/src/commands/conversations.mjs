// wx conversations: the search over calls, conferences and chats with the AI summary of each (WDA Insights), the
// counts, the statistics of a dimension (the data of a chart) and the tags. By default only the conversations the
// logged-in user took part in; --everyone drops that (the service still decides what the login may see).
import {jwtClaims} from 'wldx-core/auth';
import {UsageError} from 'wldx-core/errors';
import {localTime, oneLine, table} from 'wldx-core/format';
import {query} from 'wldx-core/http';
import {secs} from '../history/text.mjs';
import {alt, checkIso, checkZone, intOption, isoSeconds, localZone, pick, unique, wdaClient} from '../history/wda.mjs';

export const WHEN = [
  'TODAY',
  'YESTERDAY',
  'THIS_WEEK',
  'PREVIOUS_WEEK',
  'THIS_MONTH',
  'PREVIOUS_MONTH',
  'THIS_QUARTER',
  'LAST_30_DAYS',
];
export const DIMENSIONS = [
  'direction',
  'entity',
  'channel',
  'recorded',
  'language',
  'country',
  'location',
  'pbx',
  'trunk',
  'queue',
  'service',
  'extension',
  'group',
  'department',
  'tag',
  'chatbot',
  'voicebot',
  'duration',
  'connectTime',
  'talkTime',
  'waitTime',
  'queueTime',
  'holdTime',
  'date',
  'dayOfWeek',
  'hourOfDay',
];
const ZONED = new Set(['date', 'dayOfWeek', 'hourOfDay']);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The options of the filter (find, count, aggregate).
const FILTER_OPTIONS = {
  entity: {
    type: 'string',
    multiple: true,
    choices: ['call', 'conference', 'chat'],
    description: 'only calls, conferences or chats',
  },
  email: {
    type: 'string',
    multiple: true,
    placeholder: 'E',
    description: 'a participant by e-mail (all named must have taken part)',
  },
  phone: {type: 'string', multiple: true, placeholder: 'P', description: 'a participant by phone number'},
  extension: {type: 'string', multiple: true, placeholder: 'X', description: 'a participant by extension'},
  everyone: {
    type: 'boolean',
    description: 'not only your own conversations: everything the login may see (only when asked)',
  },
  transcribed: {type: 'boolean', description: 'only conversations with a transcript'},
  recorded: {type: 'boolean', description: 'only recorded conversations'},
  direction: {type: 'string', choices: ['inbound', 'outbound', 'internal'], description: 'only this direction'},
  from: {type: 'string', placeholder: 'ISO', description: 'from this time (ISO)'},
  to: {type: 'string', placeholder: 'ISO', description: 'up to this time (ISO)'},
  tz: {
    type: 'string',
    placeholder: 'ZONE',
    description: 'the time zone of --from/--to/--when (and of the time dimensions of aggregate)',
  },
  when: {type: 'string', choices: WHEN, description: 'a ready period'},
  tag: {type: 'string', multiple: true, placeholder: 'T', description: 'only conversations with this tag'},
  language: {type: 'string', multiple: true, placeholder: 'L', description: 'only conversations in this language'},
};

// The ListConversations filter from the options. Without a participant and without --everyone: the user's own
// conversations (the e-mail of the login).
export function buildFilter(values, token) {
  const f = {};
  if (values.entity?.length) f.entity = Object.fromEntries(values.entity.map((e) => [e, true]));
  const parts = [
    ...(values.email ?? []).map((email) => ({email})),
    ...(values.phone ?? []).map((phone) => ({phone})),
    ...(values.extension ?? []).map((extension) => ({extension})),
  ];
  if (!parts.length && !values.everyone) {
    const me = String(jwtClaims(token).email ?? '').toLowerCase();
    if (!me) throw new Error('the token carries no e-mail');
    parts.push({email: me});
  }
  if (parts.length) f.participants = parts;
  if (values.transcribed) f.transcribed = true;
  if (values.recorded) f.recorded = true;
  if (values.direction) f.direction = {[values.direction]: true};
  const tz = checkZone(values.tz);
  if (values.when) f.date = {predefined: {type: values.when, ...(tz ? {timeZone: tz} : {})}};
  else if (values.from || values.to) {
    f.date = {
      absolute: {
        ...(values.from ? {from: checkIso('--from', values.from)} : {}),
        ...(values.to ? {to: checkIso('--to', values.to)} : {}),
        ...(tz ? {timeZone: tz} : {}),
      },
    };
  }
  if (values.tag?.length) f.tag = values.tag;
  if (values.language?.length) f.language = values.language;
  return f;
}

// One item of `find --brief`.
export function briefItem(it) {
  const [type, v = {}] = Object.entries(it.event ?? {})[0] ?? [null, {}];
  return {
    type,
    id: alt(v.id, v.chatId),
    flowIndex: v.flowIndex ?? null,
    start: isoSeconds(v.startTime),
    durationSec: Math.round((v.duration ?? 0) / 1000),
    title: v.subject ?? null,
    direction: v.direction ?? null,
    status: alt(v.status, v.callStatus),
    participants:
      type === 'conference'
        ? unique((v.participants ?? []).map((p) => alt(p.info?.name, p.info?.email)).filter((n) => n !== null))
        : null,
    summary: pick(it.summary, ['status', 'title', 'brief']),
  };
}

// The AggregationDefinition of one dimension.
export function aggregationOf(dim, tz) {
  if (dim.startsWith('projection:')) {
    const m = /^projection:([A-Za-z0-9_-]{1,100}):([A-Za-z0-9_-]{1,100})$/.exec(dim);
    if (!m) throw new UsageError(`a projection is projection:<id>:<field>: ${dim}`);
    return {projection: {id: m[1], fieldId: m[2]}};
  }
  if (!DIMENSIONS.includes(dim))
    throw new UsageError(`not a dimension: ${dim} (one of ${DIMENSIONS.join(', ')}, or projection:<id>:<field>)`);
  return {[dim]: ZONED.has(dim) ? {timeZone: tz} : {}};
}

const dimName = (agg) => {
  const k = Object.keys(agg ?? {})[0];
  return k === 'projection' ? `projection:${agg.projection.id}:${agg.projection.fieldId}` : k;
};

// One level of an aggregation: the buckets without their drill-down filters, weekdays named, hours and weekdays in
// order, the N biggest values kept (not of the time dimensions), the nested level named by its dimension.
export function level(r, top) {
  const d = dimName(r.aggregation);
  let buckets = [...(r.buckets ?? [])];
  if (d === 'hourOfDay' || d === 'dayOfWeek') buckets.sort((a, b) => Number(a.key) - Number(b.key));
  if (top !== undefined && !ZONED.has(d)) buckets = buckets.sort((a, b) => b.count - a.count).slice(0, top);
  return {
    by: d,
    buckets: buckets.map((b) => ({
      key: b.key ?? null,
      count: b.count ?? null,
      ...(d === 'dayOfWeek' ? {day: WEEKDAYS[Number(b.key)] ?? null} : {}),
      ...(b.interval ? {interval: b.interval} : {}),
      ...(b.aggregation ? {then: level(b.aggregation, top)} : {}),
    })),
  };
}

export function projectionsOf(r) {
  return {
    count: r.count ?? null,
    projections: (r.result ?? [])
      .filter((x) => x.aggregation?.projection && (x.buckets ?? []).length > 0)
      .map((x) => ({
        by: `projection:${x.aggregation.projection.id}:${x.aggregation.projection.fieldId}`,
        values: x.buckets.reduce((n, b) => n + (b.count ?? 0), 0),
        top: [...x.buckets]
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
          .map((b) => ({key: b.key ?? null, count: b.count ?? null})),
      })),
  };
}

const bucketLabel = (b) => (b.day ? `${b.day}` : b.key === null || b.key === '' ? '(none)' : String(b.key));

// The buckets of a level (and of the levels under it, indented) as rows of label and count.
function levelRows(l, indent = '') {
  return l.buckets.flatMap((b) => [
    [`${indent}${oneLine(bucketLabel(b), 60)}`, String(b.count)],
    ...(b.then ? levelRows(b.then, `${indent}  `) : []),
  ]);
}

const chain = (l) => (l.buckets.find((b) => b.then) ? [l.by, ...chain(l.buckets.find((b) => b.then).then)] : [l.by]);

function aggregateText(r, ctx) {
  const v = ctx.values;
  if (v.raw) return JSON.stringify(r, null, 2);
  const whose = v.everyone ? 'visible to the login' : 'your own';
  if (v.projections) {
    if (!r.projections.length) return `${r.count} conversations (${whose}); no AI fields with values.`;
    return [
      `${r.count} conversations (${whose}); AI fields with values:`,
      ...table(
        r.projections.map((p) => [
          p.by,
          String(p.values),
          p.top.map((t) => `${oneLine(t.key, 30)} ${t.count}`).join(', '),
        ]),
      ),
    ];
  }
  const head = `${r.count} conversations (${whose}), times in ${r.timeZone}`;
  if (r.results)
    return [
      head,
      ...r.results.flatMap((l) => [
        '',
        `by ${l.by}:`,
        ...(l.buckets.length ? table(levelRows(l, '  ')) : ['  (none)']),
      ]),
    ];
  return [
    head,
    '',
    `by ${chain(r).join(', then ')}:`,
    ...(r.buckets.length ? table(levelRows(r, '  ')) : ['  (none)']),
  ];
}

function findText(r, ctx) {
  const items = ctx.values.brief ? (r.items ?? []) : (r.items ?? []).map(briefItem);
  const lines = items.length
    ? table(
        items.map((i) => [
          localTime(i.start),
          i.type ?? '',
          secs(i.durationSec),
          [i.direction, i.status].filter(Boolean).join(' '),
          oneLine(alt(i.title, i.summary?.title, '') ?? '', 70),
          `${i.id ?? ''}${i.type === 'call' && i.flowIndex ? ` ${i.flowIndex}` : ''}`,
        ]),
      )
    : ['No conversations.'];
  const next = ctx.values.brief ? r.nextCursor : r.lastEvaluatedKey;
  if (next) lines.push(`More: --cursor ${typeof next === 'string' ? next : JSON.stringify(next)}`);
  return lines;
}

const group = {
  summary: 'search calls, meetings and chats with their AI summary; counts and statistics',
  auth: true,
  commands: {
    find: {
      summary: 'the search over conversations with the summary of each, 10 per page',
      usage:
        'wx conversations find [--entity call|conference|chat]... [--email E]... [--phone P]... [--extension X]... [--everyone] [--transcribed] [--recorded] [--direction inbound|outbound|internal] [--from ISO --to ISO [--tz ZONE]] [--when PERIOD] [--tag T]... [--language L]... [--cursor KEY] [--brief]',
      details:
        'Only the conversations you took part in, unless --everyone (only when asked: it may return the conversations of colleagues). The next page: --cursor with nextCursor (lastEvaluatedKey) of the answer.',
      options: {
        ...FILTER_OPTIONS,
        cursor: {type: 'string', placeholder: 'KEY', description: 'the next page (nextCursor of the previous answer)'},
        brief: {
          type: 'boolean',
          description:
            'one short object per conversation: type, id, start, duration, title, direction, status, participants, summary',
        },
      },
      args: [0, 0],
      async run(ctx) {
        const body = {filter: buildFilter(ctx.values, ctx.token)};
        if (ctx.values.cursor) body.exclusiveStartKey = ctx.values.cursor;
        const r = await ctx.client(wdaClient).post('/insights/conversations', body);
        return ctx.values.brief ? {items: (r.items ?? []).map(briefItem), nextCursor: r.lastEvaluatedKey ?? null} : r;
      },
      text: findText,
    },
    count: {
      summary: 'how many conversations match the filter',
      usage: 'wx conversations count [the filter of find, without --cursor and --brief]',
      options: FILTER_OPTIONS,
      args: [0, 0],
      run: (ctx) =>
        ctx.client(wdaClient).post('/insights/conversations/count', {filter: buildFilter(ctx.values, ctx.token)}),
      text: (r, ctx) =>
        `${r.count ?? JSON.stringify(r)} conversations (${ctx.values.everyone ? 'visible to the login' : 'your own'})`,
    },
    aggregate: {
      summary: 'how many conversations fall into each value of a dimension (the data of a chart)',
      usage:
        'wx conversations aggregate (--by DIM[,DIM...] | --by DIM --then DIM [--then DIM] | --projections) [the filter of find] [--tz ZONE] [--top N] [--raw]',
      details: [
        'Several dimensions side by side (--by a,b: at most 10), or one broken down by others (--by a --then b [--then c]).',
        `Dimensions: ${DIMENSIONS.join(' ')}, and projection:<id>:<field> (an AI insight field; --projections lists those with values).`,
        'date, dayOfWeek and hourOfDay are cut in --tz (the local zone by default). --top keeps the N biggest values of each level (the time dimensions stay whole).',
        'Counts only your own conversations unless --everyone.',
      ].join('\n'),
      options: {
        ...FILTER_OPTIONS,
        by: {type: 'string', placeholder: 'DIM[,DIM]', description: 'the dimensions (comma-separated)'},
        then: {
          type: 'string',
          multiple: true,
          placeholder: 'DIM',
          description: 'break each value of --by down by this dimension (at most two)',
        },
        top: {type: 'string', placeholder: 'N', description: 'keep the N biggest values of each level (1-1000)'},
        raw: {type: 'boolean', description: 'the answer of the service as it is'},
        projections: {
          type: 'boolean',
          description: 'the AI insight fields that have values in the filter, with their biggest values',
        },
      },
      args: [0, 0],
      async run(ctx) {
        const v = ctx.values;
        const top = intOption('--top', v.top, 1, 1000);
        const filter = buildFilter(v, ctx.token);
        const wda = ctx.client(wdaClient);
        if (v.projections) {
          const r = await wda.post('/insights/conversations/aggregations', {filter});
          return v.raw ? r : projectionsOf(r);
        }
        if (!v.by) throw new UsageError('aggregate needs --by (or --projections)', ctx.usage());
        const tz = checkZone(v.tz) ?? localZone(ctx.env);
        const bys = v.by.split(',');
        const thens = v.then ?? [];
        if (thens.length) {
          if (bys.length !== 1) throw new UsageError('with --then, --by names one dimension');
          if (thens.length > 2) throw new UsageError('at most two --then');
          const aggregations = [bys[0], ...thens].map((d) => aggregationOf(d, tz));
          const r = await wda.post('/insights/conversations/aggregations/nested', {filter, aggregations});
          return v.raw ? r : {count: r.count ?? null, timeZone: tz, ...level(r.result ?? {}, top)};
        }
        if (bys.length > 10) throw new UsageError('at most 10 dimensions side by side');
        const insights = bys.map((d) => aggregationOf(d, tz));
        const r = await wda.post('/insights/conversations/aggregations', {filter, insights});
        return v.raw ? r : {count: r.count ?? null, timeZone: tz, results: (r.result ?? []).map((x) => level(x, top))};
      },
      text: aggregateText,
    },
    tags: {
      summary: 'the tags that start with a prefix',
      usage: 'wx conversations tags <prefix> [--limit 1-20]',
      options: {limit: {type: 'string', placeholder: '1-20', description: 'how many tags'}},
      args: [1, 1],
      run: (ctx) =>
        ctx
          .client(wdaClient)
          .get(
            `/insights/conversations/tags${query({tagPrefix: ctx.positionals[0], limit: intOption('--limit', ctx.values.limit, 1, 20)})}`,
          ),
      text: (r) => ((r.tags ?? []).length ? r.tags.map(String) : 'No tags.'),
    },
  },
};

export const groups = {conversations: group};
