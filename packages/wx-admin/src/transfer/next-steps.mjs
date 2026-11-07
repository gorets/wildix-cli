// What is left to do on the target after a config import (or, with --dry-run, what will be): one step per thing to
// do, {what, why, objects: [{kind, name, where?}], wms, command?, blocking}; repeated objects folded into one step,
// steps that keep something transferred from working first. Never a secret: steps are made from names and reasons.
import {splitKey} from './refs.mjs';

// Where things are in WMS. Confirmed in the Wildix admin guide: Trunks, Dialplan → IVR, Dialplan → Call groups,
// PBX → Integrations. The others are the menus of WMS 7 as known, not checked against its documentation.
export const WMS = {
  trunks: 'WMS → Trunks',
  users: 'WMS → Users',
  licenses: 'WMS → Settings → PBX → License (unchecked)',
  acl: 'WMS → Users → Permissions (unchecked)',
  sounds: 'WMS → Dialplan → Sounds (unchecked)',
  moh: 'WMS → Dialplan → Sounds, the music on hold folders (unchecked)',
  phonebooks: 'WMS → Users → Phonebooks (unchecked)',
  queues: 'WMS → Dialplan → Call groups',
  dialplans: 'WMS → Dialplan → Dialplan rules (unchecked)',
  devices: 'WMS → Devices',
  settings: 'WMS → Settings → PBX (unchecked)',
};

const MAX = 5;
const fold = (names) =>
  names.length <= MAX ? names.join(', ') : `${names.slice(0, MAX).join(', ')} … and ${names.length - MAX} more`;
const objectOf = (key, where) => ({...splitKey(key), ...(where ? {where} : {})});

// One argument for a POSIX shell: as it is when it is plain, else in single quotes. Names and values come from the
// PBX or the folder, so every one that goes into a command is quoted.
export const shellArg = (s) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`;
// The value of --only for these keys: kind:name, with \ and , in names escaped (parseOnly reads them back).
export const onlyArg = (keys) =>
  shellArg(
    keys
      .map((k) => {
        const {kind, name} = splitKey(k);
        return `${kind}:${name.replace(/\\/g, '\\\\').replace(/,/g, '\\,')}`;
      })
      .join(','),
  );

export function nextSteps({plan, results, host, rerun}) {
  const cmd = (rest) => `wx-admin --pbx ${shellArg(host)} ${rest}`;
  const steps = [];
  const resultOf = new Map(results.map((r) => [r.key, r]));
  const done = (kind, actions = ['create', 'overwrite']) =>
    results.filter((r) => r.key.startsWith(`${kind}/`) && actions.includes(r.action)).map((r) => r.key);

  // What was not written, by what caused it: a password not given, an object that failed, a reference missing on
  // the target. Each group is finished by the same import for these objects only, overwriting (an ACL group or
  // dialplan made bare in the first pass is on the target, empty, until then).
  const byKey = new Map(results.map((r) => [r.key, r]));
  const rootOf = (r) => {
    const seen = new Set();
    let x = r;
    while (x.action === 'skip' && byKey.has(x.because) && !seen.has(x.key)) {
      seen.add(x.key);
      x = byKey.get(x.because);
    }
    return x;
  };
  const left = results.filter((r) => r.action === 'skip' || r.action === 'failed');
  const groupOf = (r) => {
    const root = rootOf(r);
    if (root.action === 'failed') return 'failed';
    return /^no password/.test(root.because ?? '') ? 'password' : 'missing';
  };
  const finish = (list) => `${rerun} --only ${onlyArg(list.map((r) => r.key))} --overwrite`;
  const empty = (list) => {
    const keys = list.filter((r) => r.bare).map((r) => r.key);
    return keys.length ? `; ${fold(keys)} ${keys.length === 1 ? 'is' : 'are'} on ${host} empty until then` : '';
  };
  const pw = left.filter((r) => groupOf(r) === 'password');
  if (pw.length) {
    const trunks = pw.filter((r) => /^no password/.test(r.because ?? '')).map((r) => splitKey(r.key).name);
    const also = pw.filter((r) => !/^no password/.test(r.because ?? ''));
    steps.push({
      what: `${trunks.length === 1 ? `Set the password of the trunk ${trunks[0]}` : `Set the password of ${trunks.length} trunks: ${fold(trunks)}`}${also.length ? `, then write what uses ${trunks.length === 1 ? 'it' : 'them'}: ${fold(also.map((r) => r.key))}` : ''}${empty(pw)}`,
      why: 'Passwords are never exported; none was given for these, so they were not written (nor what uses them). The command asks for them in a terminal; else add --secrets FILE.',
      objects: pw.map((r) => objectOf(r.key)),
      wms: WMS.trunks,
      command: finish(pw),
      blocking: true,
    });
  }
  const failed = left.filter((r) => groupOf(r) === 'failed');
  if (failed.length) {
    const roots = failed.filter((r) => r.action === 'failed');
    const also = failed.filter((r) => r.action !== 'failed');
    steps.push({
      what: `${roots.length} object${roots.length === 1 ? '' : 's'} failed: ${fold(roots.map((r) => r.key))}${also.length ? `; skipped with them: ${fold(also.map((r) => r.key))}` : ''}${empty(failed)}`,
      why: roots.map((r) => `${r.key}: ${r.error}`).join('; '),
      objects: failed.map((r) => objectOf(r.key)),
      wms: '',
      command: finish(failed),
      blocking: true,
    });
  }
  const missing = left.filter((r) => groupOf(r) === 'missing');
  if (missing.length) {
    steps.push({
      what: `${missing.length} object${missing.length === 1 ? ' was' : 's were'} skipped: ${fold(missing.map((r) => r.key))}${empty(missing)}`,
      why: missing.map((r) => `${r.key}: needs ${rootOf(r).because}`).join('; '),
      objects: missing.map((r) => objectOf(r.key)),
      wms: '',
      command: finish(missing),
      blocking: true,
    });
  }

  // Users that could not be made: licenses, taken extensions.
  const users = plan.items.filter(
    (i) => i.kind === 'users' && i.state === 'blocked' && /license|extension/.test(i.reason ?? ''),
  );
  if (users.length) {
    steps.push({
      what: `Add licenses or free the extensions, then run the same import again: users ${fold(users.map((i) => i.name))}`,
      why: users.map((i) => `${i.name}: ${i.reason}`).join('; '),
      objects: users.map((i) => objectOf(i.key)),
      wms: WMS.licenses,
      command: rerun,
      blocking: true,
    });
  }

  // Other objects the plan could not write.
  const other = plan.items.filter((i) => i.state === 'blocked' && !users.includes(i));
  if (other.length) {
    steps.push({
      what: `Not written: ${fold(other.map((i) => i.key))}`,
      why: other.map((i) => `${i.key}: ${i.reason}`).join('; '),
      objects: other.map((i) => objectOf(i.key)),
      wms: '',
      command: rerun,
      blocking: true,
    });
  }

  // Warnings of the plan, grouped by what they are about.
  const groups = new Map();
  for (const item of plan.items) {
    if (item.state === 'blocked' || resultOf.get(item.key)?.action === 'failed') continue;
    for (const w of item.warnings ?? []) {
      const id = `${w.type}:${w.value}`;
      if (!groups.has(id)) groups.set(id, {w, objects: []});
      groups.get(id).objects.push(objectOf(item.key, w.path));
    }
  }
  for (const {w, objects} of groups.values()) {
    const users = fold(objects.map((o) => `${o.kind}/${o.name}`));
    const step = {
      sound: {
        what: `Upload the sound ${w.value} used by ${users}`,
        why: `Sounds are not transferred and ${host} has no ${w.value}.`,
        wms: WMS.sounds,
        command: cmd(`sound upload <file> --name ${shellArg(w.value)}`),
        blocking: true,
      },
      moh: {
        what: `Create the music on hold class ${w.value} used by ${users}`,
        why: `Music on hold is not transferred and ${host} has no class ${w.value}.`,
        wms: WMS.moh,
        command: cmd('sound list'),
        blocking: true,
      },
      phonebook: {
        what: `Create the phonebook ${w.value} used by ${users}, then point the rule at it`,
        why: `Phonebooks are not transferred and ${host} has no phonebook ${w.value}.`,
        wms: WMS.phonebooks,
        command: cmd('phonebook create <name>'),
        blocking: true,
      },
      'not-checked': {
        what: `Check that ${w.value} (used by ${users}) is on ${host}`,
        why: 'It could not be checked with this access.',
        wms: WMS.sounds,
        command: cmd('sound list'),
        blocking: false,
      },
      member: {
        what: `Create the user ${w.value} or take it out of ${users}`,
        why: `${w.value} is a member there but not a user on ${host}.`,
        wms: WMS.queues,
        command: cmd(`queue update ${shellArg(objects[0].name)} --member <ext>... --yes`),
        blocking: false,
      },
      external: {
        what: `Check that the ${w.value} of ${users} works on ${host}`,
        why: 'It is outside the PBX (an object of the company in the cloud, or another PBX) and was kept as it is.',
        wms: WMS.dialplans,
        blocking: false,
      },
      unresolved: {
        what: `Check by hand: ${w.value} in ${users}${objects[0].where ? ` (${objects[0].where})` : ''}`,
        why: 'It pointed at nothing on the source PBX (a stale id, or a value that is not a reference) and was kept as it is.',
        wms: WMS.dialplans,
        blocking: false,
      },
    }[w.type];
    if (step) steps.push({objects, ...step});
  }

  // Checks after what was written.
  const trunks = done('trunks-sip', ['create']);
  if (trunks.length) {
    const names = trunks.map((k) => splitKey(k).name);
    steps.push({
      what:
        names.length === 1
          ? `Check that the trunk ${names[0]} registers`
          : `Check that ${names.length} trunks register: ${fold(names)}`,
      why: 'A trunk works only once its carrier accepts the registration from this PBX.',
      objects: trunks.map((k) => objectOf(k)),
      wms: WMS.trunks,
      command: cmd('trunk list'),
      blocking: false,
    });
  }
  const madeUsers = done('users', ['create']);
  if (madeUsers.length) {
    steps.push({
      what: `Tell the ${madeUsers.length} new user${madeUsers.length === 1 ? '' : 's'} how to log in: ${fold(madeUsers.map((k) => splitKey(k).name))}`,
      why: `The PBX gave them passwords of its own${plan.welcomeMails ? `; ${plan.welcomeMails} of them got the welcome e-mail of the PBX` : ''}.`,
      objects: madeUsers.map((k) => objectOf(k)),
      wms: WMS.users,
      command: cmd('user list'),
      blocking: false,
    });
  }
  const acl = done('acl-groups');
  if (acl.length) {
    steps.push({
      what: `Check who may administer ${host}: ACL groups were written (${fold(acl.map((k) => splitKey(k).name))})`,
      why: 'Their admin rules now point at this PBX.',
      objects: acl.map((k) => objectOf(k)),
      wms: WMS.acl,
      command: cmd('acl groups'),
      blocking: false,
    });
  }
  steps.push({
    what: 'Set up by hand what a transfer never carries: devices, PSTN and FXO trunks, system settings (SMTP, NTP, features, trusted IPs)',
    why: 'They are bound to the hardware or to the PBX itself; compare them with the source PBX.',
    objects: [],
    wms: `${WMS.devices}; ${WMS.settings}`,
    command: `${cmd('device list')}; ${cmd('system smtp')} (and the same with --pbx of the source)`,
    blocking: false,
  });

  return [...steps.filter((s) => s.blocking), ...steps.filter((s) => !s.blocking)];
}
