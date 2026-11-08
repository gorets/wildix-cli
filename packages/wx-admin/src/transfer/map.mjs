// --map FILE: renames of objects on the target side, {[kind]: {[from]: to}}. applyMap() renames the objects of a
// mapped kind (their name, and the data field holding it when the kind declares `nameField`) and every reference to
// them (the $ref markers and the keys of needs, soft, bound, external, unresolved, outside and warnings).
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload} from 'wldx-core/files';
import {TRANSFER_KINDS} from './kinds.mjs';
import {keyOf, splitKey} from './refs.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function readMap(ctx, file) {
  const where = file === '-' ? '--map stdin' : `--map ${file}`;
  let text;
  if (file === '-') {
    const chunks = [];
    for await (const c of ctx.stdin) chunks.push(Buffer.from(c));
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    try {
      text = readForUpload(path.resolve(ctx.cwd ?? process.cwd(), file), ctx.env).toString('utf8');
    } catch (e) {
      if (e instanceof UsageError) throw new UsageError(`${where}: ${e.message}`);
      throw new UsageError(`${where}: ${e.code === 'ENOENT' ? 'no such file' : (e.code ?? e.message)}`);
    }
  }
  let map;
  try {
    map = JSON.parse(text);
  } catch {
    throw new UsageError(`${where} is not JSON`);
  }
  if (!isObject(map)) throw new UsageError(`${where} is not a JSON object of kinds`);
  const known = Object.keys(TRANSFER_KINDS);
  for (const [kind, entries] of Object.entries(map)) {
    if (!known.includes(kind)) throw new UsageError(`${where}: unknown kind ${kind} (known: ${known.join(', ')})`);
    if (!isObject(entries)) throw new UsageError(`${where}: ${kind} must be an object of names`);
    for (const [from, to] of Object.entries(entries))
      if (typeof to !== 'string') throw new UsageError(`${where}: ${kind} ${from}: the new name must be a string`);
  }
  return map;
}

// The kinds whose names are e-mails: known in lower case (as the directory matches them), so mapped in any case.
const BY_EMAIL = ['xbees-users'];

export function applyMap(portable, given) {
  const out = structuredClone(portable);
  const map = {...given};
  for (const kind of BY_EMAIL)
    if (isObject(map[kind]))
      map[kind] = Object.fromEntries(Object.entries(map[kind]).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
  const to = (kind, name) => (Object.hasOwn(map[kind] ?? {}, name) ? map[kind][name] : name);
  const key = (k) => {
    const {kind, name} = splitKey(k);
    return keyOf(kind, to(kind, name));
  };

  const renameRefs = (v) => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v) && typeof v.$ref === 'string') {
      v.$ref = key(v.$ref);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) renameRefs(x);
  };

  for (const [kind, list] of Object.entries(out.kinds ?? {})) {
    const field = TRANSFER_KINDS[kind]?.nameField;
    for (const o of list) {
      renameRefs(o.data);
      if (!Object.hasOwn(map[kind] ?? {}, o.name)) continue;
      o.name = to(kind, o.name);
      if (field && o.data && typeof o.data === 'object' && field in o.data) o.data[field] = o.name;
      // The draft of a versioned object (a Wilma tool) carries its name too.
      const draft = o.data?.draft;
      if (field && draft && typeof draft === 'object' && !Array.isArray(draft) && field in draft) draft[field] = o.name;
    }
  }

  for (const f of ['needs', 'soft'])
    if (out[f]) out[f] = Object.fromEntries(Object.entries(out[f]).map(([k, list]) => [key(k), list.map(key)]));

  // An entry names its object by {kind, name}, and may name another by `from` (outside: kind is then the target's).
  for (const f of ['bound', 'external', 'unresolved', 'warnings'])
    for (const e of out[f] ?? []) if (Object.hasOwn(map[e.kind] ?? {}, e.name)) e.name = to(e.kind, e.name);
  for (const e of out.outside ?? []) {
    if (typeof e.from !== 'string') continue;
    const renamed = key(e.from);
    if (renamed !== e.from) {
      e.from = renamed;
      e.name = splitKey(renamed).name;
    }
  }
  for (const f of ['bound', 'external', 'unresolved', 'warnings'])
    for (const e of out[f] ?? []) if (typeof e.from === 'string') e.from = key(e.from);
  return out;
}
