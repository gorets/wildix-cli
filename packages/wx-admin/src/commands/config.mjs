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
import {pbxClient} from '../pbx.mjs';
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

export const groups = {
  config: {
    summary: 'the configuration as files: back up a PBX to a folder, compare a folder or another PBX with a PBX',
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
