// The plan of a config import: every object of the export against the target PBX. new (not there), same, differs
// (there and different: overwritten only when chosen) or blocked (cannot be written, with the reason), with warnings
// that do not stop it (a sound or music on hold class missing on the target, a queue member who is not a user there,
// a value outside the PBX). The target's own objects are made portable the same way, so both sides compare by name.
// Lookup kinds of the target (users, services, bots of the company) only answer references: they are never items.
import {isCloud, TRANSFER_KINDS} from './kinds.mjs';
import {boundText, diffPaths, keyOf, ownBoundReason, refsOf, splitKey, toPortable} from './refs.mjs';

// JSON with sorted keys and numbers as strings: two objects compare equal whatever the order of their fields.
const stable = (v) =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(',')}}`
    : JSON.stringify(typeof v === 'number' ? String(v) : v); // the PBX answers 0 or "0" for the same value

const OUTSIDE_NAMES = {sounds: 'sound', moh: 'music on hold', phonebooks: 'phonebook'};
// The differing paths an item lists.
const PATHS = 5;

// portable: the export ({kinds, soft, outside, external, unresolved, bound}); target: readKinds of the target;
// checks: {serial, host, licenses: {type: free}, sounds, moh, phonebooks} (a list not given is not checked).
export function makePlan(portable, target, {serial, host, licenses, sounds, moh, phonebooks}) {
  const targetPortable = toPortable(target, {serial, host, side: 'target'});
  const theirs = new Map();
  const ids = {};
  const twice = new Set(); // names that two objects of a kind share on the target: ambiguous
  for (const [kind, list] of Object.entries(target)) {
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      const key = keyOf(kind, o.name);
      if (Object.hasOwn(ids, key)) twice.add(key);
      ids[key] = {
        id: o.id,
        ...(o.dn ? {dn: o.dn} : {}),
        name: o.name,
        ...(kind === 'trunks-sip' && typeof o.data?.name === 'string' ? {login: o.data.name} : {}),
        ...(o.version !== undefined ? {version: o.version} : {}),
        ...(o.value !== undefined ? {value: o.value} : {}),
      };
    }
  }
  for (const [kind, list] of Object.entries(targetPortable.kinds))
    for (const o of list) theirs.set(keyOf(kind, o.name), o.data);

  const items = [];
  const bound = new Map();
  for (const b of portable.bound ?? []) if (!bound.has(keyOf(b.kind, b.name))) bound.set(keyOf(b.kind, b.name), b);
  for (const [kind, list] of Object.entries(portable.kinds)) {
    const counts = new Map();
    for (const o of list) counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
    for (const o of list) {
      const key = keyOf(kind, o.name);
      const it = {
        key,
        kind,
        name: o.name,
        data: o.data,
        warnings: [],
        needs: [...new Set(refsOf(o.data).map((r) => keyOf(r.kind, r.name)))].filter((k) => k !== key),
        ...(o.files ? {files: o.files} : {}), // the bytes of its $file markers (skill files)
      };
      if (twice.has(key)) Object.assign(it, {state: 'blocked', reason: `two objects named ${o.name} on ${host}`});
      else if (counts.get(o.name) > 1)
        Object.assign(it, {state: 'blocked', reason: `two objects named ${o.name} in the export`});
      else if (bound.has(key))
        Object.assign(it, {
          state: 'blocked',
          reason: ownBoundReason(bound.get(key)) ? boundText(bound.get(key)) : 'bound to the source PBX',
        });
      else if (target[kind] && !Array.isArray(target[kind]))
        Object.assign(it, {state: 'blocked', reason: `${kind} cannot be read on ${host}: ${target[kind].error}`});
      else if (!theirs.has(key) && TRANSFER_KINDS[kind]?.noCreate)
        // Objects the target must have already (an installed CRM, an owned number): only updated. One a map points at
        // another of the target (mapsMissing: a number) is named as `missing`.
        Object.assign(it, {
          state: 'blocked',
          reason: TRANSFER_KINDS[kind].noCreate.replaceAll('{host}', host).replaceAll('{name}', o.name),
          ...(TRANSFER_KINDS[kind].mapsMissing ? {missing: {kind, name: o.name}} : {}),
        });
      else if (!theirs.has(key)) it.state = 'new';
      else if (kind === 'users' && theirs.get(key).name !== o.data.name)
        Object.assign(it, {state: 'blocked', reason: `extension ${o.name} is ${theirs.get(key).name} on ${host}`});
      else it.state = stable(theirs.get(key)) === stable(o.data) ? 'same' : 'differs';
      if (it.state === 'differs') {
        it.paths = diffPaths(o.data, theirs.get(key), PATHS);
        // Fields the kind's update cannot change: only those differ → blocked; else one warning each.
        const fixed = (TRANSFER_KINDS[kind]?.immutable ?? []).filter(
          (f) => stable(o.data?.[f]) !== stable(theirs.get(key)?.[f]),
        );
        if (fixed.length) {
          const all = diffPaths(o.data, theirs.get(key), Number.POSITIVE_INFINITY);
          if (all.every((p) => fixed.some((f) => p === f || p.startsWith(`${f}.`) || p.startsWith(`${f}[`))))
            Object.assign(it, {
              state: 'blocked',
              reason: `${fixed.join(', ')} cannot be changed on an existing ${TRANSFER_KINDS[kind].label}: remove it on ${host} and re-run`,
            });
          else
            for (const f of fixed)
              it.warnings.push({type: 'immutable', path: f, text: `${f} is not changed by an overwrite`});
        }
        // An agent deployed on the source is deployed again when it is overwritten.
        if (kind === 'wilma-agents' && o.data?.deploy === true) it.deploys = true;
      }
      items.push(it);
    }
  }

  // New users take a license of their type each; beyond the free ones they cannot be made.
  if (licenses) {
    const free = {...licenses};
    for (const it of items.filter((i) => i.kind === 'users' && i.state === 'new')) {
      const type = it.data.licenseType;
      if (!type) continue;
      if ((free[type] ?? 0) <= 0) Object.assign(it, {state: 'blocked', reason: `no free ${type} license on ${host}`});
      else free[type] -= 1;
    }
  }

  // A reference must be in the export (and writable) or on the target; repeated until nothing changes, so a block
  // travels up the chain. A lookup that the target makes of a PBX object (syncedFrom: an x-bees service of a call
  // group) may be missing still when that object is in the export: the reference then needs the object, and waits
  // for the sync (apply skips it until then). A lookup the target lacks is named on the item (`missing`, what a map
  // fixes); one whose name two of its objects share cannot be mapped, nor a cloud kind whose read failed on the
  // target (PBX kinds keep their reasons).
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const it of items) {
      if (it.state === 'blocked') continue;
      for (const need of it.needs) {
        const mine = byKey.get(need);
        const {kind: needKind, name: needName} = splitKey(need);
        const lookup = TRANSFER_KINDS[needKind]?.lookup;
        const block = (why, extra = {}) => {
          Object.assign(it, {state: 'blocked', reason: `needs ${need}: ${why}`, ...extra});
          changed = true;
        };
        if (lookup && twice.has(need)) {
          block(`two ${TRANSFER_KINDS[needKind].label}s named ${needName} on ${host}`);
          break;
        }
        // on the target already, or in the export and writable
        if (Object.hasOwn(ids, need) || (mine && mine.state !== 'blocked')) continue;
        // A cloud kind the target could not read: nothing of it can be checked there, not even a synced one.
        if (!mine && isCloud(needKind) && target[needKind] && !Array.isArray(target[needKind])) {
          block(`${needKind} cannot be read on ${host}: ${target[needKind].error}`);
          break;
        }
        // Only an object this run writes (new, or differs) is synced after it: one that is the same is synced already.
        const from = TRANSFER_KINDS[needKind]?.syncedFrom;
        const source = from && byKey.get(keyOf(from, needName));
        if (source && (source.state === 'new' || source.state === 'differs')) {
          if (!it.needs.includes(source.key)) {
            it.needs.push(source.key);
            changed = true;
          }
          continue;
        }
        // A lookup (a user, a service, a bot of the company) is never written: it is on the target or mapped there.
        if (mine) block(`${need} is blocked: ${mine.reason}`);
        else if (lookup) block(`not on ${host} (map it with --map)`, {missing: {kind: needKind, name: needName}});
        else block(`neither in the export nor on ${host}`);
        break;
      }
    }
  }

  // Warnings, {type, value?, path?, text}: values outside the transfer missing on the target (sound, moh, phonebook;
  // not-checked when the target's list was not read), queue members who are not users there (member), values outside
  // the PBX (external), references to nothing on the source (unresolved), notes of the portable hooks (portable).
  const has = {sounds, moh, phonebooks};
  const TYPE = {sounds: 'sound', moh: 'moh', phonebooks: 'phonebook'};
  const warn = (key, w) => byKey.get(key)?.warnings.push(w);
  for (const x of portable.outside ?? []) {
    const list = has[x.kind];
    const w = {type: TYPE[x.kind], value: x.value, path: x.path};
    if (!list)
      warn(x.from, {
        ...w,
        type: 'not-checked',
        text: `${OUTSIDE_NAMES[x.kind]} ${x.value} (${x.path}) was not checked on ${host}`,
      });
    else if (!list.map(String).includes(String(x.value)))
      warn(x.from, {...w, text: `${OUTSIDE_NAMES[x.kind]} ${x.value} is not on ${host} (${x.path})`});
  }
  for (const [from, keys] of Object.entries(portable.soft ?? {})) {
    for (const k of keys) {
      const mine = byKey.get(k);
      if (Object.hasOwn(ids, k) || (mine && mine.state !== 'blocked')) continue;
      const value = splitKey(k).name;
      if (!Array.isArray(target.users))
        warn(from, {
          type: 'not-checked',
          value,
          text: `the user ${value} was not checked on ${host} (its users were not read)`,
        });
      else warn(from, {type: 'member', value, text: `${value} is not a user on ${host} (nor a user of the export)`});
    }
  }
  for (const x of portable.external ?? [])
    warn(keyOf(x.kind, x.name), {
      type: 'external',
      value: x.what,
      path: x.path,
      text: `${x.path} is outside the PBX (${x.what}), kept as it is: check it works for ${host}`,
    });
  for (const x of portable.warnings ?? []) warn(keyOf(x.kind, x.name), {type: 'portable', path: x.path, text: x.text});
  for (const x of portable.unresolved ?? [])
    warn(keyOf(x.kind, x.name), {
      type: 'unresolved',
      value: x.value,
      path: x.path,
      text: `${x.path} = ${x.value} pointed at nothing on the source, kept as it is`,
    });

  const counts = {new: 0, same: 0, differs: 0, blocked: 0};
  for (const it of items) counts[it.state] += 1;
  const welcomeMails = items.filter((i) => i.kind === 'users' && i.state === 'new' && i.data.email).length;
  return {host, items, counts, welcomeMails, target: ids};
}
