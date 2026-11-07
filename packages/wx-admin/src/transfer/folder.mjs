// The folder of a config export: one JSON Lines file per kind (<kind>.jsonl, one {"name", "data"} per line) and
// manifest.json (the format, where it comes from, the counts, what the safety scan and the references found). A
// transport, not something to edit: the serial of the source is never in it.
import fs from 'node:fs';
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload, refuseUnsafeWrite} from 'wldx-core/files';
import {TRANSFER_KINDS} from './kinds.mjs';

export const FORMAT = 'wx-admin-export/1';

export function writeExport(ctx, dir, {source, portable}) {
  const target = path.resolve(ctx.cwd ?? process.cwd(), dir);
  refuseUnsafeWrite(target, ctx.env); // before anything is made
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  if (fs.readdirSync(target).length)
    throw new UsageError(`${dir} is not empty: export into a new or empty folder (nothing was overwritten)`);
  const counts = {};
  for (const [kind, objects] of Object.entries(portable.kinds)) {
    if (!Object.hasOwn(TRANSFER_KINDS, kind)) throw new UsageError(`Unknown kind: ${kind}`);
    const text = objects.map((o) => JSON.stringify({name: o.name, data: o.data})).join('\n');
    fs.writeFileSync(path.join(target, `${kind}.jsonl`), objects.length ? `${text}\n` : '', {flag: 'wx', mode: 0o600});
    counts[kind] = objects.length;
  }
  const manifest = {
    format: FORMAT,
    source: {host: source.host, wms: source.wms, exportedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString()},
    kinds: counts,
    errors: portable.errors ?? {},
    bound: portable.bound ?? [],
    external: portable.external ?? [],
    unresolved: portable.unresolved ?? [],
    outside: portable.outside ?? [],
    needs: portable.needs ?? {},
    soft: portable.soft ?? {},
  };
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return {dir: target, counts};
}

// The folder read back: {manifest, kinds: {[kind]: [{name, data}]}}. Each file goes through the checks of anything
// read to be sent (no credentials, nothing hidden in the home folder); a line that is not JSON is named by its number,
// never by its content.
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
    const lines = readForUpload(path.join(base, file), ctx.env).toString('utf8').split('\n');
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
      kinds[kind].push({name: o.name, data: o.data});
    }
  }
  return {manifest, kinds};
}
