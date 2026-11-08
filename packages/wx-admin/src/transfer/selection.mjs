// What a config export carries: --all, --only KIND:NAME,…, or the picker; and what an object brings with it.
import {UsageError} from 'wldx-core/errors';
import {boundText, keyOf, ownBoundReason, splitKey} from './refs.mjs';
import {EXPORTED, isCloud, TRANSFER_KINDS} from './kinds.mjs';

export const GROUPS = [
  {id: 'routing', label: 'Routing'},
  {id: 'users', label: 'Users and rights'},
  {id: 'trunks', label: 'Trunks'},
  {id: 'wilma', label: 'Wilma'},
  {id: 'kb', label: 'Knowledge base'},
  {id: 'integrations', label: 'Integrations'},
  {id: 'kite', label: 'Kite'},
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
// and "," written \,). A lookup kind is not one an export carries: refused.
export function parseOnly(spec) {
  return splitList(String(spec))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const at = s.indexOf(':');
      const kind = at < 0 ? s : s.slice(0, at);
      if (!Object.hasOwn(TRANSFER_KINDS, kind))
        throw new UsageError(`Unknown kind: ${kind}. Known: ${EXPORTED.join(', ')}`);
      if (TRANSFER_KINDS[kind].lookup)
        throw new UsageError(
          `${kind} is not exported (a table of the target, where it is found by name or mapped with --map). Kinds: ${EXPORTED.join(', ')}`,
        );
      return {kind, name: at < 0 ? '*' : s.slice(at + 1)};
    });
}

// The families of the dialplan database the dialplans read or write: DB(family/key), DB_EXISTS(…), DB_DELETE(…).
export function dbFamiliesOf(dialplans = []) {
  const text = JSON.stringify(dialplans.map((d) => d.data));
  return [...new Set([...text.matchAll(/DB(?:_EXISTS|_DELETE)?\(([A-Za-z0-9_.:+@-]+)\//g)].map((m) => m[1]))];
}

const boundKeys = (portable) => new Set((portable.bound ?? []).map((b) => keyOf(b.kind, b.name)));

// What an object needs: its references, and for a lookup the target makes of a PBX object (the x-bees service of a
// call group) that object, which the target needs when it lacks the lookup.
function needsOf(portable, key) {
  return (portable.needs?.[key] ?? []).flatMap((n) => {
    const {kind, name} = splitKey(n);
    const from = TRANSFER_KINDS[kind]?.syncedFrom;
    return from ? [n, keyOf(from, name)] : [n];
  });
}

// The keys and everything they need, transitively (only objects of the export).
export function closure(portable, keys) {
  const have = new Set(Object.entries(portable.kinds).flatMap(([k, list]) => list.map((o) => keyOf(k, o.name))));
  const out = new Set();
  const add = (key) => {
    if (out.has(key) || !have.has(key)) return;
    out.add(key);
    for (const n of needsOf(portable, key)) add(n);
  };
  for (const k of keys) add(k);
  return out;
}

// The groups of the picker: objects by group of their kind; bound objects cannot be chosen; users and the cloud not
// ticked unless asked for (--users, --cloud).
export function pickerGroups(portable, {users = false, cloud = false} = {}) {
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
            checked: !b && (kind !== 'users' || users) && (!isCloud(kind) || cloud),
            ...(b ? {disabled: ownBoundReason(b) ? boundText(b) : `bound to the source PBX: ${boundText(b)}`} : {}),
          };
        }),
      ),
  })).filter((g) => g.items.length);
}

// The keys to export: --all (users with --users, the cloud with --cloud), --only (with what they need), else the
// picker.
export async function chooseExport(portable, values, {interactive, select}) {
  const bound = boundKeys(portable);
  const all = Object.entries(portable.kinds).flatMap(([kind, list]) => list.map((o) => keyOf(kind, o.name)));
  let keys;
  if (values.all)
    keys = all.filter((k) => (!k.startsWith('users/') || values.users) && (!isCloud(splitKey(k).kind) || values.cloud));
  else if (values.only) {
    const wanted = parseOnly(values.only);
    keys = all.filter((k) =>
      wanted.some((w) => k.startsWith(`${w.kind}/`) && (w.name === '*' || k === keyOf(w.kind, w.name))),
    );
  } else if (interactive) {
    const chosen = await select({
      title: 'What to export (space: tick, enter: done)',
      groups: pickerGroups(portable, {users: values.users, cloud: values.cloud}),
      requires: (key) => needsOf(portable, key).filter((k) => all.includes(k)),
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
    ...(portable.warnings ? {warnings: portable.warnings.filter(mine)} : {}),
    errors: portable.errors,
    bound: portable.bound,
    external: (portable.external ?? []).filter(mine),
    unresolved: (portable.unresolved ?? []).filter(mine),
    outside: (portable.outside ?? []).filter((o) => keys.has(o.from)),
    needs: pick(portable.needs),
    soft: pick(portable.soft),
  };
}
