// The folder of a config export: one JSON Lines file per kind (<kind>.jsonl, one {"name", "data"} per line) and
// manifest.json (the format, where it comes from, the counts, what the safety scan and the references found). A
// transport, not something to edit: the serial of the source is never in it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload, refuseUnsafeWrite} from 'wldx-core/files';
import {MASK} from '../cloud/mask.mjs';
import {TRANSFER_KINDS} from './kinds.mjs';

export const FORMAT = 'wx-admin-export/1';

// A path of a file marker, as a place inside the folder: relative, no `..`, no symbolic link on the way.
function insideFolder(base, rel, where) {
  const bad = () => new UsageError(`${where}: not a path inside the export folder: ${rel}`);
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === '..' || s === ''))
    throw bad();
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) throw bad();
  for (let at = full; at.startsWith(base + path.sep); at = path.dirname(at))
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink())
      throw new UsageError(`${where}: ${rel} goes through a symbolic link`);
  return full;
}

// Every object with a `$file` key, anywhere in a value: each must carry a string sha256.
function fileMarkers(v, where, out = []) {
  if (Array.isArray(v)) for (const x of v) fileMarkers(x, where, out);
  else if (v && typeof v === 'object') {
    if (Object.hasOwn(v, '$file')) {
      if (typeof v.sha256 !== 'string' || typeof v.$file !== 'string')
        throw new UsageError(`${where}: a $file marker without a sha256: ${v.$file}`);
      out.push(v);
    } else for (const x of Object.values(v)) fileMarkers(x, where, out);
  }
  return out;
}

// The mask as the cloud services put it: a whole value, or the value of a key or token in the query of a URI. Other
// asterisks are text (agent instructions may hold a row of them).
const MASKED_QUERY = new RegExp(`[?&][^=&#\\s]+=${MASK.replace(/\*/g, '\\*')}(?=$|[&#\\s])`);
const masked = (s) => s === MASK || MASKED_QUERY.test(s);

// The first path where a value (or a key) holds the mask of a secret, else undefined.
function maskedPath(v, at = '') {
  if (typeof v === 'string') return masked(v) ? at : undefined;
  if (!v || typeof v !== 'object') return undefined;
  for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v)) {
    const where = Array.isArray(v) ? `${at}[${k}]` : at ? `${at}.${k}` : String(k);
    if (String(k) === MASK) return where;
    const found = maskedPath(x, where);
    if (found !== undefined) return found;
  }
  return undefined;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A file of the export folder (a kind's JSON Lines, a skill file), inside the folder whose manifest.json passed the
// checks of anything read to be sent: every check of the file itself but its name, which wx-admin wrote from the
// source company (wilma-secrets.jsonl, a skill's secret-notes.md), not one picked from the disk: a regular file, not
// a link, no other hard link, the same file when it is read.
function readFolderFile(full) {
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    throw new UsageError(`File not found: ${full}`);
  }
  if (!stat.isFile()) throw new UsageError(`Not a file: ${full}`);
  if (stat.nlink > 1)
    throw new UsageError(`Refusing to attach a file with other hard links (it could be a credential): ${full}`);
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const now = fs.fstatSync(fd);
    if (now.ino !== stat.ino || now.dev !== stat.dev || now.nlink > 1)
      throw new UsageError(`The file changed while it was checked: ${full}`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// What an object writes, checked before the first write: every marker has its bytes (matching its sha256) and every
// key of `files` is named by a marker, each inside the folder.
function filesToWrite(target, kind, o) {
  const where = `${kind}/${o.name}`;
  const files = o.files ?? {};
  const named = new Set();
  const out = [];
  for (const m of fileMarkers(o.data, where)) {
    const full = insideFolder(target, m.$file, where);
    if (!Object.hasOwn(files, m.$file)) throw new UsageError(`${where}: no bytes for ${m.$file}`);
    if (sha256(files[m.$file]) !== m.sha256) throw new UsageError(`${where}: ${m.$file} does not match its sha256`);
    if (!named.has(m.$file)) out.push([full, files[m.$file]]);
    named.add(m.$file);
  }
  for (const rel of Object.keys(files))
    if (!named.has(rel)) throw new UsageError(`${where}: bytes for ${rel}, which no marker names`);
  return out;
}

export function writeExport(ctx, dir, {source, portable}) {
  const target = path.resolve(ctx.cwd ?? process.cwd(), dir);
  refuseUnsafeWrite(target, ctx.env); // before anything is made
  const planned = [];
  for (const [kind, objects] of Object.entries(portable.kinds)) {
    if (!Object.hasOwn(TRANSFER_KINDS, kind)) throw new UsageError(`Unknown kind: ${kind}`);
    for (const o of objects) planned.push(...filesToWrite(target, kind, o));
  }
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  if (fs.readdirSync(target).length)
    throw new UsageError(`${dir} is not empty: export into a new or empty folder (nothing was overwritten)`);
  const counts = {};
  for (const [kind, objects] of Object.entries(portable.kinds)) {
    const text = objects.map((o) => JSON.stringify({name: o.name, data: o.data})).join('\n');
    fs.writeFileSync(path.join(target, `${kind}.jsonl`), objects.length ? `${text}\n` : '', {flag: 'wx', mode: 0o600});
    counts[kind] = objects.length;
  }
  for (const [full, bytes] of planned) {
    fs.mkdirSync(path.dirname(full), {recursive: true, mode: 0o700});
    fs.writeFileSync(full, bytes, {flag: 'wx', mode: 0o600});
  }
  const manifest = {
    format: FORMAT,
    source: {
      host: source.host,
      wms: source.wms,
      ...(source.company ? {company: source.company} : {}),
      ...(source.env ? {env: source.env} : {}),
      exportedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    },
    kinds: counts,
    errors: portable.errors ?? {},
    bound: portable.bound ?? [],
    external: portable.external ?? [],
    unresolved: portable.unresolved ?? [],
    outside: portable.outside ?? [],
    needs: portable.needs ?? {},
    soft: portable.soft ?? {},
    ...(portable.warnings?.length ? {warnings: portable.warnings} : {}),
  };
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return {dir: target, counts};
}

// The folder read back: {manifest, kinds: {[kind]: [{name, data}]}}. manifest.json goes through the checks of
// anything read to be sent (no credentials, nothing hidden in the home folder), the other files through readFolderFile
// (the same but their names, given by wx-admin); an object holding the mask of a secret is refused; a line that is not
// JSON is named by its number, never by its content.
export async function readExport(ctx, dir) {
  const base = path.resolve(ctx.cwd ?? process.cwd(), dir);
  let manifest;
  try {
    manifest = JSON.parse(readForUpload(path.join(base, 'manifest.json'), ctx.env).toString('utf8'));
  } catch (e) {
    if (e instanceof UsageError && !/File not found/.test(e.message)) throw e;
    manifest = undefined;
  }
  if (manifest?.format !== FORMAT) throw new UsageError(`${dir} is not a folder of wx-admin config export (${FORMAT})`);
  const kinds = {};
  for (const kind of Object.keys(manifest.kinds ?? {})) {
    if (!Object.hasOwn(TRANSFER_KINDS, kind)) throw new UsageError(`Unknown kind in ${dir}: ${kind}`);
    const file = `${kind}.jsonl`;
    const lines = readFolderFile(path.join(base, file)).toString('utf8').split('\n');
    kinds[kind] = [];
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        throw new UsageError(`${file}:${i + 1} is not JSON`);
      }
      if (typeof o?.name !== 'string' || !o.data || typeof o.data !== 'object')
        throw new UsageError(`${file}:${i + 1} is not an object of the export ({"name", "data"})`);
      // The mask of a secret written back would replace the secret on the target: such a folder is refused.
      const masked = maskedPath(o.data);
      if (masked !== undefined)
        throw new UsageError(
          `${kind}/${o.name}: ${masked || '.'} holds the mask ${MASK}, not a value: export again (a secret is a $secret marker)`,
        );
      const files = {};
      for (const m of fileMarkers(o.data, `${kind}/${o.name}`)) {
        const where = `${kind}/${o.name}`;
        const bytes = readFolderFile(insideFolder(base, m.$file, where));
        if (sha256(bytes) !== m.sha256) throw new UsageError(`${where}: ${m.$file} does not match its sha256`);
        files[m.$file] = bytes;
      }
      kinds[kind].push({name: o.name, data: o.data, ...(Object.keys(files).length ? {files} : {})});
    }
  }
  return {manifest, kinds};
}
