// wx-admin config: the configuration of a PBX as files (one JSON per object), and the differences between a folder
// and a PBX or between two PBX. Configuration as code: back up, keep in git, compare; nothing is written to a PBX.
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
import {pbxClient, readSerial} from '../pbx.mjs';
import {readExport, writeExport} from '../transfer/folder.mjs';
import {readKinds, TRANSFER_KINDS} from '../transfer/kinds.mjs';
import {shellArg} from '../transfer/next-steps.mjs';
import {runImport} from '../transfer/run.mjs';
import {toPortable} from '../transfer/refs.mjs';
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

// A PBX read for a transfer: its objects turned portable (markers instead of references), with where it is.
export async function exportOf(ctx, client, {users, dbFamily = []}) {
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
  const kinds = Object.keys(TRANSFER_KINDS).filter((k) => k !== 'dialplan-db' && (k !== 'users' || users));
  const snap = await readKinds(client, kinds, {info: ctx.info});
  const families = [...new Set([...dbFamiliesOf(Array.isArray(snap.dialplans) ? snap.dialplans : []), ...dbFamily])];
  Object.assign(snap, await readKinds(client, ['dialplan-db'], {dbFamilies: families, info: ctx.info}));
  return {
    portable: toPortable(snap, {serial, host: client.target.host}),
    source: {host: client.target.host, wms},
    serial,
  };
}

const CHOICE_OPTIONS = {
  all: {type: 'boolean', description: 'everything (users only with --users)'},
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
};

const IMPORT_OPTIONS = {
  all: {type: 'boolean', description: 'every new object (and those that differ, with --overwrite)'},
  only: CHOICE_OPTIONS.only,
  overwrite: {type: 'boolean', description: 'without the list: overwrite the objects that differ (else they are left)'},
  secrets: {
    type: 'string',
    placeholder: 'FILE',
    description: 'without a terminal: the passwords, {"trunks-sip/<name>": {"password": "…"}}',
  },
  'dry-run': {type: 'boolean', description: 'the plan and the next steps only; nothing is written (the log is)'},
  yes: {type: 'boolean', description: 'without a terminal: write without asking'},
  log: {type: 'string', placeholder: 'DIR', description: 'where the log file goes (default: here)'},
};

function checkImportValues(ctx) {
  const v = ctx.values;
  if (v.all && v.only) throw new UsageError('Give --all or --only, not both', ctx.usage());
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

function importText(r, ctx) {
  const c = paint(ctx);
  const lines = [];
  const count = (a) => r.results.filter((x) => x.action === a).length;
  if (r.dryRun) lines.push(c.bold(`Dry run: nothing was written to ${r.pbx}`));
  else if (!r.written) lines.push(c.bold(`Nothing was written to ${r.pbx}`));
  else
    lines.push(
      c.bold(
        `Written to ${r.pbx}: ${count('create')} created, ${count('overwrite')} overwritten, ${count('skip')} skipped, ${count('failed')} failed`,
      ),
    );
  lines.push(
    `Plan from ${r.from}: ${Object.entries(r.plan.counts)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ')}`,
  );
  for (const i of r.plan.items.filter((x) => x.state === 'blocked'))
    lines.push(c.yellow(`  blocked ${i.key}: ${i.reason}`));
  for (const x of r.results.filter((y) => y.action === 'failed')) lines.push(c.red(`  failed ${x.key}: ${x.error}`));
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
      'the configuration as files: back up and compare; export, import and copy settings to another PBX (users, routing, trunks)',
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
          'wx-admin config import <dir> [--all | --only KIND:NAME,…] [--overwrite] [--secrets FILE] [--dry-run] [--yes] [--log DIR]',
        details: [
          'Every object of the folder is compared with this PBX: new, the same, differs, or blocked (with the reason). In a',
          'terminal, a list to tick opens (new ones ticked; ticking one that differs overwrites it), then the passwords',
          'the chosen trunks need, then a confirmation. Objects are written in the order they need each other; one that',
          'fails does not stop the rest. A log file is written every time (--log DIR, else here), also with --dry-run.',
          'Without a terminal: --all or --only, and --yes to write.',
        ].join('\n'),
        options: IMPORT_OPTIONS,
        args: [1, 1],
        async run(ctx) {
          checkImportValues(ctx);
          const {manifest, kinds} = await readExport(ctx, ctx.positionals[0]);
          const portable = {...manifest, kinds};
          const client = await pbxClient(ctx);
          const rerun = `wx-admin config import ${shellArg(ctx.positionals[0])} --pbx ${shellArg(client.target.host)}`;
          return finish(
            ctx,
            await runImport(ctx, {
              portable,
              from: `${ctx.positionals[0]} (exported from ${manifest.source?.host ?? 'a PBX'})`,
              client,
              values: ctx.values,
              rerun,
            }),
          );
        },
        text: importText,
      },
      copy: {
        summary: 'carry the configuration of one PBX to another: export in memory, then import (plan, choice, log)',
        usage:
          'wx-admin config copy --from PBX --to PBX [--all | --only KIND:NAME,…] [--users] [--overwrite] [--secrets FILE] [--dry-run] [--yes] [--log DIR]',
        details: 'As config export then config import, without a folder. --from and --to take what --pbx takes.',
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
          const source = await pbxClient({...ctx, pbx: v.from});
          const client = await pbxClient({...ctx, pbx: v.to});
          if (source.target.host === client.target.host)
            throw new UsageError(`--from and --to are the same PBX: ${client.target.host}`);
          const [a, b] = [await readSerial(source), await readSerial(client)];
          if (a && b && a === b) throw new UsageError(`--from and --to are the same PBX (serial ${a})`);
          const {portable} = await exportOf(ctx, source, {users: v.users, dbFamily: v['db-family']});
          const bound = new Set(portable.bound.map((x) => `${x.kind}/${x.name}`));
          const all = Object.entries(portable.kinds).flatMap(([kind, list]) => list.map((o) => `${kind}/${o.name}`));
          const carried = selectFrom(portable, new Set([...closure(portable, all)].filter((k) => !bound.has(k))));
          for (const x of portable.bound)
            ctx.info(`not carried, bound to ${source.target.host}: ${x.kind}/${x.name} (${x.found} in ${x.path})`);
          const rerun = `wx-admin config copy --from ${shellArg(v.from)} --to ${shellArg(v.to)}${v.users ? ' --users' : ''}`;
          return finish(
            ctx,
            await runImport(ctx, {portable: carried, from: source.target.host, client, values: v, rerun}),
          );
        },
        text: importText,
      },
      export: {
        summary: 'choose what to carry to another PBX and write it to a new folder, without anything bound to this PBX',
        usage: 'wx-admin config export --to DIR [--all | --only KIND:NAME,…] [--users] [--db-family FAMILY]...',
        details: [
          'In a terminal, a list to tick opens (an object brings what it needs). References between objects are kept by',
          'name; ids, LDAP dns, the serial and passwords of this PBX are left out. An object where the serial or the host',
          `of this PBX is still found is not exported (listed as bound). Kinds: ${Object.keys(TRANSFER_KINDS).join(', ')}.`,
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
          const target = path.resolve(ctx.cwd ?? process.cwd(), v.to);
          refuseUnsafeWrite(target, ctx.env);
          if (fs.existsSync(target) && fs.readdirSync(target).length)
            throw new UsageError(`${v.to} is not empty: export into a new or empty folder (nothing was overwritten)`);
          const client = await pbxClient(ctx);
          const usersAsked = v.users || (v.only && /(^|,)\s*users(:|,|$)/.test(v.only));
          const {portable, source} = await exportOf(ctx, client, {users: usersAsked, dbFamily: v['db-family']});
          const keys = await chooseExport(portable, v, {interactive: interactive(ctx), select: (o) => select(ctx, o)});
          const chosen = selectFrom(portable, keys);
          const {dir, counts} = writeExport(ctx, target, {source, portable: chosen});
          return {
            dir,
            pbx: source.host,
            kinds: counts,
            bound: portable.bound,
            external: chosen.external,
            unresolved: chosen.unresolved,
            errors: portable.errors,
          };
        },
        text(r, ctx) {
          const c = paint(ctx);
          const lines = [
            `Exported from ${r.pbx} to ${r.dir}`,
            ...Object.entries(r.kinds).map(([k, n]) => `  ${k.padEnd(18)} ${n}`),
          ];
          for (const [k, e] of Object.entries(r.errors ?? {}))
            lines.push(c.yellow(`  ${k}: not read (${oneLine(e, 100)})`));
          for (const b of r.bound)
            lines.push(c.red(`  not exported, bound to ${r.pbx}: ${b.kind}/${b.name} (${b.found} in ${b.path})`));
          for (const x of r.external)
            lines.push(c.yellow(`  outside the PBX, kept as it is: ${x.kind}/${x.name} ${x.path} (${x.what})`));
          for (const x of r.unresolved)
            lines.push(
              c.yellow(`  a reference to nothing on ${r.pbx}, kept: ${x.kind}/${x.name} ${x.path} = ${x.value}`),
            );
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
