// wx meetings: conferences (x-bees meetings) after the fact: the record, a readable card, the transcript, the AI
// summary and insights, who spoke when, the recording link. Read only, except schedule-summary (asks the service
// to generate the summary again). Data of WDA History and WDA Insights.
import {UsageError} from 'wldx-core/errors';
import {localTime, oneLine, table} from 'wldx-core/format';
import {apiPath, query} from 'wldx-core/http';
import {insightLines, millis, sectionLines, summaryLines} from '../history/text.mjs';
import {
  NoDataError,
  alt,
  compactInsights,
  conferenceId,
  isoSeconds,
  optional,
  participantNames,
  plural,
  wdaClient,
  writePrivate,
} from '../history/wda.mjs';
import {annotationLines, insightsText, stateText, structuredLines} from './calls.mjs';

const CONF = '<conference>';
const CONF_HINT = 'A conference is an id or a link https://app.x-bees.com/insights/conferences/<id>.';
export const conferenceLink = (id) => `https://app.x-bees.com/insights/conferences/${id}`;

const SUMMARY_KEYS = ['topics', 'review', 'decisions', 'progress', 'issues', 'actionItems', 'nextSteps'];

// `meetings brief`: the record, the participants (each once), the summary and the insights as one object.
export function briefConference(id, rec, sum, ins) {
  const c = rec?.conference ?? {};
  const groups = new Map();
  for (const p of c.participants ?? []) {
    const i = p.info ?? {};
    const name = alt(i.name, i.email);
    if (name === null) continue;
    const key = String(alt(i.email, name));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({name, email: i.email ?? null, xbsId: i.xbsId ?? null, speak: p.totalSpeakDuration ?? 0});
  }
  const participants = [...groups.keys()].sort().map((k) => {
    const list = groups.get(k);
    const {speak, ...first} = list[0];
    return {...first, speakMin: Math.round(list.reduce((n, x) => n + x.speak, 0) / 60000)};
  });
  const s = sum?.summary ?? {};
  return {
    id,
    subject: c.subject ?? null,
    start: isoSeconds(c.startTime),
    durationMin: Math.round((c.duration ?? 0) / 60000),
    status: c.status ?? null,
    direction: c.direction ?? null,
    participants,
    transcriptionStatus: c.transcriptionStatus ?? null,
    transcriptionLanguage: c.transcriptionLanguage ?? null,
    hasRecording: (c.recordings ?? []).length > 0,
    summary:
      sum?.status === 'SUCCEEDED'
        ? {
            title: s.title ?? null,
            brief: s.brief ?? null,
            ...Object.fromEntries(SUMMARY_KEYS.map((k) => [k, s.json?.[k] ?? []])),
          }
        : {status: sum?.status ?? 'UNKNOWN'},
    insights: compactInsights(ins),
  };
}

async function briefOne(wda, id, info) {
  const base = apiPath`/${id}`;
  const [rec, ins, sum] = await Promise.all([
    wda.get(`/history/conferences${base}`),
    optional(wda.get(`/insights/conferences${base}/insights`), info),
    optional(wda.get(`/insights/conferences${base}/summary`), info),
  ]);
  return briefConference(id, rec, sum, ins);
}

// The header of a transcript: what the ADR skill and people read before the dialogue. Times in UTC.
export function transcriptHeader(id, c, lines) {
  const one = (s) => String(s).replace(/[\r\n]+/g, ' ');
  return [
    `# ${one(c.subject || 'Conference')}`,
    `# conferenceId: ${id}`,
    `# url: ${conferenceLink(id)}`,
    `# start: ${isoSeconds(c.startTime)}`,
    `# duration: ${Math.round((c.duration ?? 0) / 60000)} min`,
    `# language: ${c.transcriptionLanguage || 'unknown'}`,
    `# participants: ${participantNames(c).join(', ') || 'unknown'}`,
    `# lines: ${lines}`,
    '',
  ].join('\n');
}

const NO_TRANSCRIPT = 'This conference has no transcription, or there is no such conference.';

function briefLines(b) {
  const head = [
    localTime(b.start),
    `${b.durationMin} min`,
    b.status,
    b.direction,
    b.transcriptionStatus &&
      `transcript ${b.transcriptionStatus}${b.transcriptionLanguage ? ` (${b.transcriptionLanguage})` : ''}`,
    b.hasRecording && 'recording',
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [oneLine(b.subject || 'Conference', 200), `  ${head}`, `  ${b.id}`];
  if (b.participants.length)
    lines.push(
      `  Participants: ${b.participants.map((p) => `${p.name}${p.speakMin ? ` (${p.speakMin} min)` : ''}`).join(', ')}`,
    );
  if (b.summary.status) lines.push(`  Summary: ${b.summary.status}`);
  else {
    if (b.summary.title) lines.push(`  Summary: ${oneLine(b.summary.title, 200)}`);
    if (b.summary.brief) lines.push(`  ${oneLine(b.summary.brief, 2000)}`);
    lines.push(...sectionLines(b.summary, '  '));
  }
  const ins = insightLines(b.insights, '    ');
  if (ins.length) lines.push('  Insights:', ...ins);
  return lines;
}

const conf = (ctx) => conferenceId(ctx.positionals[0]);
const get = (ctx, suffix) =>
  ctx.client(wdaClient).get(`/${suffix[0]}/conferences${apiPath`/${conf(ctx)}`}${suffix[1] ?? ''}`);

const group = {
  summary: 'meetings (conferences) after the fact: record, transcript, summary, insights, recording',
  auth: true,
  commands: {
    get: {
      summary: 'the record of a meeting: subject, times, participants, recordings, transcription status',
      usage: `wx meetings get ${CONF}`,
      details: CONF_HINT,
      options: {},
      args: [1, 1],
      run: (ctx) => get(ctx, ['history']),
      text(r) {
        const c = r.conference ?? {};
        const names = participantNames(c);
        return table([
          ['Meeting', oneLine(c.subject || 'Conference', 200)],
          ['Id', c.id ?? ''],
          ['Start', `${localTime(c.startTime)} · ${millis(c.duration)}`],
          ['Status', [c.status, c.direction].filter(Boolean).join(' · ')],
          ['Participants', `${names.length}${names.length ? `: ${names.join(', ')}` : ''}`],
          ['Transcript', [c.transcriptionStatus, c.transcriptionLanguage].filter(Boolean).join(' · ') || 'none'],
          ['Recordings', String((c.recordings ?? []).length)],
        ]);
      },
    },
    brief: {
      summary: 'a meeting as one readable card: record, participants, summary, insights (several: oldest first)',
      usage: `wx meetings brief ${CONF}...`,
      details: `${CONF_HINT} With several meetings the answer is an array, oldest first; one that fails is skipped with a warning.`,
      options: {},
      args: [1, 50],
      async run(ctx) {
        const wda = ctx.client(wdaClient);
        const ids = ctx.positionals.map(conferenceId);
        if (ids.length === 1) return briefOne(wda, ids[0], ctx.info);
        const cards = [];
        for (let i = 0; i < ids.length; i += 4) {
          const batch = await Promise.allSettled(ids.slice(i, i + 4).map((id) => briefOne(wda, id, ctx.info)));
          batch.forEach((r, j) => {
            if (r.status === 'fulfilled') cards.push(r.value);
            else ctx.info(`Warning: skipped ${ids[i + j]}: ${r.reason?.message?.split('\n')[0]}`);
          });
        }
        if (!cards.length) throw new Error('None of the meetings could be read (see the warnings above)');
        return cards.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      },
      text: (r) => (Array.isArray(r) ? r.flatMap((b, i) => [...(i ? [''] : []), ...briefLines(b)]) : briefLines(r)),
    },
    transcript: {
      summary: 'the dialogue of a meeting with a header (exit 3 when there is none)',
      usage: `wx meetings transcript ${CONF} [--to FILE] [--structured]`,
      details: `${CONF_HINT} Text: a header (subject, id, link, start in UTC, duration, language, participants, lines) and the dialogue "[MM:SS] Name: text". --output json: the header fields under "conference", and the text and its chunks as the service gives them. --structured: the transcription record with the interaction data. --to writes the header and the dialogue to a new private file (an existing file only when it is the transcript of the same meeting) and prints its path.`,
      options: {
        to: {
          type: 'string',
          placeholder: 'FILE',
          description: 'write the transcript to this file (private) and print its path',
        },
        structured: {
          type: 'boolean',
          description: 'the transcription record: chunks with timing, sentiment, the interaction',
        },
      },
      args: [1, 1],
      async run(ctx) {
        const id = conf(ctx);
        const wda = ctx.client(wdaClient);
        const base = apiPath`/${id}`;
        if (ctx.values.structured) {
          if (ctx.values.to) throw new UsageError('--to writes the dialogue: leave out --structured');
          const [r, rec] = await Promise.all([
            wda.soft(`/history/conferences${base}/transcription`),
            ctx.output === 'text' ? optional(wda.get(`/history/conferences${base}`), ctx.info) : null,
          ]);
          if (!r) throw new NoDataError(NO_TRANSCRIPT);
          if (rec)
            Object.defineProperty(r, 'names', {
              value: Object.fromEntries(
                (rec.conference?.participants ?? []).map((p) => [p.jid, alt(p.info?.name, p.info?.email, p.jid)]),
              ),
              enumerable: false,
            });
          return r;
        }
        const [text, rec] = await Promise.allSettled([
          wda.soft(`/history/conferences${base}/transcription/text`),
          wda.get(`/history/conferences${base}`),
        ]);
        if (text.status === 'rejected') throw text.reason;
        if (!text.value) throw new NoDataError(NO_TRANSCRIPT);
        if (rec.status === 'rejected') throw rec.reason;
        const c = rec.value.conference ?? {};
        const body = text.value;
        const dialogue = (body.text ?? '').trim();
        if (c.transcriptionStatus === 'UNAVAILABLE')
          throw new NoDataError(
            "Transcription is not available for this conference (transcriptionStatus 'UNAVAILABLE'): it was most likely never enabled on the call.",
          );
        if (!dialogue) {
          if (c.transcriptionStatus === 'POST_TRANSCRIPTION')
            throw new NoDataError(
              "The transcription is still being processed (transcriptionStatus 'POST_TRANSCRIPTION'): try again later.",
            );
          throw new NoDataError('The transcription is empty: nothing was transcribed on this call.');
        }
        const lines = (body.chunks ?? []).length;
        const header = transcriptHeader(id, c, lines);
        if (ctx.values.to)
          return {
            file: writePrivate(ctx.values.to, `${header}${dialogue}\n`, {cwd: ctx.cwd, conferenceId: id, env: ctx.env}),
          };
        const out = {
          conference: {
            id,
            subject: c.subject ?? null,
            url: conferenceLink(id),
            start: isoSeconds(c.startTime),
            durationMin: Math.round((c.duration ?? 0) / 60000),
            language: c.transcriptionLanguage ?? null,
            participants: participantNames(c),
            transcriptionStatus: c.transcriptionStatus ?? null,
          },
          ...body,
        };
        Object.defineProperty(out, 'header', {value: header, enumerable: false});
        return out;
      },
      text(r, ctx) {
        if (r.file) return r.file;
        if (ctx.values.structured) {
          return (r.transcription?.transcriptions ?? []).flatMap((t) =>
            structuredLines(t.chunks ?? [], t.start, r.names ?? {}),
          );
        }
        return `${r.header}${(r.text ?? '').trim()}`;
      },
    },
    annotations: {
      summary: 'the annotations of a meeting (404 when there are none)',
      usage: `wx meetings annotations ${CONF}`,
      options: {},
      args: [1, 1],
      run: (ctx) => get(ctx, ['history', '/annotations']),
      text: (r) => annotationLines(r.annotations?.annotations ?? []),
    },
    insights: {
      summary: 'the AI insights that were generated: {projection: {field: value}}',
      usage: `wx meetings insights ${CONF} [--raw]`,
      options: {raw: {type: 'boolean', description: 'every projection as the service gives it, with its status'}},
      args: [1, 1],
      async run(ctx) {
        const r = await get(ctx, ['insights', '/insights']);
        return ctx.values.raw ? r : {status: r.status ?? null, insights: compactInsights(r)};
      },
      text: insightsText,
    },
    summary: {
      summary: 'the AI title, brief and the structured summary of a meeting',
      usage: `wx meetings summary ${CONF}`,
      options: {},
      args: [1, 1],
      run: (ctx) => get(ctx, ['insights', '/summary']),
      text: summaryLines,
    },
    state: {
      summary: 'your own state of a meeting: playlists, playback position',
      usage: `wx meetings state ${CONF}`,
      options: {},
      args: [1, 1],
      run: (ctx) => get(ctx, ['insights', '/state']),
      text: stateText,
    },
    timeframes: {
      summary: 'who spoke when in a meeting',
      usage: `wx meetings timeframes ${CONF}`,
      options: {},
      args: [1, 1],
      async run(ctx) {
        const wda = ctx.client(wdaClient);
        const base = apiPath`/${conf(ctx)}`;
        const [r, rec] = await Promise.all([
          wda.get(`/insights/conferences${base}/timeframes`),
          ctx.output === 'text' ? optional(wda.get(`/history/conferences${base}`), ctx.info) : null,
        ]);
        if (rec) {
          const c = rec.conference ?? {};
          const names = Object.fromEntries(
            (c.participants ?? []).map((p) => [p.jid, alt(p.info?.name, p.info?.email, p.jid)]),
          );
          Object.defineProperty(r, 'names', {value: names, enumerable: false});
          Object.defineProperty(r, 'startTime', {value: c.startTime, enumerable: false});
        }
        return r;
      },
      text(r) {
        const list = r.timeFrames ?? [];
        if (!list.length) return 'No time frames.';
        const t0 = r.startTime ?? Math.min(...list.flatMap((t) => (t.frames ?? []).map((f) => f.start)));
        const at = (ms) => millis(ms - t0);
        return table(
          list.map((t) => {
            const frames = t.frames ?? [];
            const total = frames.reduce((n, f) => n + Math.max(0, (f.end ?? f.start) - f.start), 0);
            const spans = frames
              .slice(0, 12)
              .map((f) => `${at(f.start)}-${at(f.end ?? f.start)}`)
              .join(' ');
            return [
              oneLine(r.names?.[t.jid] ?? t.jid, 40),
              millis(total),
              plural(frames.length, 'time'),
              spans + (frames.length > 12 ? ' …' : ''),
            ];
          }),
        );
      },
    },
    'recording-url': {
      summary: 'a link to download or play a recording of a meeting',
      usage: 'wx meetings recording-url --file-id ID --category channels|recordings|wizyconfRecordings [--download]',
      details:
        'The file id is the identifier of the recording file as the record gives it. The link is presigned: whoever has it can open the file until it expires.',
      options: {
        'file-id': {type: 'string', placeholder: 'ID', description: 'the identifier of the recording file'},
        category: {
          type: 'string',
          choices: ['channels', 'recordings', 'wizyconfRecordings'],
          description: 'the category of the file',
        },
        download: {type: 'boolean', description: 'a link that always downloads (else audio and video play)'},
      },
      args: [0, 0],
      async run(ctx) {
        const v = ctx.values;
        if (!v['file-id'] || !v.category) throw new UsageError('--file-id and --category are required', ctx.usage());
        if (v['file-id'].length > 1024 || /[\s\0]/.test(v['file-id']))
          throw new UsageError(`not a file id: ${v['file-id']}`);
        return ctx
          .client(wdaClient)
          .get(
            `/insights/conferences/recording/download_url${query({fileId: v['file-id'], category: v.category, download: v.download ? '1' : undefined})}`,
          );
      },
      text: (r) => r.presignedDownloadUrl ?? '',
    },
    'schedule-summary': {
      summary: 'ask the service to generate the summary of a meeting again (only when asked: it does work)',
      usage: `wx meetings schedule-summary ${CONF}`,
      options: {},
      args: [1, 1],
      run: (ctx) =>
        ctx.client(wdaClient).post(`/insights/conferences${apiPath`/${conf(ctx)}`}/schedule_summary_generation`),
      text: () => 'The summary was scheduled: read it later with wx meetings summary.',
    },
  },
};

export const groups = {meetings: group};
