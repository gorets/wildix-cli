// Wildix Data Analytics (https://wda.wildix.com/v2): the history of calls and conferences, their AI insights, the
// search over conversations and the queue reports (x-caracal). A client bound to the token, and the helpers the
// commands of wx calls, meetings, conversations and reports share (ids, numbers, dates, the shapes of the skill).
import fs from 'node:fs';
import path from 'node:path';
import {HttpError, UsageError} from 'wldx-core/errors';
import {refuseUnsafeWrite} from 'wldx-core/files';
import {request} from 'wldx-core/http';
import {wdaUrl} from 'wldx-core/services';

const FORBIDDEN_HINT =
  'The login has no access to this record (a meeting or call of other people, or a role without the right).';

// wdaClient({token, env, fetchImpl}) (for ctx.client): get(path), post(path, body), soft(path) (null on a 404).
// The path is relative to /v2 and built with apiPath`` by the caller.
export function wdaClient({token, env, fetchImpl}) {
  const root = `${wdaUrl(env)}/v2`;
  async function call(method, p, body) {
    try {
      return await request(root + p, {method, token, body, fetchImpl, service: 'WDA'});
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) e.message += `\n${FORBIDDEN_HINT}`;
      throw e;
    }
  }
  return {
    get: (p) => call('GET', p),
    post: (p, body) => call('POST', p, body),
    async soft(p) {
      try {
        return await call('GET', p);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
  };
}

// An optional part of a readable card (a summary, insights): null when it is not there (404); another failure is
// told on stderr and the card goes on without it (as the scripts of the skill do).
export async function optional(promise, info) {
  try {
    return await promise;
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) info(`Warning: ${e.message.split('\n')[0]}`);
    return null;
  }
}

// Nothing to show: no transcription, or no such record. Exit code 3, as in the scripts of the skill.
export class NoDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoDataError';
    this.exitCode = 3;
  }
}

const ID = /^[A-Za-z0-9_+][A-Za-z0-9_.:+-]*$/;

// An id that goes into a request path (a call id, a queue id, a file id).
export function checkId(what, value) {
  const v = String(value ?? '');
  if (!ID.test(v) || v.includes('..')) throw new UsageError(`${what} is not a valid id: ${value}`);
  return v;
}

// A conference id from an id or a link (the last path segment of .../insights/conferences/<id>).
export function conferenceId(input) {
  const v = String(input).split(/[?#]/)[0].replace(/\/$/, '').split('/').pop();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(v) || v.includes('..') || v === 'conferences')
    throw new UsageError(`not a conference id: ${input}`);
  return v;
}

// A call: the call id and the flow index (a transferred call has several flows; the first is 0).
export function callFlow(positionals) {
  const [id, flow = '0'] = positionals;
  if (!/^\d{1,9}$/.test(flow)) throw new UsageError(`the flow index must be a number: ${flow}`);
  return {callId: checkId('the call id', id), flow: Number(flow)};
}

// A whole number from min to max (the services refuse anything else with a 400 that tells little).
export function intOption(name, value, min, max) {
  if (value === undefined) return undefined;
  if (!/^\d{1,12}$/.test(value) || Number(value) < min || Number(value) > max)
    throw new UsageError(`${name} must be a whole number from ${min} to ${max}: ${value}`);
  return Number(value);
}

export function checkZone(value) {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(value)) throw new UsageError(`not a time zone: ${value}`);
  return value;
}

// An ISO time given to a filter (--from, --to of the call history and the search): passed on as it is, once it
// is a time at all.
export function checkIso(name, value) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value)))
    throw new UsageError(`${name} must be an ISO time (2026-11-07 or 2026-11-07T09:00:00Z): ${value}`);
  return value;
}

// The local IANA time zone (TZ, else the zone of the machine).
export const localZone = (env) => env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// jq's todate: "2026-11-05T11:21:29Z" from milliseconds.
export const isoSeconds = (ms) => new Date(Math.floor((ms || 0) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// jq's `a // b // c`: the first value that is not null, undefined or false.
export const alt = (...values) => values.find((v) => v !== null && v !== undefined && v !== false) ?? null;

// {k: obj[k] ?? null} for the keys (jq's `{a, b}`).
export const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? null]));

// jq's `unique`: sorted, no repeats.
export const unique = (values) => [...new Set(values)].sort();

// The insights that succeeded, as {projectionId: {fieldId: value}}.
export function compactInsights(r) {
  const out = {};
  for (const p of r?.insights ?? []) {
    if (p.status !== 'SUCCEEDED' || !(p.fields ?? []).length) continue;
    out[p.id] = Object.fromEntries(p.fields.map((f) => [f.id, f.value ?? null]));
  }
  return out;
}

// The participants of a conference by name (or e-mail), each once.
export const participantNames = (conference) =>
  unique(
    (conference?.participants ?? [])
      .map((p) => alt(p.info?.name, p.info?.email))
      .filter((n) => n !== null)
      .map((n) => String(n).replace(/\s+/g, ' ').trim()),
  );

// Writes a transcript to a private file (folders 0700, file 0600) and returns its absolute path. An existing path
// is replaced only when it is a transcript of the same conference written earlier (its second line is
// "# conferenceId: <id>"): the path may have come from fetched text, so nothing else is touched.
export function writePrivate(file, content, {cwd, conferenceId: id, env = process.env} = {}) {
  if (!file) throw new UsageError('empty output path');
  const target = path.resolve(cwd ?? process.cwd(), file);
  refuseUnsafeWrite(target, env);
  let exists = false;
  try {
    fs.lstatSync(target);
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (exists) {
    let second;
    try {
      second = fs.readFileSync(target, 'utf8').slice(0, 8192).split('\n')[1];
    } catch {
      second = undefined;
    }
    if (!id || second !== `# conferenceId: ${id}`)
      throw new Error(`${file} exists: choose another path (nothing was overwritten)`);
  }
  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  fs.writeFileSync(target, content, {mode: 0o600, flag: exists ? 'w' : 'wx'});
  return target;
}

// "1 queue", "2 queues".
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
