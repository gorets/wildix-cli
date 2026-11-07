// Helpers of the chat commands (wx chat, channel, inbox, file, user, section): the checks of the agent skill's
// lib.sh (whole numbers in a range, ids, reaction types, secret paths), the user id of the logged-in user, names
// of users for the text output, and the presigned upload and download of files (no token goes to those URLs).
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {jwtClaims} from 'wldx-core/auth';
import {UsageError} from 'wldx-core/errors';
import {readForUpload, refuseUnsafeWrite} from 'wldx-core/files';
import {apiPath, request} from 'wldx-core/http';
import {streamClient} from '../stream.mjs';

// The operations the service answers with HTTP 400 "Operation <Name> is not implemented." (checked 2026-11-05).
export const NOT_IMPLEMENTED_CHECKED = '2026-11-05';
export const NOT_IMPLEMENTED = ' (not implemented by the service yet)';
export const notImplemented = (operation) =>
  `The service does not implement ${operation} yet (it answers HTTP 400 "Operation ${operation} is not implemented.", checked ${NOT_IMPLEMENTED_CHECKED}). Do not retry it.`;

// A whole number from min to max (the service refuses anything else with a 400 that tells little); undefined stays.
export function checkInt(name, value, min, max) {
  if (value === undefined) return undefined;
  const s = String(value);
  if (!/^\d{1,12}$/.test(s) || Number(s) < min || Number(s) > max)
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}: ${value}`);
  return Number(s);
}

// An id that goes into a request path or a body: id characters only, never "/", "?", "#", ".." or nothing.
export function checkId(what, value) {
  const v = String(value ?? '');
  if (!/^[A-Za-z0-9_+][A-Za-z0-9_.:+-]*$/.test(v) || v.includes('..'))
    throw new UsageError(`${what} is not a valid id: ${value}`);
  return v;
}

export function checkReaction(type) {
  if (!/^[a-z0-9_+-]{1,64}$/.test(String(type)))
    throw new UsageError(`A reaction type must match [a-z0-9_+-] (up to 64): ${type}`);
  return type;
}

// The id of a new group channel: 8-4-4-4-8 characters. Without one the service makes a 36-character id that none
// of its own calls accepts afterwards.
export const CHANNEL_ID = /^[0-9a-z_]{8}-[0-9a-z_]{4}-[0-9a-z_]{4}-[0-9a-z_]{4}-[0-9a-z_]{8}$/;
export const newChannelId = () => randomUUID().slice(0, -4);

// The text argument; "-" reads stdin.
export async function readText(arg, stdin) {
  if (arg !== '-') return arg;
  const chunks = [];
  for await (const c of stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

export const api = (ctx) => ctx.client(streamClient);

// The stream user id of the logged-in user, found by the e-mail of the token (once per context).
const ME = Symbol('me');
export async function meId(ctx, client = api(ctx)) {
  if (ctx[ME]) return ctx[ME];
  const email = jwtClaims(ctx.token).email;
  if (!email) throw new Error('The login token carries no e-mail');
  const r = await client.call('POST', '/users/query', {query: {emails: [email]}});
  const id = r?.users?.[0]?.id;
  if (!id) throw new Error('Could not find your chat user');
  ctx[ME] = id;
  return id;
}

export const displayName = (u) => u?.displayName ?? u?.name;

// The users of these ids, one users query per 100 ids: Map id -> user. A lookup that fails gives no users (a name
// is a nicety of the text output: the id is printed instead).
export async function usersById(client, ids) {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    try {
      const r = await client.call('POST', '/users/query', {query: {ids: unique.slice(i, i + 100)}});
      for (const u of r?.users ?? []) out.set(u.id, u);
    } catch {
      // names stay ids
    }
  }
  return out;
}

// Names for the text output ride on the result under a symbol: JSON output (JSON.stringify) never sees them.
export const NAMES = Symbol('names');
export async function withNames(ctx, data, ids, client = api(ctx)) {
  if (ctx.output !== 'text' || !data || typeof data !== 'object') return data;
  const users = await usersById(client, ids);
  Object.defineProperty(data, NAMES, {value: users, enumerable: false});
  return data;
}
export const nameIn = (data, id) => (id ? (displayName(data?.[NAMES]?.get(id)) ?? id) : '');

// The ids of people a message names: its author, the author of its quote.
export const messageUserIds = (m) => [m?.userId, m?.quote?.userId, m?.pinnedBy];

// ── files ───────────────────────────────────────────────────────────────────────────────────────────────────

// The checks of files to attach and to save: src/files.mjs.
export {refuseSecretPath} from 'wldx-core/files';

const MIME = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
export const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

// A presigned URL of the storage: https (http only with WILDIX_ALLOW_CUSTOM_URL=1, tests). It gets no token.
function presigned(url, env) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('The service gave no valid storage link');
  }
  if (u.protocol !== 'https:' && !(env.WILDIX_ALLOW_CUSTOM_URL === '1' && u.protocol === 'http:'))
    throw new Error(`The storage link is not https: ${u.protocol}`);
  return u.href;
}

const ATTACHMENT_FIELDS = ['fsId', 'name', 'size', 'mime', 'width', 'height', 'thumbnail'];
export const attachmentOf = (f) =>
  Object.fromEntries(ATTACHMENT_FIELDS.filter((k) => f?.[k] !== undefined && f?.[k] !== null).map((k) => [k, f[k]]));

// Uploads a file to a channel and returns the attachment object to put into a message (fsId, name, size, mime…).
export async function uploadFile(ctx, channel, file, client = api(ctx)) {
  const data = readForUpload(path.resolve(ctx.cwd ?? process.cwd(), file), ctx.env);
  const name = path.basename(file);
  const r = await client.call('POST', apiPath`/channels/${channel}/files`, {name});
  if (!r?.fsId || !r?.presignedUploadUrl) throw new Error('Unexpected answer of the upload: no fsId or link');
  const fsId = checkId('The file id of the answer', r.fsId);
  await request(presigned(r.presignedUploadUrl, ctx.env), {
    method: 'PUT',
    raw: {data, contentType: mimeOf(file)},
    responseType: 'text',
    fetchImpl: ctx.fetch,
    timeoutMs: 600_000,
    service: 'the storage',
  });
  const info = await client.call('GET', apiPath`/channels/${channel}/files/${fsId}`);
  return attachmentOf(info?.file ?? {fsId, name, size: data.length});
}

// Saves a file of a message to `to`, which must not exist yet (nothing is ever overwritten).
export async function downloadFile(ctx, channel, message, fsId, to, client = api(ctx)) {
  const out = path.resolve(ctx.cwd ?? process.cwd(), to);
  refuseUnsafeWrite(out, ctx.env);
  if (fs.existsSync(out))
    throw new UsageError(`${to} exists already: choose another path (nothing was overwritten or deleted)`);
  const dir = path.dirname(out);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    throw new UsageError(`The folder of ${to} does not exist`);
  const r = await client.call(
    'GET',
    apiPath`/channels/${channel}/messages/${message}/files/${fsId}/download-url` + '?download=1',
  );
  if (!r?.presignedDownloadUrl) throw new Error('No download link in the answer');
  const data = await request(presigned(r.presignedDownloadUrl, ctx.env), {
    responseType: 'buffer',
    fetchImpl: ctx.fetch,
    timeoutMs: 600_000,
    service: 'the storage',
  });
  const tmp = path.join(dir, `.download.${process.pid}.${randomUUID().slice(0, 8)}`);
  fs.writeFileSync(tmp, data, {flag: 'wx', mode: 0o600});
  try {
    fs.linkSync(tmp, out); // fails when the path appeared meanwhile: never overwrites
  } catch (e) {
    if (e.code === 'EEXIST') throw new UsageError(`${to} appeared meanwhile: nothing was overwritten`);
    throw e;
  } finally {
    fs.rmSync(tmp, {force: true});
  }
  return {ok: true, file: out, bytes: data.length};
}
