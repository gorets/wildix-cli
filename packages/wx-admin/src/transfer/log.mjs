// The log of a config import: wx-admin-import-<host>-<YYYY-MM-DDTHH-MM-SS>.log in the folder asked for (else the
// current one), mode 0600, never over a file, never into a hidden or startup folder. One line per event, timed;
// written at once (a run that stops keeps what it logged). The caller never passes a secret.
import fs from 'node:fs';
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {refuseUnsafeWrite} from 'wldx-core/files';
import {clean} from 'wldx-core/format';

export function openLog(ctx, {dir, host, now}) {
  const folder = path.resolve(ctx.cwd ?? process.cwd(), dir ?? '.');
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/:/g, '-');
  const name = `wx-admin-import-${String(host).replace(/[^A-Za-z0-9_.-]/g, '_')}-${stamp}.log`;
  const file = path.join(refuseUnsafeWrite(folder, ctx.env), name);
  refuseUnsafeWrite(file, ctx.env);
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') throw new UsageError(`${file} exists: nothing was overwritten`);
    throw e;
  }
  const clock = ctx.clock ?? (() => now);
  return {
    path: file,
    line(text) {
      // clean() keeps colour codes for a terminal; a file gets none
      const plain = clean(String(text)).replace(/\x1b\[[0-9;]*m/g, '');
      for (const l of plain.split('\n')) fs.writeSync(fd, `${new Date(clock()).toISOString()} ${l}\n`);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}
