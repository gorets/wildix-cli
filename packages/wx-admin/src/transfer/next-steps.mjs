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

export function nextSteps({plan, results, host, rerun}) {
  const cmd = (rest) => `wx-admin --pbx ${host} ${rest}`;
  const steps = [];
  const resultOf = new Map(results.map((r) => [r.key, r]));
  const done = (kind, actions = ['create', 'overwrite']) =>
    results.filter((r) => r.key.startsWith(`${kind}/`) && actions.includes(r.action)).map((r) => r.key);

  // Trunks skipped for their password.
  const noPassword = results.filter((r) => r.action === 'skip' && /^no password/.test(r.because ?? ''));
  if (noPassword.length) {
    const names = noPassword.map((r) => splitKey(r.key).name);
    steps.push({
      what:
        names.length === 1
          ? `Set the password of the trunk ${names[0]} and write it again`
          : `Set the password of ${names.length} trunks: ${fold(names)}`,
      why: 'Passwords are never exported; none was given for these, so they were not written (nor what uses them).',
      objects: noPassword.map((r) => objectOf(r.key)),
      wms: WMS.trunks,
      command: `${rerun} (it asks for the passwords), or after making them: ${cmd(`trunk update ${names.length === 1 ? names[0] : '<trunk>'} --secret --yes`)}`,
      blocking: true,
    });
  }

  // Objects that failed, and what was skipped with them.
  const failed = results.filter((r) => r.action === 'failed');
  if (failed.length) {
    const skipped = results.filter(
      (r) => r.action === 'skip' && failed.some((f) => f.key === r.because || r.because === f.key),
    );
    const chain = results.filter(
      (r) => r.action === 'skip' && !/^no password/.test(r.because ?? '') && !skipped.includes(r),
    );
    const also = [...skipped, ...chain];
    steps.push({
      what: `${failed.length} object${failed.length === 1 ? '' : 's'} failed: ${fold(failed.map((r) => r.key))}${also.length ? `; skipped with them: ${fold(also.map((r) => r.key))}` : ''}`,
      why: failed.map((r) => `${r.key}: ${r.error}`).join('; '),
      objects: [...failed, ...also].map((r) => objectOf(r.key)),
      wms: '',
      // Again for these only, overwriting: a group or dialplan made bare before it failed is there now.
      command: `${rerun} --only ${[...failed, ...also].map((r) => r.key.replace('/', ':')).join(',')} --overwrite`,
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
        command: cmd(`sound upload <file of ${w.value}>`),
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
        command: cmd(`queue update ${objects[0].name} --member <ext>... --yes`),
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
