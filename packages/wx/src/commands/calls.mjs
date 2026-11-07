// wx calls: the user's own call history (as the PBX recorded it) and one call after the fact: its record, the
// transcript, the AI summary and insights, the characteristics, the recordings. Read only, except
// schedule-summary (asks the service to generate the summary again). Data of WDA History and WDA Insights.
import {UsageError} from 'wldx-core/errors';
import {localTime, oneLine, table} from 'wldx-core/format';
import {apiPath} from 'wldx-core/http';
import {insightLines, millis, party, secs, summaryLines} from '../history/text.mjs';
import {
  NoDataError,
  alt,
  callFlow,
  checkIso,
  compactInsights,
  intOption,
  isoSeconds,
  optional,
  wdaClient,
  writePrivate,
} from '../history/wda.mjs';

const CALL_ARGS = '<callId> [flow]';

const callPath = ({callId, flow}) => apiPath`/${callId}/flows/${String(flow)}`;

// The user call history gives durations in seconds; the record of one call in milliseconds. The start and the end
// are milliseconds in both, so the length of a call comes from them when they are there.
const lengthSec = (c) =>
  Number.isFinite(c.startTime) && Number.isFinite(c.endTime)
    ? Math.round((c.endTime - c.startTime) / 1000)
    : Math.round(c.duration ?? 0);

const hasRecording = (c) => (c.recordingsData ?? []).length > 0 || (c.attachments ?? []).some((a) => a?.recording);

// One row of `calls list --brief`.
export function briefHistoryCall(c) {
  return {
    id: c.id ?? null,
    flowIndex: c.flowIndex ?? null,
    start: isoSeconds(c.startTime),
    durationSec: lengthSec(c),
    direction: c.direction ?? null,
    status: c.callStatus ?? null,
    from: alt(c.caller?.name, c.caller?.phone, c.caller?.userExtension),
    to: alt(c.callee?.name, c.callee?.phone, c.callee?.userExtension),
    transcriptionStatus: c.transcriptionStatus ?? null,
    hasRecording: hasRecording(c),
  };
}

const person = (p) =>
  p
    ? {name: p.name ?? null, phone: p.phone ?? null, extension: p.userExtension ?? null, email: p.email ?? null}
    : {name: null, phone: null, extension: null, email: null};

// `calls brief`: the record, the summary and the insights as one readable object.
export function briefCall(id, rec, sum, ins) {
  const c = rec?.call ?? {};
  return {
    id,
    flowIndex: c.flowIndex ?? null,
    start: isoSeconds(c.startTime),
    durationSec: Math.round((c.duration ?? 0) / 1000),
    talkSec: Math.round((c.talkTime ?? 0) / 1000),
    direction: c.direction ?? null,
    status: c.callStatus ?? null,
    caller: person(c.caller),
    callee: person(c.callee),
    queue: c.queueName ?? null,
    service: c.service ?? null,
    tags: c.tags ?? [],
    transcriptionStatus: c.transcriptionStatus ?? null,
    hasRecording: hasRecording(c),
    summary:
      sum?.status === 'SUCCEEDED'
        ? {title: sum.summary?.title ?? null, brief: sum.summary?.brief ?? null}
        : {status: sum?.status ?? 'UNKNOWN'},
    insights: compactInsights(ins),
  };
}

// The recordings of a record: the files on the PBX (attachments, else the older recordingsData), each once.
export function recordingsOf(c) {
  const out = [];
  const seen = new Set();
  for (const r of [...(c.attachments ?? []).map((a) => a?.recording).filter(Boolean), ...(c.recordingsData ?? [])]) {
    const key = r.fileName ?? r.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({fileName: r.fileName ?? null, url: r.url ?? null, start: r.start ?? null, end: r.end ?? null});
  }
  return out;
}

// The history filter of `list` and `missed`.
const LIST_OPTIONS = {
  direction: {
    type: 'string',
    choices: ['INTERNAL', 'INBOUND', 'OUTBOUND'],
    description: 'only calls of this direction',
  },
  status: {type: 'string', choices: ['COMPLETED', 'MISSED'], description: 'only answered (COMPLETED) or missed calls'},
  flag: {
    type: 'string',
    multiple: true,
    choices: ['FAX', 'VOICEMAIL'],
    description: 'only calls with a fax or a voicemail',
  },
  from: {type: 'string', placeholder: 'ISO', description: 'calls from this time (ISO, e.g. 2026-11-01T00:00:00Z)'},
  to: {type: 'string', placeholder: 'ISO', description: 'calls up to this time (ISO)'},
  search: {type: 'string', placeholder: 'TEXT', description: 'a name or a number to search for'},
  tag: {type: 'string', multiple: true, placeholder: 'TAG', description: 'only calls with this tag'},
  'has-attachment': {type: 'boolean', description: 'only calls with an attachment (a recording, a fax, a voicemail)'},
  'user-direction': {
    type: 'string',
    choices: ['INCOMING', 'OUTGOING'],
    description: 'only calls you received or placed',
  },
  limit: {type: 'string', placeholder: '1-100', description: 'calls per page (50 by default, at most 100)'},
  offset: {type: 'string', placeholder: 'N', description: 'skip this many calls (the next page)'},
  brief: {type: 'boolean', description: 'one short object per call: id, start, duration, direction, status, from, to'},
};

async function listCalls(ctx, status) {
  const v = ctx.values;
  const limit = intOption('--limit', v.limit, 1, 100);
  const offset = intOption('--offset', v.offset, 0, 1_000_000);
  const filter = {};
  if (v.direction) filter.direction = v.direction;
  if (status) filter.status = status;
  if (v.flag?.length) filter.flags = v.flag;
  if (v.from) filter.from = checkIso('--from', v.from);
  if (v.to) filter.to = checkIso('--to', v.to);
  if (v.search) filter.search = v.search;
  if (v.tag?.length) filter.tags = v.tag;
  if (v['has-attachment']) filter.hasAttachment = true;
  if (v['user-direction']) filter.userDirection = v['user-direction'];
  const body = {filter};
  if (limit !== undefined) body.limit = limit;
  if (offset !== undefined) body.offset = offset;
  const r = await ctx.client(wdaClient).post('/history/user/calls', body);
  return v.brief ? {calls: (r.calls ?? []).map(briefHistoryCall)} : r;
}

function listText(data, ctx) {
  const rows = (data.calls ?? []).map((c) => (ctx.values.brief ? c : briefHistoryCall(c)));
  if (!rows.length) return 'No calls.';
  return table(
    rows.map((c) => [
      localTime(c.start),
      c.direction ?? '',
      c.status ?? '',
      `${oneLine(c.from ?? '?', 40)} → ${oneLine(c.to ?? '?', 40)}`,
      secs(c.durationSec),
      [c.transcriptionStatus === 'AVAILABLE' && 'transcript', c.hasRecording && 'recording'].filter(Boolean).join(' '),
      `${c.id}${c.flowIndex ? ` ${c.flowIndex}` : ''}`,
    ]),
  );
}

function recordText(r) {
  const c = r.call ?? {};
  const rows = [
    ['Call', `${c.id ?? ''} flow ${c.flowIndex ?? 0}`],
    ['Start', localTime(c.startTime, {seconds: true})],
    [
      'Duration',
      [
        millis(c.duration),
        Number.isFinite(c.talkTime) && `talk ${millis(c.talkTime)}`,
        c.waitTime && `wait ${millis(c.waitTime)}`,
        c.holdTime && `hold ${millis(c.holdTime)}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    ['Direction', [c.direction, c.callStatus].filter(Boolean).join(' · ')],
    ['From', party(c.caller)],
    ['To', party(c.callee)],
  ];
  if (c.queueName) rows.push(['Queue', c.queueName]);
  if (c.service) rows.push(['Service', c.service]);
  if (c.trunkName) rows.push(['Trunk', [c.trunkName, c.trunkDirection].filter(Boolean).join(' · ')]);
  if (c.tags?.length) rows.push(['Tags', c.tags.join(', ')]);
  if (c.transcriptionStatus)
    rows.push(['Transcript', [c.transcriptionStatus, c.transcriptionLanguage].filter(Boolean).join(' · ')]);
  const recs = recordingsOf(c);
  if (recs.length) rows.push(['Recordings', String(recs.length)]);
  return table(rows);
}

function briefText(b) {
  const who = (p) =>
    [p.name, p.extension && `(${p.extension})`, p.phone && p.phone !== p.extension ? p.phone : undefined]
      .filter(Boolean)
      .join(' ');
  const rows = [
    ['Call', `${b.id} flow ${b.flowIndex ?? 0}`],
    ['Start', localTime(b.start)],
    ['Duration', `${secs(b.durationSec)} · talk ${secs(b.talkSec)}`],
    ['Direction', [b.direction, b.status].filter(Boolean).join(' · ')],
    ['From', who(b.caller)],
    ['To', who(b.callee)],
  ];
  if (b.queue) rows.push(['Queue', b.queue]);
  if (b.tags.length) rows.push(['Tags', b.tags.join(', ')]);
  rows.push(['Transcript', b.transcriptionStatus ?? 'none'], ['Recording', b.hasRecording ? 'yes' : 'no']);
  if (b.summary.title || b.summary.brief) rows.push(['Summary', oneLine(b.summary.title ?? '', 200)]);
  else rows.push(['Summary', b.summary.status]);
  const lines = table(rows);
  if (b.summary.brief) lines.push('', oneLine(b.summary.brief, 2000));
  const ins = insightLines(b.insights);
  if (ins.length) lines.push('', 'Insights:', ...insightLines(b.insights, '  '));
  return lines;
}

const NO_TRANSCRIPT = 'This call has no transcription, or there is no such call.';

const group = {
  summary: 'your call history and calls after the fact: record, transcript, summary, insights',
  auth: true,
  commands: {
    list: {
      summary: 'your own call history, newest first, 50 per page',
      usage:
        'wx calls list [--direction INTERNAL|INBOUND|OUTBOUND] [--status COMPLETED|MISSED] [--flag FAX|VOICEMAIL]... [--from ISO] [--to ISO] [--search TEXT] [--tag TAG]... [--has-attachment] [--user-direction INCOMING|OUTGOING] [--limit 1-100] [--offset N] [--brief]',
      details: 'Calls only (not meetings), as the PBX recorded them. The next page: --offset.',
      options: LIST_OPTIONS,
      args: [0, 0],
      run: (ctx) => listCalls(ctx, ctx.values.status),
      text: listText,
    },
    missed: {
      summary: 'your missed calls, newest first (list --status MISSED)',
      usage: 'wx calls missed [the options of list, without --status]',
      options: Object.fromEntries(Object.entries(LIST_OPTIONS).filter(([k]) => k !== 'status')),
      args: [0, 0],
      run: (ctx) => listCalls(ctx, 'MISSED'),
      text: listText,
    },
    get: {
      summary: 'the record of a call: who called whom, times, queue, trunk, recordings',
      usage: `wx calls get ${CALL_ARGS}`,
      details: 'The flow index is 0 for the first part of the call; a transferred call has more flows.',
      options: {},
      args: [1, 2],
      run: (ctx) => ctx.client(wdaClient).get(`/history/calls${callPath(callFlow(ctx.positionals))}`),
      text: recordText,
    },
    brief: {
      summary: 'a call as one readable object: record, summary, insights',
      usage: `wx calls brief ${CALL_ARGS}`,
      options: {},
      args: [1, 2],
      async run(ctx) {
        const call = callFlow(ctx.positionals);
        const p = callPath(call);
        const wda = ctx.client(wdaClient);
        const [rec, sum, ins] = await Promise.all([
          wda.get(`/history/calls${p}`),
          optional(wda.get(`/insights/calls${p}/summary`), ctx.info),
          optional(wda.get(`/insights/calls${p}/insights`), ctx.info),
        ]);
        return briefCall(call.callId, rec, sum, ins);
      },
      text: briefText,
    },
    transcript: {
      summary: 'the dialogue of a call (exit 3 when there is none)',
      usage: `wx calls transcript ${CALL_ARGS} [--to FILE] [--structured]`,
      details:
        'Text: the dialogue, "[MM:SS] Name: text". --output json: the text and its chunks as the service gives them. --structured: the transcription record with the interaction data. --to writes the dialogue to a new private file and prints its path.',
      options: {
        to: {
          type: 'string',
          placeholder: 'FILE',
          description: 'write the dialogue to this new file (private) and print its path',
        },
        structured: {
          type: 'boolean',
          description: 'the transcription record: chunks with timing, sentiment, the interaction',
        },
      },
      args: [1, 2],
      async run(ctx) {
        const p = callPath(callFlow(ctx.positionals));
        const wda = ctx.client(wdaClient);
        if (ctx.values.structured) {
          if (ctx.values.to) throw new UsageError('--to writes the dialogue: leave out --structured');
          const r = await wda.soft(`/history/calls${p}/transcription`);
          if (!r) throw new NoDataError(NO_TRANSCRIPT);
          return r;
        }
        const r = await wda.soft(`/history/calls${p}/transcription/text`);
        if (!r) throw new NoDataError(NO_TRANSCRIPT);
        if (ctx.output === 'json' && !ctx.values.to) return r;
        const text = r.text ?? '';
        if (!text.trim()) throw new NoDataError('The transcription is empty.');
        if (ctx.values.to) return {file: writePrivate(ctx.values.to, `${text}\n`, {cwd: ctx.cwd, env: ctx.env})};
        return r;
      },
      text(r, ctx) {
        if (r.file) return r.file;
        if (ctx.values.structured)
          return structuredLines(
            r.transcription?.chunks ?? [],
            r.transcription?.callStartTime ?? r.transcription?.flowStartTime,
          );
        return (r.text ?? '').replace(/\n+$/, '');
      },
    },
    annotations: {
      summary: 'the annotations of a call (404 when there are none)',
      usage: `wx calls annotations ${CALL_ARGS}`,
      options: {},
      args: [1, 2],
      run: (ctx) => ctx.client(wdaClient).get(`/history/calls${callPath(callFlow(ctx.positionals))}/annotations`),
      text: (r) => annotationLines(r.annotations?.annotations ?? []),
    },
    insights: {
      summary: 'the AI insights that were generated: {projection: {field: value}}',
      usage: `wx calls insights ${CALL_ARGS} [--raw]`,
      options: {raw: {type: 'boolean', description: 'every projection as the service gives it, with its status'}},
      args: [1, 2],
      async run(ctx) {
        const r = await ctx.client(wdaClient).get(`/insights/calls${callPath(callFlow(ctx.positionals))}/insights`);
        return ctx.values.raw ? r : {status: r.status ?? null, insights: compactInsights(r)};
      },
      text: (r) => insightsText(r),
    },
    summary: {
      summary: 'the AI title, brief and the structured summary of a call',
      usage: `wx calls summary ${CALL_ARGS}`,
      options: {},
      args: [1, 2],
      run: (ctx) => ctx.client(wdaClient).get(`/insights/calls${callPath(callFlow(ctx.positionals))}/summary`),
      text: summaryLines,
    },
    characteristics: {
      summary: 'talk time, interruptions, sentiment and talk speed of a call',
      usage: `wx calls characteristics ${CALL_ARGS}`,
      options: {},
      args: [1, 2],
      run: (ctx) => ctx.client(wdaClient).get(`/insights/calls${callPath(callFlow(ctx.positionals))}/characteristics`),
      text: characteristicsText,
    },
    state: {
      summary: 'your own state of a call: playlists, playback position',
      usage: `wx calls state ${CALL_ARGS}`,
      options: {},
      args: [1, 2],
      run: (ctx) => ctx.client(wdaClient).get(`/insights/calls${callPath(callFlow(ctx.positionals))}/state`),
      text: stateText,
    },
    recordings: {
      summary: 'the recordings of a call: file names and their links on the PBX',
      usage: `wx calls recordings ${CALL_ARGS}`,
      options: {},
      args: [1, 2],
      async run(ctx) {
        const r = await ctx.client(wdaClient).get(`/history/calls${callPath(callFlow(ctx.positionals))}`);
        return {recordings: recordingsOf(r.call ?? {})};
      },
      text: (r) =>
        r.recordings.length
          ? table(
              r.recordings.map((x) => [
                localTime(x.start, {seconds: true}),
                Number.isFinite(x.start) && Number.isFinite(x.end) ? millis(x.end - x.start) : '',
                x.url ?? x.fileName ?? '',
              ]),
            )
          : 'No recordings.',
    },
    'schedule-summary': {
      summary: 'ask the service to generate the summary of a call again (only when asked: it does work)',
      usage: `wx calls schedule-summary ${CALL_ARGS}`,
      options: {},
      args: [1, 2],
      run: (ctx) =>
        ctx.client(wdaClient).post(`/insights/calls${callPath(callFlow(ctx.positionals))}/schedule_summary_generation`),
      text: () => 'The summary was scheduled: read it later with wx calls summary.',
    },
  },
};

export const groups = {calls: group};

// Shared with wx meetings.

// Chunks of a structured transcription (the service does not keep them in order) as "[MM:SS] speaker: text", in
// order of their start, the time from the start of the transcription.
export function structuredLines(chunks, start, names = {}) {
  const t0 = Number.isFinite(start) ? start : chunks.find((c) => Number.isFinite(c.start))?.start;
  const ordered = [...chunks].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return ordered.map((c) => {
    const at =
      Number.isFinite(c.start) && Number.isFinite(t0) ? Math.max(0, Math.floor((c.start - t0) / 1000)) : undefined;
    const mmss =
      at === undefined
        ? '--:--'
        : `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    const who = c.jid
      ? (names[c.jid] ?? c.jid)
      : typeof c.speaker === 'object'
        ? (c.speaker?.name ?? c.speaker?.type ?? '?')
        : (c.speaker ?? '?');
    return `[${mmss}] ${who}: ${String(c.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()}`;
  });
}

export function annotationLines(list) {
  if (!list.length) return 'No annotations.';
  return table(
    list.map((a) => [
      localTime(a.time, {seconds: true}),
      a.key ?? '',
      a.source?.name ?? a.source?.type ?? '',
      oneLine(JSON.stringify(a.payload ?? {}), 160),
    ]),
  );
}

export function insightsText(r) {
  if (r.insights && !Array.isArray(r.insights)) {
    const lines = insightLines(r.insights);
    return lines.length ? lines : `No insights${r.status ? ` (${r.status})` : ''}.`;
  }
  const list = r.insights ?? [];
  if (!list.length) return `No insights${r.status ? ` (${r.status})` : ''}.`;
  return list.flatMap((p) => [
    `${p.id}: ${p.status ?? ''}${p.reason ? ` (${p.reason})` : ''}`,
    ...(p.fields ?? []).map(
      (f) => `  ${f.id}: ${oneLine(typeof f.value === 'object' ? JSON.stringify(f.value) : (f.value ?? ''), 300)}`,
    ),
  ]);
}

export function stateText(r) {
  const s = r.state ?? {};
  const rows = [];
  if (s.firstWatchedAt) rows.push(['First watched', localTime(s.firstWatchedAt)]);
  if (s.lastWatchedAt) rows.push(['Last watched', localTime(s.lastWatchedAt)]);
  if (s.playback) rows.push(['Playback', `${millis(s.playback.position)} of ${millis(s.playback.duration)}`]);
  rows.push([
    'Playlists',
    (s.playlists ?? []).length
      ? s.playlists.map((p) => (typeof p === 'object' ? (p.name ?? p.id) : p)).join(', ')
      : 'none',
  ]);
  return table(rows);
}

function characteristicsText(r) {
  const c = r.characteristics;
  if (!c) return `No characteristics${r.status ? ` (${r.status})` : ''}.`;
  const rows = [];
  if (Number.isFinite(c.duration)) rows.push(['Duration', millis(c.duration)]);
  for (const t of c.talkTime?.detailsByParticipant ?? [])
    rows.push([`Talk ${t.interrupter ?? '?'}`, millis(t.totalTime)]);
  for (const t of c.talkSpeed?.detailsByParticipant ?? [])
    rows.push([`Speed ${t.interrupter ?? '?'}`, `${Math.round(t.averageWordsPerMinute ?? 0)} words/min`]);
  if (c.interruptions) rows.push(['Interruptions', String((c.interruptions.chunks ?? []).length)]);
  if (c.nonTalkTime) rows.push(['Silences', String((c.nonTalkTime.chunks ?? []).length)]);
  if (c.sentiment && Number.isFinite(c.sentiment.score)) rows.push(['Sentiment', String(c.sentiment.score)]);
  for (const s of c.sentiment?.scoreByParticipant ?? [])
    rows.push([`Sentiment ${s.interrupter ?? '?'}`, String(s.score)]);
  return [`Status: ${r.status ?? ''}`, ...table(rows)];
}
