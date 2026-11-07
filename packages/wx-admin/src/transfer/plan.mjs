// The plan of a config import: every object of the export against the target PBX. new (not there), same, differs
// (there and different: overwritten only when chosen) or blocked (cannot be written, with the reason), with warnings
// that do not stop it (a sound or music on hold class missing on the target, a queue member who is not a user there,
// a value outside the PBX). The target's own objects are made portable the same way, so both sides compare by name.
import {keyOf, refsOf, splitKey, toPortable} from './refs.mjs';

// JSON with sorted keys: two objects compare equal whatever the order of their fields.
const stable = (v) =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(',')}}`
    : JSON.stringify(v);

const OUTSIDE_NAMES = {sounds: 'sound', moh: 'music on hold', phonebooks: 'phonebook'};

// portable: the export ({kinds, soft, outside, external, unresolved, bound}); target: readKinds of the target;
// checks: {serial, host, licenses: {type: free}, sounds, moh, phonebooks} (a list not given is not checked).
export function makePlan(portable, target, {serial, host, licenses, sounds, moh, phonebooks}) {
  const targetPortable = toPortable(target, {serial, host});
  const theirs = new Map();
  const ids = {};
  for (const [kind, list] of Object.entries(target)) {
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      const key = keyOf(kind, o.name);
      ids[key] = {id: o.id, ...(o.dn ? {dn: o.dn} : {}), name: o.name};
    }
  }
  for (const [kind, list] of Object.entries(targetPortable.kinds))
    for (const o of list) theirs.set(keyOf(kind, o.name), o.data);

  const items = [];
  const bound = new Set((portable.bound ?? []).map((b) => keyOf(b.kind, b.name)));
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
      };
      if (counts.get(o.name) > 1)
        Object.assign(it, {state: 'blocked', reason: `two objects named ${o.name} in the export`});
      else if (bound.has(key)) Object.assign(it, {state: 'blocked', reason: 'bound to the source PBX'});
      else if (target[kind] && !Array.isArray(target[kind]))
        Object.assign(it, {state: 'blocked', reason: `${kind} cannot be read on ${host}: ${target[kind].error}`});
      else if (!theirs.has(key)) it.state = 'new';
      else if (kind === 'users' && theirs.get(key).name !== o.data.name)
        Object.assign(it, {state: 'blocked', reason: `extension ${o.name} is ${theirs.get(key).name} on ${host}`});
      else it.state = stable(theirs.get(key)) === stable(o.data) ? 'same' : 'differs';
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
  // travels up the chain.
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const it of items) {
      if (it.state === 'blocked') continue;
      for (const need of it.needs) {
        const mine = byKey.get(need);
        // on the target already, or in the export and writable
        if (Object.hasOwn(ids, need) || (mine && mine.state !== 'blocked')) continue;
        const why = mine ? `${need} is blocked: ${mine.reason}` : `neither in the export nor on ${host}`;
        Object.assign(it, {state: 'blocked', reason: `needs ${need}: ${why}`});
        changed = true;
        break;
      }
    }
  }

  // Warnings, {type, value, path?, text}: values outside the transfer missing on the target (sound, moh, phonebook;
  // not-checked when the target's list was not read), queue members who are not users there (member), values outside
  // the PBX (external), references to nothing on the source (unresolved).
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
      warn(from, {type: 'member', value, text: `${value} is not a user on ${host} (nor a user of the export)`});
    }
  }
  for (const x of portable.external ?? [])
    warn(keyOf(x.kind, x.name), {
      type: 'external',
      value: x.what,
      path: x.path,
      text: `${x.path} is outside the PBX (${x.what}), kept as it is: check it works for ${host}`,
    });
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
