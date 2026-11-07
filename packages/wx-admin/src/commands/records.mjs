// wx-admin records: what calls leave behind on a PBX: the call history (CDR), call recordings, voicemails.
// Operations (PBX REST API):
//   GET  /PBX/CallHistory/               the whole call history (admin; callhistory:read); filters filter[field]=…,
//                                        filter[start][from|to]="YYYY-MM-DD HH:MM:SS" in the time zone of the PBX
//   GET  /User/{extension}/CallHistory/  the history of one user (admin; pbx:read)
//   GET  /PBX/recordings/                the recordings: {items: [{path, created, size}], nextPage} (recordings:read)
//   POST /PBX/recordings/download/       a task that packs the recordings of a time range ({from, to}, unix seconds)
//   GET  /PBX/recordings/download/{id}   the status of that task: {status, path}
//   GET  /VoiceMail/                     every voicemail of the PBX (pbx:read)
//   DELETE /VoiceMail/{msg_id,…}/        delete voicemails (pbx:*)
//   GET  /spoolview/recordings/{path}, /spoolview/voicemail/{path}: the files. Not under /api/v1 but at the root of the
//        PBX; a file kept in the Cloud Data Storage answers 302 to a short-lived storage link (followed without the
//        credentials of the PBX).
// A call record has its time in the PBX's own zone ("2026-11-05 15:23:18" and timezone "+0200"); text shows it in
// the local time of this machine. GET /CallHistory/{id} is the history of the signed-in user only: `call` looks a
// call up in the whole history (filter[id]).
import fs from 'node:fs';
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {refuseUnsafeWrite} from 'wldx-core/files';
import {duration, localTime, oneLine, paint, table} from 'wldx-core/format';
import {query} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';
import {userAgent} from 'wldx-core/program';

// ---- helpers shared with the other admin groups (phonebook, sound) ----

// A path of several segments (a sound in a folder, a recording file): each segment is checked and encoded, so input
// cannot climb out of the folder or add a query.
export function segmentsPath(value, what = 'path') {
  const parts = String(value ?? '')
    .split('/')
    .filter((s) => s !== '');
  if (!parts.length) throw new UsageError(`An empty ${what}`);
  for (const p of parts) {
    if (p === '.' || p === '..' || /[\x00-\x1f\x7f\\?#%]/.test(p)) throw new UsageError(`Not a ${what}: ${value}`);
  }
  return parts.map(encodeURIComponent).join('/');
}

// Checks a file to write before anything is fetched: a new file, not in a hidden or startup folder.
export function checkNewFile(ctx, to) {
  const file = path.resolve(ctx.cwd ?? process.cwd(), to);
  refuseUnsafeWrite(file, ctx.env);
  if (fs.existsSync(file)) throw new UsageError(`${to} exists: choose another file (nothing was overwritten)`);
  return file;
}

// Writes data to a new file (never overwrites; never into hidden or startup folders). Returns the real path.
export function writeNewFile(ctx, to, data) {
  const file = path.resolve(ctx.cwd ?? process.cwd(), to);
  const real = refuseUnsafeWrite(file, ctx.env);
  try {
    fs.writeFileSync(real, data, {flag: 'wx'});
  } catch (e) {
    if (e.code === 'EEXIST') throw new UsageError(`${to} exists: choose another file (nothing was overwritten)`);
    if (e.code === 'ENOENT') throw new UsageError(`No such folder for ${to}`);
    throw e;
  }
  return real;
}

const fail = (message, status) => Object.assign(new Error(message), {status, exitCode: status === 401 ? 2 : 1});

// GET a link the PBX handed out (a short-lived storage link): over https only, without the credentials of the PBX,
// no redirects.
export async function fetchLink(ctx, href, what) {
  const url = new URL(href);
  if (url.protocol !== 'https:') throw fail(`The PBX gave a link that is not https for ${what}`);
  let res;
  try {
    res = await (ctx.fetch ?? globalThis.fetch)(url.href, {
      method: 'GET',
      headers: {'user-agent': userAgent(), accept: '*/*'},
      redirect: 'error',
      signal: AbortSignal.timeout(600_000),
    });
  } catch (e) {
    throw fail(`The storage of ${what} did not answer (${e.cause?.code ?? e.message})`);
  }
  if (!res.ok)
    throw fail(`HTTP ${res.status} from the storage of ${what}: the link may have expired, try again`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

// GET a file of the PBX outside /api/v1 (/spoolview/…): the bytes. The credentials go only to the PBX; a redirect
// (Cloud Data Storage) is followed once with fetchLink(), without them.
export async function spoolDownload(ctx, client, spoolPath, scope) {
  const {target} = client;
  const custom = ctx.env.WILDIX_PBX_URL && ctx.env.WILDIX_ALLOW_CUSTOM_URL === '1';
  const base = custom
    ? ctx.env.WILDIX_PBX_URL.replace(/\/+$/, '')
    : `https://${target.host}${target.port && target.port !== 443 ? `:${target.port}` : ''}`;
  let res;
  try {
    res = await (ctx.fetch ?? globalThis.fetch)(base + spoolPath, {
      method: 'GET',
      headers: {'user-agent': userAgent(), accept: '*/*', authorization: await target.header()},
      redirect: 'manual',
      signal: AbortSignal.timeout(600_000),
    });
  } catch (e) {
    throw fail(`The PBX ${target.host} did not answer (${e.cause?.code ?? e.message})`);
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) throw fail(`HTTP ${res.status} from ${target.host} without a link to the file`, res.status);
    return fetchLink(ctx, new URL(location, base).href, `${target.host} (Cloud Data Storage)`);
  }
  if (!res.ok) {
    const why =
      {
        401: 'The PBX did not accept the access (wx-admin pbx check).',
        403: `The access may not read this file${scope ? `: an API key needs the scope ${scope}:read (or pbx:read)` : ''}.`,
        404: 'No such file on this PBX.',
      }[res.status] ?? '';
    throw fail(
      `HTTP ${res.status} from ${target.host} (GET ${spoolPath.split('?')[0]})${why ? `\n${why}` : ''}`,
      res.status,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- dates and call records ----

const DATE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?$/;

// "YYYY-MM-DD[ HH:MM[:SS]]" as the PBX takes it; a date alone is the start (or, with end, the end) of that day.
function pbxDate(value, name, end = false) {
  const m = DATE.exec(String(value).trim());
  if (!m) throw new UsageError(`--${name} is a date: YYYY-MM-DD or "YYYY-MM-DD HH:MM"`);
  return `${m[1]} ${m[2] ? `${m[2]}${m[3] ?? (end ? ':59' : ':00')}` : end ? '23:59:59' : '00:00:00'}`;
}

// Unix seconds of a date in the local time of this machine (the recordings API takes them).
function unixSeconds(value, name, end = false) {
  const t = new Date(pbxDate(value, name, end).replace(' ', 'T')).getTime();
  if (Number.isNaN(t)) throw new UsageError(`--${name}: not a date: ${value}`);
  return Math.floor(t / 1000);
}

// The time of a call record (PBX time and its zone) in ms.
export function callTime(value, zone) {
  if (!value) return undefined;
  const z = /^([+-])(\d{2}):?(\d{2})$/.exec(String(zone ?? ''));
  const t = new Date(`${String(value).replace(' ', 'T')}${z ? `${z[1]}${z[2]}:${z[3]}` : ''}`).getTime();
  return Number.isNaN(t) ? undefined : t;
}

// --disposition values (no spaces, for the shell) and what the PBX stores.
const DISPOSITIONS = {answered: 'ANSWERED', 'no-answer': 'NO ANSWER', busy: 'BUSY', failed: 'FAILED'};
const CALL_TYPES = ['call', 'fax', 'voicemail'];
const SORT_FIELDS = [
  'id',
  'start',
  'answer',
  'end',
  'src',
  'dst',
  'from_number',
  'to_number',
  'from_name',
  'to_name',
  'billsec',
  'disposition',
  'duration',
  'callclass',
  'dest_type',
  'type',
];

const HISTORY_OPTIONS = {
  since: {
    type: 'string',
    placeholder: 'DATE',
    description: 'calls from this time on: YYYY-MM-DD or "YYYY-MM-DD HH:MM", in the time zone of the PBX',
  },
  until: {
    type: 'string',
    placeholder: 'DATE',
    description: 'calls up to this time (a date alone: to the end of that day), in the time zone of the PBX',
  },
  disposition: {type: 'string', choices: Object.keys(DISPOSITIONS), description: 'only calls that ended so'},
  type: {type: 'string', choices: CALL_TYPES, description: 'only calls, faxes or voicemails'},
  search: {type: 'string', placeholder: 'TEXT', description: 'calls with this text in a number or a name'},
  filter: {
    type: 'string',
    multiple: true,
    placeholder: 'FIELD=VALUE',
    description: 'an exact filter of the API, e.g. src=201 or dst=+390212345 (filter[FIELD]=VALUE)',
  },
  count: {type: 'string', placeholder: 'N', description: 'how many calls (default 50, at most 1000)'},
  offset: {type: 'string', placeholder: 'N', description: 'skip this many calls (the next page)'},
  sort: {type: 'string', choices: SORT_FIELDS, description: 'sort by this field (default: the newest first)'},
  asc: {type: 'boolean', description: 'sort ascending (oldest first)'},
};

function wholeNumber(value, name, {min = 0, max = Infinity, fallback} = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < min || n > max)
    throw new UsageError(`--${name} is a whole number from ${min}${max < Infinity ? ` to ${max}` : ''}: ${value}`);
  return n;
}

// The query of a call-history request from the options.
function historyQuery(values) {
  const q = {
    count: wholeNumber(values.count, 'count', {min: 1, max: 1000, fallback: 50}),
    start: wholeNumber(values.offset, 'offset', {fallback: undefined}),
    sort: values.sort ?? 'id',
    dir: values.asc ? 'ASC' : 'DESC',
    search: values.search,
    'filter[start][from]': values.since === undefined ? undefined : pbxDate(values.since, 'since'),
    'filter[start][to]': values.until === undefined ? undefined : pbxDate(values.until, 'until', true),
    'filter[disposition]': DISPOSITIONS[values.disposition],
    'filter[type]': values.type,
  };
  for (const spec of values.filter ?? []) {
    const at = spec.indexOf('=');
    const key = at > 0 ? spec.slice(0, at) : '';
    if (!/^[a-z_]+$/.test(key))
      throw new UsageError(
        `--filter is FIELD=VALUE with a field of the call history (src, dst, from_number…): ${spec}`,
      );
    q[`filter[${key}]`] = spec.slice(at + 1);
  }
  return query(q);
}

const party = (number, name) => {
  const n = String(number ?? '');
  const label = String(name ?? '');
  return label && label !== n ? `${n} ${oneLine(label, 24)}` : n;
};

const callRow = (r, c) => [
  r.id,
  localTime(callTime(r.start, r.timezone)),
  party(r.from_number || r.src, r.from_name),
  '→',
  party(r.to_number || r.dst, r.to_name),
  r.disposition === 'ANSWERED' ? c.green(r.disposition) : (r.disposition ?? ''),
  r.billsec === undefined ? '' : duration(Number(r.billsec)),
  r.type && r.type !== 'call' ? r.type : '',
];

function historyText(r, ctx) {
  const c = paint(ctx);
  const records = r?.records ?? [];
  if (!records.length) return 'No calls';
  const shown = `${records.length} of ${r.total ?? records.length} calls`;
  return [
    ...table(records.map((x) => callRow(x, c))),
    c.dim(r.total > records.length ? `${shown} (--offset for more)` : shown),
  ];
}

const recordingPath = (value) =>
  segmentsPath(String(value).replace(/^\/?spoolview\/recordings\//, ''), 'recording path');

const recordingsOf = (call) => (call?.attachments?.recordings ?? []).filter((x) => x?.url);

async function findCall(client, id) {
  if (!/^\d+$/.test(String(id))) throw new UsageError(`A call id is a number: ${id}`);
  const r = await client.call('GET', `/PBX/CallHistory/${query({'filter[id]': id})}`, undefined, {
    scope: 'callhistory',
  });
  const call = (r?.records ?? []).find((x) => String(x.id) === String(id));
  if (!call) throw fail(`No call ${id} in the call history of this PBX`, 404);
  return call;
}

const sizeText = (bytes) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

const downloaded = (r) => `Saved ${r.source} (${sizeText(r.bytes)}) to ${r.file}`;

const voicemailId = (id) => {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(String(id)))
    throw new UsageError(`Not a voicemail id (msg_id of wx-admin records voicemails): ${id}`);
  return id;
};

async function voicemailList(client) {
  return (await client.call('GET', '/VoiceMail/', undefined, {scope: 'pbx'})) ?? {records: []};
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      {once: true},
    );
  });

export const groups = {
  records: {
    summary: 'what calls leave behind: the call history, call recordings, voicemails',
    commands: {
      history: {
        summary: 'the call history of the whole PBX, the newest first',
        usage:
          'wx-admin records history [--since DATE] [--until DATE] [--disposition D] [--type T] [--search TEXT] [--filter FIELD=VALUE]... [--count N] [--offset N] [--sort FIELD] [--asc]',
        details:
          'Times of --since and --until are in the time zone of the PBX; the text shows them in the local time of this computer. The duration is the talk time (billsec).',
        options: HISTORY_OPTIONS,
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', `/PBX/CallHistory/${historyQuery(ctx.values)}`, undefined, {
            scope: 'callhistory',
          });
        },
        text: historyText,
      },
      'history-user': {
        summary: 'the call history of one user (extension), the newest first',
        usage: 'wx-admin records history-user <extension> [the options of records history]',
        options: HISTORY_OPTIONS,
        args: [1, 1],
        async run(ctx) {
          const ext = ctx.positionals[0];
          if (!/^\d{1,20}$/.test(ext)) throw new UsageError(`An extension is digits: ${ext}`);
          return (await pbxClient(ctx)).call('GET', `/User/${ext}/CallHistory/${historyQuery(ctx.values)}`, undefined, {
            scope: 'pbx',
          });
        },
        text: historyText,
      },
      call: {
        summary: 'one call of the history: times, parties, result, its recordings and voicemail',
        usage: 'wx-admin records call <callId>',
        options: {},
        args: [1, 1],
        async run(ctx) {
          return findCall(await pbxClient(ctx), ctx.positionals[0]);
        },
        text(r, ctx) {
          const c = paint(ctx);
          const at = (v) => localTime(callTime(v, r.timezone), {seconds: true});
          const lines = [
            `${c.bold(`call ${r.id}`)}  ${r.type ?? ''}  ${r.disposition ?? ''}`,
            `from      ${party(r.from_number || r.src, r.from_name)}`,
            `to        ${party(r.to_number || r.dst, r.to_name)}`,
            `start     ${at(r.start)}`,
            ...(r.answer ? [`answer    ${at(r.answer)}`] : []),
            ...(r.end ? [`end       ${at(r.end)}`] : []),
            `duration  ${duration(Number(r.duration))} (talk ${duration(Number(r.billsec))})`,
            ...(r.lastapp ? [`last app  ${r.lastapp}`] : []),
          ];
          for (const x of recordingsOf(r))
            lines.push(`recording ${String(x.url).replace(/^\/?spoolview\/recordings\//, '')}`);
          for (const x of r.attachments?.vm ?? []) if (x?.url) lines.push(`voicemail ${x.url}`);
          for (const x of r.attachments?.faxes ?? []) if (x?.url) lines.push(`fax       ${x.url}`);
          return lines;
        },
      },
      recordings: {
        summary: 'the call recordings of the PBX, the newest first',
        usage: 'wx-admin records recordings [--since DATE] [--until DATE] [--count N] [--page TOKEN]',
        details:
          'Dates are in the local time of this computer. When there are more, the text ends with the --page token of the next page.',
        options: {
          since: {
            type: 'string',
            placeholder: 'DATE',
            description: 'recordings made from this time on (YYYY-MM-DD or "YYYY-MM-DD HH:MM", local time)',
          },
          until: {
            type: 'string',
            placeholder: 'DATE',
            description: 'recordings made up to this time (a date alone: to the end of that day)',
          },
          count: {type: 'string', placeholder: 'N', description: 'how many (default 50, at most 1000)'},
          page: {
            type: 'string',
            placeholder: 'TOKEN',
            description: 'the next page: the token the previous page ended with',
          },
        },
        args: [0, 0],
        async run(ctx) {
          const {values} = ctx;
          if (values.page !== undefined && !/^[A-Za-z0-9+/=_-]{1,2000}$/.test(values.page))
            throw new UsageError('--page is the token a previous page gave');
          const q = query({
            count: wholeNumber(values.count, 'count', {min: 1, max: 1000, fallback: 50}),
            start: values.page,
            from: values.since === undefined ? undefined : unixSeconds(values.since, 'since'),
            to: values.until === undefined ? undefined : unixSeconds(values.until, 'until', true),
          });
          const r = await (await pbxClient(ctx)).call('GET', `/PBX/recordings/${q}`, undefined, {scope: 'recordings'});
          const next = r?.nextPage ? new URL(r.nextPage, 'https://pbx').searchParams.get('start') : undefined;
          return {...r, ...(next ? {nextStart: next} : {})};
        },
        text(r, ctx) {
          const c = paint(ctx);
          const items = r?.items ?? [];
          if (!items.length) return 'No recordings';
          return [
            ...table(
              items.map((i) => [
                localTime(i.created * 1000),
                sizeText(i.size ?? 0),
                String(i.path ?? '').replace(/^\/?spoolview\/recordings\//, ''),
              ]),
            ),
            ...(r.nextStart ? [c.dim(`more: --page ${r.nextStart}`)] : []),
          ];
        },
      },
      'recording-download': {
        summary: 'save a call recording to a new file (by its path, or by the id of its call)',
        usage: 'wx-admin records recording-download <path|callId> --to FILE [--index N]',
        details:
          'The path is one of wx-admin records recordings (or the recording of wx-admin records call). A call id takes the recording of that call; --index chooses one when it has several.',
        options: {
          to: {type: 'string', placeholder: 'FILE', description: 'the file to write (must not exist)'},
          index: {type: 'string', placeholder: 'N', description: 'which recording of the call (1 = the first)'},
        },
        args: [1, 1],
        async run(ctx) {
          if (!ctx.values.to) throw new UsageError('--to FILE is needed', ctx.usage());
          checkNewFile(ctx, ctx.values.to);
          const ref = ctx.positionals[0];
          const client = await pbxClient(ctx);
          let source = ref;
          if (/^\d+$/.test(ref)) {
            const list = recordingsOf(await findCall(client, ref));
            if (!list.length) throw fail(`The call ${ref} has no recording`, 404);
            const i = wholeNumber(ctx.values.index, 'index', {min: 1, max: list.length, fallback: 1});
            if (list.length > 1 && ctx.values.index === undefined)
              ctx.info(`The call has ${list.length} recordings: saving the first (--index N for another)`);
            source = list[i - 1].url;
          }
          const bytes = await spoolDownload(
            ctx,
            client,
            `/spoolview/recordings/${recordingPath(source)}`,
            'recordings',
          );
          const file = writeNewFile(ctx, ctx.values.to, bytes);
          return {file, source: String(source).replace(/^\/?spoolview\/recordings\//, ''), bytes: bytes.length};
        },
        text: downloaded,
      },
      'recordings-batch': {
        summary: 'pack the recordings of a time range into one archive on the PBX, wait for it, optionally save it',
        usage:
          'wx-admin records recordings-batch (--since DATE --until DATE | --task ID) [--to FILE] [--wait-seconds N]',
        details: [
          'The PBX packs every recording made in the range (local time of this computer): a long range makes a big archive.',
          'Without --to it says where the archive is; --task checks (or waits for) a task made before.',
        ].join('\n'),
        options: {
          since: {
            type: 'string',
            placeholder: 'DATE',
            description: 'recordings made from this time on (YYYY-MM-DD or "YYYY-MM-DD HH:MM", local time)',
          },
          until: {
            type: 'string',
            placeholder: 'DATE',
            description: 'recordings made up to this time (a date alone: to the end of that day)',
          },
          task: {type: 'string', placeholder: 'ID', description: 'a task made before: check it instead of making one'},
          to: {type: 'string', placeholder: 'FILE', description: 'save the archive to this file (must not exist)'},
          'wait-seconds': {
            type: 'string',
            placeholder: 'N',
            description: 'wait at most this long for the archive (default 300; 0: do not wait)',
          },
        },
        args: [0, 0],
        async run(ctx) {
          const {values} = ctx;
          const range = values.since !== undefined || values.until !== undefined;
          if (range === Boolean(values.task)) throw new UsageError('Give --since and --until, or --task', ctx.usage());
          if (range && (values.since === undefined || values.until === undefined))
            throw new UsageError('A range needs both --since and --until', ctx.usage());
          const wait = wholeNumber(values['wait-seconds'], 'wait-seconds', {max: 3600, fallback: 300});
          if (values.to) checkNewFile(ctx, values.to);
          const client = await pbxClient(ctx);
          let task = {id: values.task};
          if (range) {
            const from = unixSeconds(values.since, 'since');
            const to = unixSeconds(values.until, 'until', true);
            if (to < from) throw new UsageError('--until is before --since');
            task = await client.call('POST', '/PBX/recordings/download/', {from, to}, {scope: 'recordings'});
            ctx.info(`Task ${task.id}: the PBX packs the recordings`);
          }
          if (!/^[A-Za-z0-9_.-]{1,200}$/.test(String(task?.id ?? '')))
            throw new UsageError(`Not a task id: ${task?.id}`);
          const deadline = ctx.clock() + wait * 1000;
          let status;
          for (;;) {
            status = await client.call('GET', `/PBX/recordings/download/${task.id}`, undefined, {scope: 'recordings'});
            if (
              status?.path ||
              /fail|error/i.test(String(status?.status ?? '')) ||
              ctx.clock() >= deadline ||
              ctx.signal.aborted
            )
              break;
            await sleep(2000, ctx.signal);
          }
          const result = {...task, ...status, id: task.id};
          if (!status?.path) return {...result, ready: false};
          if (!values.to) return {...result, ready: true};
          // The archive is a short-lived storage link (seen live), or a path on the PBX.
          const bytes = /^https?:\/\//i.test(status.path)
            ? await fetchLink(ctx, status.path, 'the archive')
            : await spoolDownload(
                ctx,
                client,
                `/${segmentsPath(String(status.path).replace(/^\/+/, ''), 'archive path')}`,
                'recordings',
              );
          return {...result, ready: true, file: writeNewFile(ctx, values.to, bytes), bytes: bytes.length};
        },
        // The link of the archive is a short-lived bearer link: only --output json shows it.
        text: (r) =>
          r.file
            ? `Saved the archive of task ${r.id} (${sizeText(r.bytes)}) to ${r.file}`
            : r.ready
              ? `Task ${r.id}: the archive is ready for a short time (--task ${r.id} --to FILE saves it; --output json shows its link)`
              : `Task ${r.id}: ${r.status || 'not ready yet'} (check again with --task ${r.id})`,
      },
      voicemails: {
        summary: 'the voicemails of the PBX, the newest first',
        usage: 'wx-admin records voicemails [--mailbox EXT] [--folder NAME]',
        options: {
          mailbox: {type: 'string', placeholder: 'EXT', description: 'only the voicemails of this mailbox (extension)'},
          folder: {type: 'string', placeholder: 'NAME', description: 'only this folder: INBOX (new), Old…'},
        },
        args: [0, 0],
        async run(ctx) {
          const r = await voicemailList(await pbxClient(ctx));
          const {mailbox, folder} = ctx.values;
          const records = (r.records ?? [])
            .filter(
              (v) =>
                mailbox === undefined ||
                String(v.origmailbox ?? v.exten) === mailbox ||
                String(v.path ?? '').startsWith(`${mailbox}/`),
            )
            .filter((v) => folder === undefined || String(v.folder ?? '').toLowerCase() === folder.toLowerCase())
            .sort((a, b) => Number(b.origtime ?? 0) - Number(a.origtime ?? 0));
          return {total: records.length, records};
        },
        text(r) {
          if (!r.records.length) return 'No voicemails';
          return table(
            r.records.map((v) => [
              localTime(Number(v.origtime) * 1000),
              String(v.path ?? '').split('/')[0] || v.origmailbox || '',
              v.folder ?? '',
              duration(Number(v.duration)),
              oneLine(v.callerid ?? '', 40),
              v.msg_id ?? '',
            ]),
          );
        },
      },
      'voicemail-download': {
        summary: 'save a voicemail message to a new file',
        usage: 'wx-admin records voicemail-download <msg_id|path> --to FILE',
        details: 'msg_id and path are those of wx-admin records voicemails.',
        options: {to: {type: 'string', placeholder: 'FILE', description: 'the file to write (must not exist)'}},
        args: [1, 1],
        async run(ctx) {
          if (!ctx.values.to) throw new UsageError('--to FILE is needed', ctx.usage());
          checkNewFile(ctx, ctx.values.to);
          const ref = ctx.positionals[0];
          const client = await pbxClient(ctx);
          let source = ref.replace(/^\/?spoolview\/voicemail\//, '');
          if (!source.includes('/')) {
            const found = ((await voicemailList(client)).records ?? []).find((v) => v.msg_id === ref);
            if (!found?.path) throw fail(`No voicemail ${ref} on this PBX (wx-admin records voicemails)`, 404);
            source = found.path;
          }
          const bytes = await spoolDownload(
            ctx,
            client,
            `/spoolview/voicemail/${segmentsPath(source, 'voicemail path')}`,
            'pbx',
          );
          return {file: writeNewFile(ctx, ctx.values.to, bytes), source, bytes: bytes.length};
        },
        text: downloaded,
      },
      'voicemail-delete': {
        summary: 'delete voicemails for good (needs --yes)',
        usage: 'wx-admin records voicemail-delete <msg_id>... --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete them (they cannot be brought back)'}},
        args: [1, 100],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError('A deleted voicemail cannot be brought back: confirm with --yes', ctx.usage());
          const ids = ctx.positionals.map(voicemailId);
          return (await pbxClient(ctx)).call('DELETE', `/VoiceMail/${ids.join(',')}/`, undefined, {scope: 'pbx'});
        },
        text(r) {
          const errors = Array.isArray(r?.errors) ? r.errors : [];
          return [
            `Deleted ${r?.changed ?? 0} voicemail${r?.changed === 1 ? '' : 's'}`,
            ...errors.map((e) => `  ${oneLine(typeof e === 'string' ? e : JSON.stringify(e), 160)}`),
          ];
        },
      },
    },
  },
};
