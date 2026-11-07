// What a config export carries: --all, --only KIND:NAME,…, or the picker; and what an object brings with it.
import {UsageError} from 'wldx-core/errors';
import {keyOf} from './refs.mjs';
import {TRANSFER_KINDS} from './kinds.mjs';

export const GROUPS = [
  {id: 'routing', label: 'Routing'},
  {id: 'users', label: 'Users and rights'},
  {id: 'trunks', label: 'Trunks'},
];

// Split at the commas that are not escaped; \, and \\ in a name stand for , and \.
function splitList(spec) {
  const out = [''];
  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec[i];
    if (ch === '\\' && (spec[i + 1] === ',' || spec[i + 1] === '\\')) out[out.length - 1] += spec[(i += 1)];
    else if (ch === ',') out.push('');
    else out[out.length - 1] += ch;
  }
  return out;
}

// --only "dialplans:main,queues:*" → [{kind, name}] ("*": every object of the kind; a name may hold "/" and ":",
// and "," written \,).
export function parseOnly(spec) {
  return splitList(String(spec))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const at = s.indexOf(':');
      const kind = at < 0 ? s : s.slice(0, at);
      if (!Object.hasOwn(TRANSFER_KINDS, kind))
        throw new UsageError(`Unknown kind: ${kind}. Known: ${Object.keys(TRANSFER_KINDS).join(', ')}`);
      return {kind, name: at < 0 ? '*' : s.slice(at + 1)};
    });
}

// The families of the dialplan database the dialplans read or write: DB(family/key), DB_EXISTS(…), DB_DELETE(…).
export function dbFamiliesOf(dialplans = []) {
  const text = JSON.stringify(dialplans.map((d) => d.data));
  return [...new Set([...text.matchAll(/DB(?:_EXISTS|_DELETE)?\(([A-Za-z0-9_.:+@-]+)\//g)].map((m) => m[1]))];
}

const boundKeys = (portable) => new Set((portable.bound ?? []).map((b) => keyOf(b.kind, b.name)));

// The keys and everything they need, transitively (only objects of the export).
export function closure(portable, keys) {
  const have = new Set(Object.entries(portable.kinds).flatMap(([k, list]) => list.map((o) => keyOf(k, o.name))));
  const out = new Set();
  const add = (key) => {
    if (out.has(key) || !have.has(key)) return;
    out.add(key);
    for (const n of portable.needs?.[key] ?? []) add(n);
  };
  for (const k of keys) add(k);
  return out;
}

// The groups of the picker: objects by group of their kind; bound objects cannot be chosen; users not ticked unless
// asked for.
export function pickerGroups(portable, {users = false} = {}) {
  const bound = new Map((portable.bound ?? []).map((b) => [keyOf(b.kind, b.name), b]));
  return GROUPS.map((g) => ({
    ...g,
    items: Object.entries(portable.kinds)
      .filter(([kind]) => TRANSFER_KINDS[kind].group === g.id)
      .flatMap(([kind, list]) =>
        list.map((o) => {
          const key = keyOf(kind, o.name);
          const b = bound.get(key);
          return {
            id: key,
            label: `${TRANSFER_KINDS[kind].label} ${o.name}`,
            checked: !b && (kind !== 'users' || users),
            ...(b ? {disabled: `bound to the source PBX: ${b.found} in ${b.path}`} : {}),
          };
        }),
      ),
  })).filter((g) => g.items.length);
}

// The keys to export: --all (users with --users), --only (with what they need), else the picker.
export async function chooseExport(portable, values, {interactive, select}) {
  const bound = boundKeys(portable);
  const all = Object.entries(portable.kinds).flatMap(([kind, list]) => list.map((o) => keyOf(kind, o.name)));
  let keys;
  if (values.all) keys = all.filter((k) => !k.startsWith('users/') || values.users);
  else if (values.only) {
    const wanted = parseOnly(values.only);
    keys = all.filter((k) =>
      wanted.some((w) => k.startsWith(`${w.kind}/`) && (w.name === '*' || k === keyOf(w.kind, w.name))),
    );
  } else if (interactive) {
    const chosen = await select({
      title: 'What to export (space: tick, enter: done)',
      groups: pickerGroups(portable, {users: values.users}),
      requires: (key) => (portable.needs?.[key] ?? []).filter((k) => all.includes(k)),
    });
    keys = [...chosen];
  } else throw new UsageError('Without a terminal, choose what to export with --all or --only KIND:NAME,…');
  return new Set([...closure(portable, keys)].filter((k) => !bound.has(k)));
}

// The export with only the chosen objects (and the notes about them).
export function selectFrom(portable, keys) {
  const kinds = {};
  for (const [kind, list] of Object.entries(portable.kinds)) {
    const kept = list.filter((o) => keys.has(keyOf(kind, o.name)));
    if (kept.length) kinds[kind] = kept;
  }
  const mine = (x) => keys.has(keyOf(x.kind, x.name));
  const pick = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([k]) => keys.has(k)));
  return {
    kinds,
    errors: portable.errors,
    bound: portable.bound,
    external: (portable.external ?? []).filter(mine),
    unresolved: (portable.unresolved ?? []).filter(mine),
    outside: (portable.outside ?? []).filter((o) => keys.has(o.from)),
    needs: pick(portable.needs),
    soft: pick(portable.soft),
  };
}
