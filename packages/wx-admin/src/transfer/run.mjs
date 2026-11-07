// A config import, from a folder or (copy) from another PBX read in memory: plan against the target, choose, ask the
// passwords, confirm, write, say what is left to do; everything in the log. Shared by `config import` and
// `config copy`.
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {UsageError} from 'wldx-core/errors';
import {clean} from 'wldx-core/format';
import {readSecret} from 'wldx-core/secret';
import {select} from 'wldx-core/select';
import {readSerial} from '../pbx.mjs';
import {applyPlan} from './apply.mjs';
import {TRANSFER_KINDS, readKinds} from './kinds.mjs';
import {openLog} from './log.mjs';
import {nextSteps} from './next-steps.mjs';
import {makePlan} from './plan.mjs';
import {keyOf, refsOf} from './refs.mjs';
import {GROUPS, parseOnly} from './selection.mjs';

const listOf = (r) => (Array.isArray(r) ? r : (r?.records ?? []));
const interactive = (ctx) => Boolean(ctx.stdin?.isTTY && ctx.stderr?.isTTY);
const tryRead = async (fn) => {
  try {
    return await fn();
  } catch {
    return undefined;
  }
};

// What the plan checks on the target besides its objects: free licenses per type, sounds, music on hold classes,
// phonebooks (a list that cannot be read is undefined: not checked).
export async function targetChecks(client) {
  const licenses = await tryRead(async () => {
    const l = await client.call('GET', '/PBX/settings/license/', undefined, {scope: 'pbx'});
    const total = l?.limitations?.licenseTypes ?? {};
    const used = l?.licenseUsage ?? {};
    return Object.fromEntries(Object.keys(total).map((t) => [t, Number(total[t] ?? 0) - Number(used[t] ?? 0)]));
  });
  const entries = async (dir) =>
    listOf(await client.call('GET', dir ? `/Sounds/${dir}/` : '/Sounds/', undefined, {scope: 'sounds'})).filter(
      (e) => e.name !== '..',
    );
  const moh = await tryRead(async () => (await entries('MusicOnHold')).filter((e) => e.isDir).map((e) => e.name));
  const sounds = await tryRead(async () => {
    const names = [];
    const add = (e) => {
      const bare = (s) => String(s).replace(/\.[A-Za-z0-9]{2,4}$/, '');
      names.push(bare(e.name), bare(e.path ?? e.name));
    };
    for (const e of await entries('')) {
      if (!e.isDir) add(e);
      else if (e.name !== 'MusicOnHold') for (const f of await entries(e.name)) if (!f.isDir) add(f);
    }
    return names;
  });
  const phonebooks = await tryRead(async () =>
    listOf(await client.call('GET', '/Phonebooks/?count=1000', undefined, {scope: 'phonebooks'})).flatMap((p) => [
      String(p.id),
      String(p.name),
    ]),
  );
  return {licenses, sounds, moh, phonebooks};
}

// The kinds to read on the target: those of the export and those its references point at.
function kindsToRead(portable) {
  const kinds = new Set(Object.keys(portable.kinds));
  // queue members and users named by dialplans are checked against the target's users
  if (Object.values(portable.soft ?? {}).some((keys) => keys.some((k) => k.startsWith('users/')))) kinds.add('users');
  for (const list of Object.values(portable.kinds))
    for (const o of list) for (const r of refsOf(o.data)) if (Object.hasOwn(TRANSFER_KINDS, r.kind)) kinds.add(r.kind);
  return Object.keys(TRANSFER_KINDS).filter((k) => kinds.has(k));
}

// The paths of the secrets an object needs.
export function secretsOf(data, path = '', out = []) {
  if (!data || typeof data !== 'object') return out;
  if (!Array.isArray(data) && typeof data.$secret === 'string') {
    out.push(data.$secret);
    return out;
  }
  for (const [k, v] of Array.isArray(data) ? data.entries() : Object.entries(data))
    secretsOf(v, Array.isArray(data) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
  return out;
}

// --secrets FILE: {"<kind>/<name>": {"<path>": "…"}} or {"<kind>": {"<name>": {"<path>": "…"}}}; "password" fills
// every secret path that names a secret or a password.
function secretsFrom(file, items) {
  const flat = {};
  for (const [k, v] of Object.entries(file ?? {})) {
    if (k.includes('/')) flat[k] = v;
    else for (const [name, s] of Object.entries(v ?? {})) flat[keyOf(k, name)] = s;
  }
  const out = {};
  for (const it of items) {
    const given = flat[it.key];
    if (!given) continue;
    out[it.key] = {};
    for (const p of secretsOf(it.data)) {
      if (typeof given[p] === 'string') out[it.key][p] = given[p];
      else if (typeof given.password === 'string' && /secret|password/i.test(p.split('.').pop()))
        out[it.key][p] = given.password;
    }
  }
  return out;
}

// --secrets FILE (or - for stdin): a file of passwords by design, so not refused for looking like one (the checks
// of files to send are for files sent elsewhere; these values go only to the chosen objects on the target). A parse
// error never repeats the content.
async function readSecretsFile(ctx, from) {
  let text;
  if (from === '-') {
    const chunks = [];
    for await (const c of ctx.stdin) chunks.push(Buffer.from(c));
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    try {
      text = fs.readFileSync(path.resolve(ctx.cwd ?? process.cwd(), from), 'utf8');
    } catch (e) {
      throw new UsageError(`--secrets ${from}: ${e.code === 'ENOENT' ? 'no such file' : e.code}`);
    }
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new UsageError(`--secrets ${from === '-' ? 'stdin' : from} is not a JSON object`);
  }
}

// What ticking an object in the picker ticks with it: the new objects it needs. One that differs is on the target
// already (the reference resolves to it); it is overwritten only when ticked itself.
export function pickerRequires(plan) {
  const state = new Map(plan.items.map((i) => [i.key, i.state]));
  const needs = new Map(plan.items.map((i) => [i.key, i.needs]));
  return (k) => (needs.get(k) ?? []).filter((n) => state.get(n) === 'new');
}

// The keys to write: the picker, --all or --only (with what they need that is new or differs).
async function choose(ctx, plan, values) {
  const writable = (i) => i.state === 'new' || (i.state === 'differs' && values.overwrite);
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const withNeeds = (keys) => {
    const out = new Set();
    const add = (k) => {
      const it = byKey.get(k);
      if (!it || out.has(k) || it.state === 'blocked' || it.state === 'same') return;
      out.add(k);
      for (const n of it.needs) add(n);
    };
    for (const k of keys) add(k);
    return out;
  };
  if (values.all) return new Set(plan.items.filter(writable).map((i) => i.key));
  if (values.only) {
    const wanted = parseOnly(values.only);
    const keys = plan.items
      .filter((i) => wanted.some((w) => w.kind === i.kind && (w.name === '*' || w.name === i.name)))
      .filter(writable)
      .map((i) => i.key);
    return new Set([...withNeeds(keys)].filter((k) => writable(byKey.get(k))));
  }
  if (!interactive(ctx))
    throw new UsageError('Without a terminal, choose what to import with --all or --only KIND:NAME,… (and --yes)');
  const groups = GROUPS.map((g) => ({
    ...g,
    items: plan.items
      .filter((i) => TRANSFER_KINDS[i.kind].group === g.id && i.state !== 'same')
      .map((i) => ({
        id: i.key,
        label: `${TRANSFER_KINDS[i.kind].label} ${i.name}`,
        badge: i.state === 'differs' ? 'differs: overwrite' : i.state,
        note: i.warnings.length ? i.warnings.map((w) => w.text).join('; ') : undefined,
        checked: i.state === 'new',
        ...(i.state === 'blocked' ? {disabled: i.reason} : {}),
      })),
  })).filter((g) => g.items.length);
  if (!groups.length) return new Set();
  return select(ctx, {
    title: `What to write to ${plan.host} (new ones are ticked; ticking one that differs overwrites it)`,
    groups,
    requires: pickerRequires(plan),
  });
}

async function confirm(ctx, question) {
  const rl = createInterface({input: ctx.stdin, output: ctx.stderr, terminal: false});
  try {
    ctx.stderr.write(question);
    const line = await rl[Symbol.asyncIterator]().next();
    return /^y(es)?$/i.test(String(line.value ?? '').trim());
  } finally {
    rl.close();
  }
}

// from: what the export comes from (a folder or a PBX), for the log and the output; rerun: the command to run the
// same import again.
export async function runImport(ctx, {portable, from, client, values, rerun}) {
  const host = client.target.host;
  const serial = await readSerial(client);
  const families = [...new Set((portable.kinds['dialplan-db'] ?? []).map((o) => o.name.split('/')[0]))];
  const target = await readKinds(client, kindsToRead(portable), {dbFamilies: families, info: ctx.info});
  const plan = makePlan(portable, target, {serial, host, ...(await targetChecks(client))});

  const log = openLog(ctx, {dir: values.log, host, now: ctx.clock()});
  const results = [];
  try {
    log.line(`wx-admin config import${values['dry-run'] ? ' (DRY RUN: nothing is written)' : ''}`);
    log.line(
      `from ${from} to ${host}; access: ${client.target.auth ?? 'x-bees login'}${ctx.profile ? ` (${ctx.profile})` : ''}`,
    );
    log.line(
      `plan: ${Object.entries(plan.counts)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ')}`,
    );
    for (const i of plan.items)
      log.line(
        `plan ${i.state} ${i.key}${i.reason ? `: ${i.reason}` : ''}${i.warnings.length ? ` (${i.warnings.map((w) => w.text).join('; ')})` : ''}`,
      );

    let chosen;
    try {
      chosen = await choose(ctx, plan, values);
    } catch (e) {
      log.line(`stopped: ${e.message}`);
      throw e;
    }
    for (const k of chosen) log.line(`chosen ${k}`);
    const items = plan.items.filter((i) => chosen.has(i.key));

    // Passwords of the chosen objects that need one: --secrets, else asked (empty: skip that object).
    let secrets = values.secrets ? secretsFrom(await readSecretsFile(ctx, values.secrets), items) : {};
    if (!values.secrets && interactive(ctx) && !values['dry-run']) {
      secrets = {};
      for (const it of items) {
        for (const p of secretsOf(it.data)) {
          const label = clean(`${TRANSFER_KINDS[it.kind].label} ${it.name}, ${p}`).replace(
            /\x1b\[[0-9;]*m|[\r\n]/g,
            ' ',
          );
          const v = await readSecret(ctx, `${label} (empty: skip it): `);
          if (v) (secrets[it.key] ??= {})[p] = v;
        }
      }
    }

    const creating = items.filter((i) => i.state === 'new').length;
    const overwriting = items.filter((i) => i.state === 'differs').length;
    const summary = `Write to ${host}: create ${creating}, overwrite ${overwriting}; not written: ${plan.items.length - creating - overwriting} (${plan.counts.same} the same, ${plan.counts.blocked} blocked)${plan.welcomeMails ? `; ${plan.welcomeMails} new users with an e-mail may get the welcome e-mail of the PBX` : ''}`;
    log.line(summary);
    let write = !values['dry-run'] && chosen.size > 0;
    if (write && !values.yes) {
      write = interactive(ctx) ? await confirm(ctx, `${summary}\nWrite? [y/N] `) : false;
      if (!write)
        log.line(interactive(ctx) ? 'not confirmed: nothing written' : 'no --yes without a terminal: nothing written');
    }
    if (write) {
      const selfDn = serial ? `pbxid=${serial},dc=wildix` : null;
      results.push(
        ...(await applyPlan(client, plan, chosen, {
          secrets,
          selfDn,
          onEvent: (r) => {
            const line = `${r.action} ${r.key}${r.id ? ` id ${r.id}` : ''}${r.error ? `: ${r.error}` : ''}${r.because ? ` (because ${r.because})` : ''}`;
            log.line(line);
            ctx.info(line);
          },
        })),
      );
    }
    const steps = nextSteps({plan, results, host, rerun});
    for (const [n, s] of steps.entries())
      log.line(
        `next ${n + 1}${s.blocking ? ' (needed)' : ''}: ${s.what} — ${s.why}${s.wms ? ` — ${s.wms}` : ''}${s.command ? ` — ${s.command}` : ''}`,
      );
    log.line('done');
    return {
      pbx: host,
      from,
      dryRun: Boolean(values['dry-run']),
      written: write,
      plan: {
        counts: plan.counts,
        welcomeMails: plan.welcomeMails,
        items: plan.items.map(({key, state, reason, warnings}) => ({
          key,
          state,
          ...(reason ? {reason} : {}),
          warnings: warnings.map((w) => w.text),
        })),
      },
      chosen: [...chosen],
      results,
      nextSteps: steps,
      log: log.path,
    };
  } catch (e) {
    log.line(`error: ${e.message}`);
    throw e;
  } finally {
    log.close();
  }
}
