// What is left to do on the target after a config import (or, with --dry-run, what will be): one step per thing to
// do, {what, why, objects: [{kind, name, where?}], wms, command?, blocking}; repeated objects folded into one step,
// steps that keep something transferred from working first. Never a secret: steps are made from names and reasons.
import {SECRET_SKIP} from './apply.mjs';
import {isCloud, TRANSFER_KINDS} from './kinds.mjs';
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
// Plan reasons of the cloud (Ruling 34): an integration the target has not installed.
const NO_TOKEN = 'configuration not changed: no API token given';
const NOT_INSTALLED = /^not installed on /;
const PLACEHOLDER = '<name on target>';
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

// rerun: the command that runs the same import again; mapFromStdin: its map was read from stdin (rerun says --map
// FILE, and each step that runs it asks for the file again).
export function nextSteps({plan, results, host, rerun, mapFromStdin = false}) {
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
  // A secret not given skips an object (by its kind's policy, or a password of the PBX): the PBX ones (trunks) keep
  // their step, those of the cloud have their own. An x-bees service not synced yet (apply's syncWait): wait.
  const groupOf = (r) => {
    const root = rootOf(r);
    if (root.action === 'failed') return root.stage ? 'stage' : 'failed';
    if (root.action === 'skip' && root.syncWait) return 'sync';
    if (!SECRET_SKIP.test(root.because ?? '')) return 'missing';
    return isCloud(splitKey(root.key).kind) ? 'secrets' : 'password';
  };
  const finish = (list) => `${rerun} --only ${onlyArg(list.map((r) => r.key))} --overwrite`;
  const empty = (list) => {
    const keys = list.filter((r) => r.bare).map((r) => r.key);
    return keys.length ? `; ${fold(keys)} ${keys.length === 1 ? 'is' : 'are'} on ${host} empty until then` : '';
  };
  const pw = left.filter((r) => groupOf(r) === 'password');
  if (pw.length) {
    const trunks = pw.filter((r) => SECRET_SKIP.test(r.because ?? '')).map((r) => splitKey(r.key).name);
    const also = pw.filter((r) => !SECRET_SKIP.test(r.because ?? ''));
    steps.push({
      what: `${trunks.length === 1 ? `Set the password of the trunk ${trunks[0]}` : `Set the password of ${trunks.length} trunks: ${fold(trunks)}`}${also.length ? `, then write what uses ${trunks.length === 1 ? 'it' : 'them'}: ${fold(also.map((r) => r.key))}` : ''}${empty(pw)}`,
      why: 'Passwords are never exported; none was given for these, so they were not written (nor what uses them). The command asks for them in a terminal; else add --secrets FILE.',
      objects: pw.map((r) => objectOf(r.key)),
      wms: WMS.trunks,
      command: finish(pw),
      blocking: true,
    });
  }
  const secret = left.filter((r) => groupOf(r) === 'secrets');
  if (secret.length) {
    const roots = secret.filter((r) => SECRET_SKIP.test(r.because ?? ''));
    const also = secret.filter((r) => !SECRET_SKIP.test(r.because ?? ''));
    const pathOf = (r) => r.because.replace(SECRET_SKIP, '');
    const one = roots.length === 1 && splitKey(roots[0].key);
    steps.push({
      what: `${one ? `Give the secret ${pathOf(roots[0])} of the ${TRANSFER_KINDS[one.kind]?.label ?? one.kind} ${one.name}` : `Give the secrets of ${roots.length} objects: ${fold(roots.map((r) => r.key))}`}${also.length ? `, then write what uses ${roots.length === 1 ? 'it' : 'them'}: ${fold(also.map((r) => r.key))}` : ''}${empty(secret)}`,
      why: `Secret values are never exported; none was given for these, so they were not written (nor what uses them): ${roots.map((r) => `${r.key}: ${pathOf(r)}`).join('; ')}. The command asks for them in a terminal; else give them in --secrets FILE.`,
      objects: secret.map((r) => objectOf(r.key)),
      wms: '',
      command: `${finish(secret)} --secrets FILE`,
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
  const staged = left.filter((r) => groupOf(r) === 'stage');
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
  const crm = plan.items.filter(
    (i) => i.state === 'blocked' && i.kind === 'integration-crm' && NOT_INSTALLED.test(i.reason ?? ''),
  );
  // What the target lacks and a map fixes: the plan names it on the item (a lookup, a number or sender).
  const lookups = plan.items.filter((i) => i.state === 'blocked' && i.missing);
  const other = plan.items.filter(
    (i) => i.state === 'blocked' && !users.includes(i) && !crm.includes(i) && !lookups.includes(i),
  );
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
      command: cmd('acl list'),
      blocking: false,
    });
  }

  // The cloud groups (after the PBX ones): secrets, authorization, waiting for a sync, mapping, failed by stage.
  // Names only: a secret value is never in results or plan, so never in a step. Every command names the target PBX
  // (cmd): in a copy the default PBX may be the source.
  const named = (key) => splitKey(key).name;
  const made = results.filter((r) => r.action === 'create' || r.action === 'overwrite');
  for (const r of results.filter((r) => r.pending)) {
    steps.push({
      what: `Give the Wilma secret ${named(r.key)} its value`,
      why: 'Its value is never exported and none was given, so the secret was written without one.',
      objects: [objectOf(r.key)],
      wms: '',
      command: cmd(`wilma secret rotate ${shellArg(named(r.key))}`),
      blocking: true,
    });
  }
  for (const r of results.filter((r) => r.unconfigured)) {
    steps.push({
      what: `Configure the KB source ${named(r.key)}`,
      why: 'Its credentials are never exported, so the source was created without a configuration.',
      objects: [objectOf(r.key)],
      wms: '',
      command: cmd(`kb source configure ${shellArg(named(r.key))}`),
      blocking: true,
    });
  }
  for (const r of results.filter((r) => r.notes?.includes(NO_TOKEN))) {
    steps.push({
      what: `Give the API token of the KB source ${named(r.key)}`,
      why: `${NO_TOKEN}; the source on ${host} keeps its own. Give config.confluence.apiKey in --secrets, or run ${cmd(`kb source configure ${shellArg(named(r.key))}`)}.`,
      objects: [objectOf(r.key)],
      wms: '',
      command: `${rerun} --only ${onlyArg([r.key])} --overwrite --secrets FILE`,
      blocking: true,
    });
  }
  for (const r of results.filter((r) => r.generated)) {
    steps.push({
      what: `Give the new signing secret of ${named(r.key)} to its receiver (shown once in the output)`,
      why: 'The secret was generated for this webhook; it is not stored by wx-admin and cannot be shown again.',
      objects: [objectOf(r.key)],
      wms: '',
      blocking: true,
    });
  }
  for (const r of made.filter((r) => r.action === 'create' && r.key.startsWith('wilma-connections/'))) {
    steps.push({
      what: `authorize ${named(r.key)} in the WIM console`,
      why: 'A shared connection is made by the company, not by this tool: its owner has to sign in to the provider.',
      objects: [objectOf(r.key)],
      wms: '',
      blocking: true,
    });
  }
  // A source created and configured here does not sync by itself (a website source's schedule is DISABLED).
  for (const r of made.filter((r) => r.action === 'create' && r.key.startsWith('kb-sources/') && !r.unconfigured)) {
    steps.push({
      what: `Start the first sync of the knowledge-base source ${named(r.key)}`,
      why: 'A new source does not sync by itself: until it does, it has no documents and its knowledge bases answer nothing.',
      objects: [objectOf(r.key)],
      wms: '',
      command: cmd(`kb source sync ${shellArg(named(r.key))}`),
      blocking: true,
    });
  }
  if (crm.length) {
    steps.push({
      what: `Install the CRM integration on ${host}: ${fold(crm.map((i) => i.name))}`,
      why: crm.map((i) => `${i.name}: ${i.reason}`).join('; '),
      objects: crm.map((i) => objectOf(i.key)),
      wms: '',
      command: `${rerun} --only ${onlyArg(crm.map((i) => i.key))}`,
      blocking: true,
    });
  }
  const synced = left.filter((r) => groupOf(r) === 'sync');
  if (synced.length) {
    steps.push({
      what: `Wait for x-bees to sync, then run the import again: ${fold(synced.map((r) => r.key))}`,
      why: synced.map((r) => `${r.key}: ${rootOf(r).because}`).join('; '),
      objects: synced.map((r) => objectOf(r.key)),
      wms: '',
      command: `${rerun} --only ${onlyArg(synced.map((r) => r.key))}`,
      blocking: true,
    });
  }
  if (lookups.length) {
    const fragment = {};
    const add = (kind, name) => {
      fragment[kind] ??= {};
      fragment[kind][name] = PLACEHOLDER;
    };
    for (const i of lookups) add(i.missing.kind, i.missing.name);
    const json = JSON.stringify(fragment);
    steps.push({
      what: `Map what ${host} lacks, then run the import again with --map: put ${json} in the map file and replace ${PLACEHOLDER} with the name on ${host}`,
      why: lookups.map((i) => `${i.key}: ${i.reason}`).join('; '),
      objects: lookups.map((i) => objectOf(i.key)),
      wms: '',
      command: / --map /.test(rerun) ? rerun : `${rerun} --map map.json`,
      blocking: true,
    });
  }
  if (staged.length) {
    const roots = staged.filter((r) => r.action === 'failed');
    const also = staged.filter((r) => r.action !== 'failed');
    steps.push({
      what: `${roots.length} cloud object${roots.length === 1 ? '' : 's'} failed part way: ${fold(roots.map((r) => `${r.key} (at ${r.stage})`))}${also.length ? `; skipped with them: ${fold(also.map((r) => r.key))}` : ''}`,
      why: roots.map((r) => `${r.key}: ${r.error}`).join('; '),
      objects: staged.map((r) => objectOf(r.key)),
      wms: '',
      command: finish(staged),
      blocking: true,
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

  if (mapFromStdin)
    for (const s of steps)
      if (s.command?.startsWith(rerun))
        s.why = `${s.why} Give the map file again (--map FILE): it was read from stdin.`;
  return [...steps.filter((s) => s.blocking), ...steps.filter((s) => !s.blocking)];
}
