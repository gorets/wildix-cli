// wx-admin config: the configuration of a PBX as files (one JSON per object), and the differences between a folder
// and a PBX or between two PBX. Configuration as code: back up, keep in git, compare; nothing is written to a PBX.
// export, import and copy carry the configuration to another PBX, and with --cloud (or --only of a cloud kind) the
// cloud of its company: Wilma, knowledge bases, integrations, Kite (src/transfer/).
//
// What is kept: dialplans (rules, included dialplans by name), the general dialplan settings, timetables, IVR menus,
// switches, paging groups, queues (call groups), trunks (SIP, PSTN, FXO; passwords masked), trunk groups and ACL
// groups. What is left out as it differs between PBX or changes by itself: ids, ACL dns, trunk registration status.
import fs from 'node:fs';
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {refuseUnsafeWrite} from 'wldx-core/files';
import {oneLine, paint} from 'wldx-core/format';
import {select} from 'wldx-core/select';
import {accessRefused, pbxClient, readSerial} from '../pbx.mjs';
import {
  cloudClients,
  cloudKindsOf,
  cloudOf,
  companyOf,
  readCloudSource,
  sourceClients,
  targetCloudKinds,
  withCloudKinds,
} from '../transfer/cloud-clients.mjs';
import {readExport, writeExport} from '../transfer/folder.mjs';
import {EXPORTED, isCloud, readKinds, TRANSFER_KINDS} from '../transfer/kinds.mjs';
import {readMap} from '../transfer/map.mjs';
import {shellArg} from '../transfer/next-steps.mjs';
import {runImport} from '../transfer/run.mjs';
import {boundText, ownBoundReason, splitKey, toPortable} from '../transfer/refs.mjs';
import {chooseExport, closure, dbFamiliesOf, selectFrom} from '../transfer/selection.mjs';
import {maskSecrets} from './trunk.mjs';

const listOf = (r) => (Array.isArray(r) ? r : (r?.records ?? []));

// The kinds of objects: where to read them, their scope, and the name an object is known by.
export const KINDS = {
  dialplans: {
    path: '/PBX/Dialplans/',
    scope: 'dialplan',
    name: (r) => r.name,
    detail: (r) => `/PBX/Dialplans/${Number(r.id)}/`,
  },
  'dialplan-settings': {path: '/Dialplan/GeneralSettings/', scope: 'dialplan', single: true},
  timetables: {path: '/Dialplan/timeTables/', scope: 'dialplan', name: (r) => r.title},
  ivr: {path: '/Dialplan/Ivr/', scope: 'dialplan', name: (r) => r.title},
  switches: {path: '/Dialplan/Switches/', scope: 'dialplan', name: (r) => r.title},
  paging: {path: '/Dialplan/PagingGroups/', scope: 'dialplan', name: (r) => r.title},
  queues: {path: '/Dialplan/CallGroups/', scope: 'callgroups', name: (r) => r.title},
  'trunks-sip': {path: '/Trunks/Sip/', scope: 'trunks', name: (r) => r.title ?? r.name, mask: true},
  'trunks-pstn': {path: '/Trunks/Pstn/', scope: 'trunks', name: (r) => r.title ?? r.name, mask: true},
  'trunks-fxo': {path: '/Trunks/Fxo/', scope: 'trunks', name: (r) => r.title ?? r.username, mask: true},
  'trunk-groups': {path: '/Trunks/Groups/', scope: 'trunks', name: (r) => r.name ?? r.title},
  'acl-groups': {path: '/PBX/AclGroups/', scope: 'aclgroups', name: (r) => r.name},
};
const VOLATILE = new Set(['id', 'dn', 'status']);

function kindsOf(only) {
  if (!only) return Object.keys(KINDS);
  const list = only
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((k) => !Object.hasOwn(KINDS, k));
  if (bad.length) throw new UsageError(`Unknown kinds: ${bad.join(', ')}. Known: ${Object.keys(KINDS).join(', ')}`);
  return list;
}

const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !VOLATILE.has(k)));

// The configuration of the PBX: {kind: {name: object}} (a single object under the name "settings").
export async function snapshot(client, kinds, info = () => {}) {
  const out = {};
  for (const kind of kinds) {
    const k = KINDS[kind];
    let answer;
    try {
      answer = await client.call('GET', k.path, undefined, {scope: k.scope});
    } catch (e) {
      if (accessRefused(e)) throw e;
      info(`${kind}: not read (${oneLine(e.message, 140)})`);
      continue;
    }
    if (k.single) {
      out[kind] = {settings: answer};
      continue;
    }
    const records = listOf(answer);
    const objects = {};
    let dialplanNames;
    if (kind === 'dialplans') dialplanNames = new Map(records.map((r) => [r.id, r.name]));
    for (const r of records) {
      let full = k.detail ? await client.call('GET', k.detail(r), undefined, {scope: k.scope}) : r;
      if (kind === 'dialplans') {
        // included dialplans by name (ids differ between PBX); negative ids are built-in and the same everywhere
        full = {
          ...full,
          includedDialplans: (full.includedDialplans ?? []).map((x) =>
            x.dialplanId > 0 && dialplanNames.has(x.dialplanId) ? {dialplan: dialplanNames.get(x.dialplanId)} : x,
          ),
        };
      }
      if (k.mask) full = maskSecrets(full);
      let name = String(k.name(r) ?? r.id);
      while (Object.hasOwn(objects, name)) name += '~';
      objects[name] = strip(full);
    }
    out[kind] = objects;
  }
  return out;
}

const fileName = (name) =>
  `${
    String(name)
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 120) || '_'
  }.json`;

// Each object as it is in its own file; manifest.json maps the files to the names the objects are known by.
function writeBackup(dir, data, manifest) {
  fs.mkdirSync(dir, {recursive: true});
  if (fs.readdirSync(dir).length)
    throw new UsageError(`${dir} is not empty: back up into a new or empty folder (nothing was overwritten)`);
  const index = {};
  for (const [kind, objects] of Object.entries(data)) {
    const sub = path.join(dir, kind);
    fs.mkdirSync(sub);
    index[kind] = {};
    for (const [name, obj] of Object.entries(objects)) {
      let file = fileName(name);
      while (Object.hasOwn(index[kind], file)) file = file.replace(/\.json$/, '_.json');
      index[kind][file] = name;
      fs.writeFileSync(path.join(sub, file), `${JSON.stringify(obj, null, 2)}\n`, {flag: 'wx'});
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({...manifest, objects: index}, null, 2)}\n`, {
    flag: 'wx',
  });
}

// A backup folder read back: {kind: {name: object}}.
export function readBackup(dir, kinds) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new UsageError(`${dir} is not a backup of wx-admin config backup (no readable manifest.json)`);
  }
  const out = {};
  for (const kind of kinds) {
    const sub = path.join(dir, kind);
    if (!fs.existsSync(sub)) continue;
    const names = manifest.objects?.[kind] ?? {};
    const objects = {};
    for (const f of fs
      .readdirSync(sub)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      objects[Object.hasOwn(names, f) ? names[f] : f.slice(0, -5)] = JSON.parse(
        fs.readFileSync(path.join(sub, f), 'utf8'),
      );
    }
    out[kind] = objects;
  }
  return out;
}

// The paths where two JSON values differ: [{path, from, to}] (at most `max`).
export function differences(a, b, at = '', out = [], max = 50) {
  if (out.length >= max) return out;
  const isObj = (v) => v && typeof v === 'object';
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      differences(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k, out, max);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({path: at || '.', from: a, to: b});
  return out;
}

// Only the kinds both sides have are compared (a kind one side could not read is `skipped`, not "all added").
export function compare(left, right) {
  const added = [];
  const removed = [];
  const changed = [];
  const skipped = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (k) => !Object.hasOwn(left, k) || !Object.hasOwn(right, k),
  );
  const compared = Object.keys(left).filter((k) => Object.hasOwn(right, k));
  for (const kind of compared) {
    const l = left[kind] ?? {};
    const r = right[kind] ?? {};
    for (const name of Object.keys(r)) if (!Object.hasOwn(l, name)) added.push({kind, name});
    for (const name of Object.keys(l)) if (!Object.hasOwn(r, name)) removed.push({kind, name});
    for (const name of Object.keys(l)) {
      if (!Object.hasOwn(r, name)) continue;
      const paths = differences(l[name], r[name]);
      if (paths.length) changed.push({kind, name, paths});
    }
  }
  return {
    same: compared.length > 0 && !added.length && !removed.length && !changed.length,
    compared,
    added,
    removed,
    changed,
    skipped,
  };
}

const short = (v) => (v === undefined ? '(none)' : oneLine(JSON.stringify(v), 60));

const interactive = (ctx) => Boolean(ctx.stdin?.isTTY && ctx.stderr?.isTTY);

// A PBX read for a transfer: its objects turned portable (markers instead of references), with where it is. cloud:
// the cloud kinds to read too (cloudKindsOf), with the clients of the company of the PBX of ctx; none: no cloud call.
export async function exportOf(ctx, client, {users, dbFamily = [], cloud = []}) {
  const serial = await readSerial(client);
  // The safety scan and the ACL admin rules need the serial: without it, nothing is carried.
  if (!serial)
    throw new UsageError(
      `The serial of ${client.target.host} is not readable with this access (GET /PBX/settings/, scope pbx:read): it is needed to leave out everything bound to it. Use an access that can read it.`,
    );
  let wms;
  try {
    wms = (await client.call('GET', '/PBX/version/', undefined, {scope: 'info'}))?.version;
  } catch {
    wms = undefined;
  }
  // The clients of the cloud first: a token the PBX does not give stops the export before its objects are read.
  const clients = {pbx: client, ...(cloud.length ? await sourceClients(ctx, cloud) : {})};
  const {company, env} = cloudOf(clients);
  const kinds = Object.keys(TRANSFER_KINDS).filter(
    (k) => TRANSFER_KINDS[k].side === 'pbx' && k !== 'dialplan-db' && (k !== 'users' || users),
  );
  const snap = await readKinds(clients, kinds, {info: ctx.info});
  const families = [...new Set([...dbFamiliesOf(Array.isArray(snap.dialplans) ? snap.dialplans : []), ...dbFamily])];
  Object.assign(snap, await readKinds(clients, ['dialplan-db'], {dbFamilies: families, info: ctx.info}));
  if (cloud.length) Object.assign(snap, await readCloudSource(clients, cloud, {info: ctx.info}));
  return {
    portable: toPortable(snap, {serial, host: client.target.host, company}),
    source: {host: client.target.host, wms, ...(company ? {company, env} : {})},
    serial,
  };
}

// The clients of the target of an import: its PBX and the cloud services the export's cloud kinds and their lookups
// use (none for an export of the PBX only).
async function targetClients(ctx, client, portable) {
  return {pbx: client, ...(await cloudClients(ctx, targetCloudKinds(portable)))};
}

const CLOUD_OPTION = {
  type: 'boolean',
  description: 'the cloud of the company too: Wilma, knowledge bases, integrations, Kite',
};

const CHOICE_OPTIONS = {
  all: {type: 'boolean', description: 'everything (users only with --users, the cloud only with --cloud)'},
  only: {
    type: 'string',
    placeholder: 'KIND:NAME,…',
    description: 'only these objects and what they need (NAME * for every one of a kind)',
  },
  users: {
    type: 'boolean',
    description: 'include the users (portable fields only: no ids, passwords or anything of the PBX)',
  },
  'db-family': {
    type: 'string',
    multiple: true,
    placeholder: 'FAMILY',
    description: 'a family of the dialplan database to carry (besides those the dialplans name)',
  },
  cloud: CLOUD_OPTION,
};

const IMPORT_OPTIONS = {
  all: {
    type: 'boolean',
    description: 'every new object (and those that differ, with --overwrite); the cloud only with --cloud',
  },
  only: CHOICE_OPTIONS.only,
  cloud: CLOUD_OPTION,
  overwrite: {type: 'boolean', description: 'without the list: overwrite the objects that differ (else they are left)'},
  map: {
    type: 'string',
    placeholder: 'FILE',
    description: 'rename users, services, groups, numbers on the target: {"<kind>": {"<from>": "<to>"}}',
  },
  secrets: {
    type: 'string',
    placeholder: 'FILE',
    description:
      'without a terminal: the passwords and secrets, {"trunks-sip/<name>": {"password": "…"}, "wilma-secrets/<name>": {"value": "…"}}',
  },
  'dry-run': {type: 'boolean', description: 'the plan and the next steps only; nothing is written (the log is)'},
  yes: {type: 'boolean', description: 'without a terminal: write without asking'},
  log: {type: 'string', placeholder: 'DIR', description: 'where the log file goes (default: here)'},
};

function checkImportValues(ctx) {
  const v = ctx.values;
  if (v.all && v.only) throw new UsageError('Give --all or --only, not both', ctx.usage());
  if (v.map === '-' && v.secrets === '-') throw new UsageError('Only one of --map and --secrets can read stdin (-)');
  if (!v.all && !v.only && !interactive(ctx))
    throw new UsageError(
      'Without a terminal, choose what to import with --all or --only KIND:NAME,… (and --yes to write)',
      ctx.usage(),
    );
}

// The result printed; exit 1 when an object failed.
function finish(ctx, r) {
  if (!r.results.some((x) => x.action === 'failed')) return r;
  ctx.emit(r);
  const err = new Error(`${r.results.filter((x) => x.action === 'failed').length} objects failed (log: ${r.log})`);
  err.exitCode = 1;
  throw err;
}

// What the command to run an import again keeps of this one: --cloud when it carries cloud kinds (else the next
// steps' re-run would leave out the very objects they are about), --map with its file (FILE for one read from stdin,
// which a command cannot repeat: the next steps ask for the file again).
const rerunCloud = (cloud, v) =>
  `${cloud.length ? ' --cloud' : ''}${v.map ? ` --map ${v.map === '-' ? 'FILE' : shellArg(v.map)}` : ''}`;

// A secret generated for a new object, shown once (a webhook's signing secret: the receiver needs it).
const generatedLine = (key, p, value) => {
  const {kind, name} = splitKey(key);
  const what =
    kind === 'integration-webhooks' && p === 'secret' ? `signing secret of ${name}` : `secret ${p} of ${key}`;
  return `New ${what}: ${value} (shown once; give it to the receiver)`;
};

function importText(r, ctx) {
  const c = paint(ctx);
  const lines = [];
  const count = (a) => r.results.filter((x) => x.action === a).length;
  const cloudKey = (key) => isCloud(splitKey(key).kind);
  // An item of the plan: blocked with its reason, differs with the paths that do (and whether it deploys), new.
  const itemLine = (i) =>
    i.state === 'blocked'
      ? c.yellow(`  blocked ${i.key}: ${i.reason}`)
      : i.state === 'differs'
        ? `  differs ${i.key}${i.paths?.length ? `: ${i.paths.join(', ')}` : ''}${i.deploys ? ' (deploys)' : ''}`
        : `  new ${i.key}`;
  const failedLine = (x) => c.red(`  failed ${x.key}${x.stage ? ` at ${x.stage}` : ''}: ${x.error}`);
  if (r.dryRun) lines.push(c.bold(`Dry run: nothing was written to ${r.pbx}`));
  else if (!r.written) lines.push(c.bold(`Nothing was written to ${r.pbx}`));
  else
    lines.push(
      c.bold(
        `Written to ${r.pbx}: ${count('create')} created, ${count('overwrite')} overwritten, ${count('skip')} skipped, ${count('failed')} failed`,
      ),
    );
  for (const w of r.warnings ?? []) lines.push(c.yellow(`Warning: ${w}`));
  lines.push(
    `Plan from ${r.from}: ${Object.entries(r.plan.counts)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ')}`,
  );
  // The PBX first, as it always was (what is blocked, what failed), then the cloud in its own block (every object
  // not the same, the paths that differ, the notes of what was written).
  for (const i of r.plan.items.filter((x) => x.state === 'blocked' && !cloudKey(x.key)))
    lines.push(c.yellow(`  blocked ${i.key}: ${i.reason}`));
  for (const x of r.results.filter((y) => y.action === 'failed' && !cloudKey(y.key)))
    lines.push(c.red(`  failed ${x.key}: ${x.error}`));
  const cloudItems = r.plan.items.filter((i) => cloudKey(i.key) && i.state !== 'same');
  const cloudResults = r.results.filter((x) => cloudKey(x.key));
  if (cloudItems.length || cloudResults.length) {
    lines.push('Cloud:');
    for (const i of cloudItems) lines.push(itemLine(i));
    for (const x of cloudResults.filter((y) => y.action === 'failed')) lines.push(failedLine(x));
    for (const x of cloudResults) for (const n of x.notes ?? []) lines.push(c.dim(`  ${x.key}: ${n}`));
  }
  const generated = Object.entries(r.generatedSecrets ?? {});
  if (generated.length) lines.push('');
  for (const [key, values] of generated)
    for (const [p, value] of Object.entries(values)) lines.push(c.bold(generatedLine(key, p, value)));
  if (r.nextSteps.length) lines.push('', c.bold('Next steps:'));
  for (const [n, s] of r.nextSteps.entries()) {
    lines.push(`${n + 1}. ${s.blocking ? c.yellow('[needed] ') : ''}${s.what}`, `   ${c.dim(s.why)}`);
    if (s.wms) lines.push(`   ${c.dim(`WMS: ${s.wms}`)}`);
    if (s.command) lines.push(`   ${s.command}`);
  }
  lines.push('', `Log: ${r.log}`);
  return lines;
}

export const groups = {
  config: {
    summary:
      'the configuration as files: back up and compare; export, import and copy settings to another PBX (users, routing, trunks; with --cloud, the cloud of its company)',
    commands: {
      backup: {
        summary: 'write the configuration of the PBX to a new folder, one JSON file per object (passwords masked)',
        usage: 'wx-admin config backup --to DIR [--only KIND,KIND…]',
        details: `Kinds: ${Object.keys(KINDS).join(', ')}. A kind the access may not read is skipped with a note.`,
        options: {
          to: {type: 'string', placeholder: 'DIR', description: 'a new or empty folder'},
          only: {type: 'string', placeholder: 'KINDS', description: 'only these kinds (comma-separated)'},
        },
        args: [0, 0],
        async run(ctx) {
          if (!ctx.values.to) throw new UsageError('--to is needed', ctx.usage());
          const dir = path.resolve(ctx.cwd ?? process.cwd(), ctx.values.to);
          refuseUnsafeWrite(path.join(dir, 'manifest.json'), ctx.env);
          if (fs.existsSync(dir) && fs.readdirSync(dir).length)
            throw new UsageError(
              `${ctx.values.to} is not empty: back up into a new or empty folder (nothing was overwritten)`,
            );
          const kinds = kindsOf(ctx.values.only);
          const client = await pbxClient(ctx);
          const data = await snapshot(client, kinds, ctx.info);
          const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Object.keys(v).length]));
          writeBackup(dir, data, {
            pbx: client.target.host,
            at: new Date(ctx.clock()).toISOString(),
            tool: 'wx-admin config backup',
            kinds: counts,
          });
          return {dir, pbx: client.target.host, kinds: counts};
        },
        text: (r) => [
          `Backed up ${r.pbx} to ${r.dir}`,
          ...Object.entries(r.kinds).map(([k, n]) => `  ${k.padEnd(18)} ${n}`),
        ],
      },
      import: {
        summary:
          'write a config export to this PBX: a plan, what to write (chosen), the passwords, a log and what is left to do',
        usage:
          'wx-admin config import <dir> [--all | --only KIND:NAME,…] [--cloud] [--overwrite] [--map FILE] [--secrets FILE] [--dry-run] [--yes] [--log DIR]',
        details: [
          'Every object of the folder is compared with this PBX: new, the same, differs, or blocked (with the reason). In a',
          'terminal, a list to tick opens (new ones ticked; ticking one that differs overwrites it), then the passwords',
          'and secrets the chosen objects need, then a confirmation. Objects are written in the order they need each',
          'other; one that fails does not stop the rest. A log file is written every time (--log DIR, else here), also',
          'with --dry-run. The cloud objects of the folder (Wilma, knowledge bases, integrations, Kite) are written to the',
          'cloud of the company of this PBX with --cloud, or when --only names them. Without a terminal: --all or',
          '--only, and --yes to write.',
        ].join('\n'),
        options: IMPORT_OPTIONS,
        args: [1, 1],
        async run(ctx) {
          checkImportValues(ctx);
          const v = ctx.values;
          const cloud = cloudKindsOf(v);
          const map = v.map ? await readMap(ctx, v.map) : undefined;
          const {manifest, kinds} = await readExport(ctx, ctx.positionals[0]);
          const {portable, left} = withCloudKinds({...manifest, kinds}, cloud);
          if (left.length)
            ctx.info(
              `not imported, the cloud objects of the folder (add --cloud, or name them in --only): ${left.join(', ')}`,
            );
          const client = await pbxClient(ctx);
          const clients = await targetClients(ctx, client, portable);
          // An export of another environment of the cloud (stage → prod) is written all the same, with a warning.
          const warnings = [];
          const env = cloudOf(clients).env;
          if (manifest.source?.env && env && manifest.source.env !== env)
            warnings.push(`exported from ${manifest.source.env}, written to ${env}: another environment of the cloud`);
          const rerun = `wx-admin config import ${shellArg(ctx.positionals[0])} --pbx ${shellArg(client.target.host)}${rerunCloud(cloud, v)}`;
          return finish(
            ctx,
            await runImport(ctx, {
              portable,
              from: `${ctx.positionals[0]} (exported from ${manifest.source?.host ?? 'a PBX'})`,
              clients,
              values: v,
              rerun,
              map,
              warnings,
            }),
          );
        },
        text: importText,
      },
      copy: {
        summary: 'carry the configuration of one PBX to another: export in memory, then import (plan, choice, log)',
        usage:
          'wx-admin config copy --from PBX --to PBX [--all | --only KIND:NAME,…] [--users] [--cloud] [--overwrite] [--map FILE] [--secrets FILE] [--dry-run] [--yes] [--log DIR]',
        details: [
          'As config export then config import, without a folder. --from and --to take what --pbx takes. With --cloud',
          '(or --only of a cloud kind) the cloud of the company of --from goes to that of --to; when both PBX are of one',
          'company, the cloud is left out (there is nothing to copy).',
        ].join('\n'),
        options: {
          from: {type: 'string', placeholder: 'PBX', description: 'the PBX to read', complete: 'pbxs'},
          to: {type: 'string', placeholder: 'PBX', description: 'the PBX to write', complete: 'pbxs'},
          users: CHOICE_OPTIONS.users,
          'db-family': CHOICE_OPTIONS['db-family'],
          ...IMPORT_OPTIONS,
        },
        args: [0, 0],
        async run(ctx) {
          const v = ctx.values;
          if (!v.from || !v.to) throw new UsageError('--from and --to are needed', ctx.usage());
          if (ctx.pbx) throw new UsageError('copy takes --from and --to, not --pbx', ctx.usage());
          checkImportValues(ctx);
          let cloud = cloudKindsOf(v);
          const map = v.map ? await readMap(ctx, v.map) : undefined;
          const from = {...ctx, pbx: v.from};
          const to = {...ctx, pbx: v.to};
          const source = await pbxClient(from);
          const client = await pbxClient(to);
          if (source.target.host === client.target.host)
            throw new UsageError(`--from and --to are the same PBX: ${client.target.host}`);
          const [a, b] = [await readSerial(source), await readSerial(client)];
          if (a && b && a === b) throw new UsageError(`--from and --to are the same PBX (serial ${a})`);
          // One company on both sides has one cloud: the PBX part goes on alone.
          if (cloud.length && (await companyOf(from)) === (await companyOf(to))) {
            ctx.info(
              `the cloud is left out: ${source.target.host} and ${client.target.host} are of the same company — nothing to copy`,
            );
            cloud = [];
          }
          const {portable} = await exportOf(from, source, {users: v.users, dbFamily: v['db-family'], cloud});
          const bound = new Set(portable.bound.map((x) => `${x.kind}/${x.name}`));
          const all = Object.entries(portable.kinds).flatMap(([kind, list]) => list.map((o) => `${kind}/${o.name}`));
          const carried = selectFrom(portable, new Set([...closure(portable, all)].filter((k) => !bound.has(k))));
          for (const x of portable.bound)
            ctx.info(
              ownBoundReason(x)
                ? `not carried: ${x.kind}/${x.name} (${boundText(x)})`
                : `not carried, bound to ${source.target.host}: ${x.kind}/${x.name} (${boundText(x)})`,
            );
          const rerun = `wx-admin config copy --from ${shellArg(v.from)} --to ${shellArg(v.to)}${v.users ? ' --users' : ''}${rerunCloud(cloud, v)}`;
          return finish(
            ctx,
            await runImport(ctx, {
              portable: carried,
              from: source.target.host,
              clients: await targetClients(to, client, carried),
              values: v,
              rerun,
              map,
            }),
          );
        },
        text: importText,
      },
      export: {
        summary: 'choose what to carry to another PBX and write it to a new folder, without anything bound to this PBX',
        usage:
          'wx-admin config export --to DIR [--all | --only KIND:NAME,…] [--users] [--cloud] [--db-family FAMILY]...',
        details: [
          'In a terminal, a list to tick opens (an object brings what it needs). References between objects are kept by',
          'name; ids, LDAP dns, the serial and passwords of this PBX are left out. An object where the serial or the host',
          `of this PBX is still found is not exported (listed as bound). Kinds: ${EXPORTED.join(', ')}.`,
          'The cloud kinds (the cloud of the company of the PBX) are read with --cloud, or when --only names one; no',
          'secret value is exported.',
          'Then: wx-admin config import DIR --pbx OTHER.',
        ].join('\n'),
        options: {to: {type: 'string', placeholder: 'DIR', description: 'a new or empty folder'}, ...CHOICE_OPTIONS},
        args: [0, 0],
        async run(ctx) {
          const v = ctx.values;
          if (!v.to) throw new UsageError('--to is needed', ctx.usage());
          if (v.all && v.only) throw new UsageError('Give --all or --only, not both', ctx.usage());
          if (!v.all && !v.only && !interactive(ctx))
            throw new UsageError(
              'Without a terminal, choose what to export with --all or --only KIND:NAME,…',
              ctx.usage(),
            );
          const cloud = cloudKindsOf(v);
          const target = path.resolve(ctx.cwd ?? process.cwd(), v.to);
          refuseUnsafeWrite(target, ctx.env);
          if (fs.existsSync(target) && fs.readdirSync(target).length)
            throw new UsageError(`${v.to} is not empty: export into a new or empty folder (nothing was overwritten)`);
          const client = await pbxClient(ctx);
          const usersAsked = v.users || (v.only && /(^|,)\s*users(:|,|$)/.test(v.only));
          const {portable, source} = await exportOf(ctx, client, {users: usersAsked, dbFamily: v['db-family'], cloud});
          const keys = await chooseExport(portable, v, {interactive: interactive(ctx), select: (o) => select(ctx, o)});
          const chosen = selectFrom(portable, keys);
          const {dir, counts} = writeExport(ctx, target, {source, portable: chosen});
          return {
            dir,
            pbx: source.host,
            ...(source.company ? {company: source.company, env: source.env} : {}),
            kinds: counts,
            bound: portable.bound,
            external: chosen.external,
            unresolved: chosen.unresolved,
            ...(chosen.warnings?.length ? {warnings: chosen.warnings} : {}),
            errors: portable.errors,
          };
        },
        text(r, ctx) {
          const c = paint(ctx);
          const kinds = Object.entries(r.kinds);
          const cloud = kinds.filter(([k]) => isCloud(k));
          const lines = [
            `Exported from ${r.pbx} to ${r.dir}`,
            ...kinds.filter(([k]) => !isCloud(k)).map(([k, n]) => `  ${k.padEnd(18)} ${n}`),
          ];
          // The cloud in its own block, padded to its own longest kind (integration-webhooks).
          if (cloud.length)
            lines.push(
              `The cloud of ${r.company ?? 'its company'}:`,
              ...cloud.map(([k, n]) => `  ${k.padEnd(20)} ${n}`),
            );
          for (const [k, e] of Object.entries(r.errors ?? {}))
            lines.push(c.yellow(`  ${k}: not read (${oneLine(e, 100)})`));
          for (const b of r.bound)
            lines.push(
              c.red(
                ownBoundReason(b)
                  ? `  not exported: ${b.kind}/${b.name} (${boundText(b)})`
                  : `  not exported, bound to ${r.pbx}: ${b.kind}/${b.name} (${boundText(b)})`,
              ),
            );
          for (const x of r.external)
            lines.push(c.yellow(`  outside the PBX, kept as it is: ${x.kind}/${x.name} ${x.path} (${x.what})`));
          for (const x of r.unresolved)
            lines.push(
              c.yellow(`  a reference to nothing on ${r.pbx}, kept: ${x.kind}/${x.name} ${x.path} = ${x.value}`),
            );
          for (const x of r.warnings ?? []) lines.push(c.yellow(`  ${x.kind}/${x.name} ${x.path}: ${x.text}`));
          lines.push(`Next: wx-admin config import ${r.dir} --pbx OTHER`);
          return lines;
        },
      },
      diff: {
        summary: 'what differs between a backup folder (or another PBX) and the PBX',
        usage: 'wx-admin config diff (<dir> | --with PBX) [--only KIND,KIND…]',
        details: [
          '+ is only on the PBX, - only in the folder (or the other PBX), ~ differs (the paths that do).',
          'With --all-pbx, every PBX is compared with the same folder.',
        ].join('\n'),
        options: {
          with: {
            type: 'string',
            placeholder: 'PBX',
            description: 'compare with another PBX instead of a folder',
            complete: 'pbxs',
          },
          only: {type: 'string', placeholder: 'KINDS', description: 'only these kinds (comma-separated)'},
        },
        args: [0, 1],
        readOnly: true,
        async run(ctx) {
          if (!ctx.positionals[0] === !ctx.values.with)
            throw new UsageError('Give a backup folder or --with PBX', ctx.usage());
          const kinds = kindsOf(ctx.values.only);
          const client = await pbxClient(ctx);
          const left = ctx.values.with
            ? await snapshot(await pbxClient({...ctx, pbx: ctx.values.with}), kinds, ctx.info)
            : readBackup(path.resolve(ctx.cwd ?? process.cwd(), ctx.positionals[0]), kinds);
          const right = await snapshot(client, kinds, ctx.info);
          return {pbx: client.target.host, against: ctx.values.with ?? ctx.positionals[0], ...compare(left, right)};
        },
        text(r, ctx) {
          const c = paint(ctx);
          const skipped = r.skipped?.length
            ? [c.dim(`not compared (not read on one side): ${r.skipped.join(', ')}`)]
            : [];
          if (!r.compared.length) return [`${r.pbx}: nothing to compare with ${r.against}`, ...skipped];
          if (r.same) return [`${r.pbx}: no differences with ${r.against}`, ...skipped];
          const lines = [`${r.pbx} compared with ${r.against}:`, ...skipped];
          for (const x of r.added) lines.push(c.green(`+ ${x.kind}/${x.name}`));
          for (const x of r.removed) lines.push(c.red(`- ${x.kind}/${x.name}`));
          for (const x of r.changed) {
            lines.push(c.yellow(`~ ${x.kind}/${x.name}`));
            for (const p of x.paths.slice(0, 10)) lines.push(`    ${p.path}: ${short(p.from)} → ${short(p.to)}`);
            if (x.paths.length > 10) lines.push(c.dim(`    … ${x.paths.length - 10} more`));
          }
          return lines;
        },
      },
    },
  },
};
