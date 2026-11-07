// wx-admin trunk: the trunks of a PBX (SIP, PSTN gateways, FXO gateways), trunk groups and price lists, over the PBX
// REST API (tags Trunks, Trunk groups, Trunks Price; Company API Key scope `trunks`).
//
// The model of the API: GET /Trunks/Sip/ (/Pstn/, /Fxo/) lists the trunks of a kind with every setting; there is no
// GET by id. A SIP trunk is {id, title, name, register, settingsPbx: {host, port, secret, context, …}, settingsWms:
// {enableReg, regSecret, …}, status}; SIP trunks are created and deleted, PSTN and FXO ones only changed. A write
// answers "Success": the commands read the list again. A PUT gets the whole trunk (the PBX wants every field): update
// reads it, applies the changes and writes it back.
// Secrets: settingsPbx.secret, settingsWms.regSecret and `register` (the SIP register string holds the password) are
// never shown in text, and in JSON they are masked as ******** unless --show-secrets. A masked value written back
// (update --from a file made with get) keeps the secret the trunk has.
// Price lists are CSV files on the PBX: create and update send one as multipart (name, upload); export returns it.
// Checked live: only the reads (list, get, groups, prices, price-export); writes only with tests (trunks carry calls).
import path from 'node:path';
import fs from 'node:fs';
import {UsageError} from 'wldx-core/errors';
import {readForUpload, refuseUnsafeWrite} from 'wldx-core/files';
import {oneLine, paint, table} from 'wldx-core/format';
import {apiPath} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';
import {readSecret} from 'wldx-core/secret';
import {findRecord, readJsonInput, wholeNumber} from './routing.mjs';

const SCOPE = {scope: 'trunks'};
const KINDS = ['sip', 'pstn', 'fxo'];
const LIST_PATH = {sip: '/Trunks/Sip/', pstn: '/Trunks/Pstn/', fxo: '/Trunks/Fxo/'};
const trunkPath = {
  sip: (id) => apiPath`/Trunks/Sip/${id}`,
  pstn: (id) => apiPath`/Trunks/Pstn/${id}/`,
  fxo: (id) => apiPath`/Trunks/Fxo/${id}/`,
};
const KIND_NAME = {sip: 'SIP', pstn: 'PSTN', fxo: 'FXO'};

export const MASK = '********';
// passwords and secrets, the SIP register string (it embeds the password), API keys and tokens
const SECRET_KEY = /secret|password|passwd|^register$|^key$|apikey|token/i;

// A copy with every non-empty secret replaced by MASK.
export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SECRET_KEY.test(k) && typeof v === 'string' && v !== '' ? MASK : maskSecrets(v),
    ]),
  );
}
const shown = (ctx, data) => (ctx.values['show-secrets'] ? data : maskSecrets(data));

// The name a trunk is known by: SIP name, PSTN name, FXO username.
const trunkName = (t) => t.name ?? t.username ?? t.settingsPbx?.peername ?? '';

async function listKind(client, kind) {
  return (await client.call('GET', LIST_PATH[kind], undefined, SCOPE))?.records ?? [];
}

// A trunk by id, title or name, of one kind or of any ({kind, trunk}); an id of two kinds needs --type.
async function findTrunk(client, ref, kind) {
  const kinds = kind ? [kind] : KINDS;
  const s = String(ref);
  const all = [];
  for (const k of kinds) for (const t of await listKind(client, k)) all.push({kind: k, trunk: t});
  const byId = /^\d+$/.test(s) ? all.filter((x) => String(x.trunk.id) === s) : [];
  if (byId.length > 1)
    throw new UsageError(
      `Trunks of several kinds have the id ${s} (${byId.map((x) => KIND_NAME[x.kind]).join(', ')}): give --type`,
    );
  if (byId[0]) return byId[0];
  // By title or name: the exact one first, else without case; two matches ask for the id (or --type).
  const lower = s.toLowerCase();
  const exact = all.filter((x) => x.trunk.title === s || trunkName(x.trunk) === s);
  const pool = exact.length
    ? exact
    : all.filter(
        (x) =>
          String(x.trunk.title ?? '').toLowerCase() === lower || String(trunkName(x.trunk)).toLowerCase() === lower,
      );
  if (pool.length > 1)
    throw new UsageError(
      `Several trunks are named ${s} (${pool.map((x) => `${KIND_NAME[x.kind]} ${x.trunk.id}`).join(', ')}): give the id and --type`,
    );
  if (!pool.length) throw new UsageError(`No ${kind ? `${KIND_NAME[kind]} ` : ''}trunk ${s} (wx-admin trunk list)`);
  return pool[0];
}

const statusOf = (kind, t) => {
  if (kind === 'sip')
    return `out ${t.status?.outgoing?.title ?? t.status?.outgoing?.state ?? '-'}, in ${t.status?.incoming?.title ?? t.status?.incoming?.state ?? '-'}`;
  if (typeof t.status?.active === 'boolean') return t.status.active ? 'active' : 'inactive';
  return '';
};
const hostOf = (kind, t) =>
  kind === 'sip'
    ? `${t.settingsPbx?.host ?? ''}${t.settingsPbx?.port ? `:${t.settingsPbx.port}` : ''}`
    : (t.address ?? '');
const contextOf = (kind, t) =>
  kind === 'fxo'
    ? [
        ...new Set(
          [t.settingsMgw?.ports ?? []]
            .flat()
            .map((p) => p?.context)
            .filter(Boolean),
        ),
      ].join(',')
    : (t.settingsPbx?.context ?? '');
const row = (kind, t) => [
  KIND_NAME[kind],
  t.id,
  t.title ?? '',
  kind === 'sip' ? trunkName(t) : (t.technology ?? trunkName(t)),
  hostOf(kind, t),
  contextOf(kind, t),
  statusOf(kind, t),
];

function trunkLines(r, ctx) {
  const {kind} = r;
  const c = paint(ctx);
  const set = (v) => (v ? 'set' : 'none');
  const lines = [`${c.bold(r.title ?? trunkName(r))} (${KIND_NAME[kind]}, id ${r.id}) · name ${trunkName(r)}`];
  if (kind === 'sip') {
    const p = r.settingsPbx ?? {};
    lines.push(
      `host ${hostOf(kind, r) || '-'} · transport ${p.transportWildix ?? '-'} · context ${p.context ?? '-'} · login ${p.userName ?? '-'}`,
    );
    lines.push(
      `codecs ${
        (p.audioCodecs ?? [])
          .filter((x) => x.enable)
          .map((x) => x.key)
          .join(', ') || '-'
      } · dtmf ${p.dtmfMode ?? '-'} · srtp ${p.forceSrtp ? 'on' : 'off'}`,
    );
    lines.push(`registration ${r.settingsWms?.enableReg ? 'on' : 'off'} · ${statusOf(kind, r)}`);
    lines.push(`password ${set(p.secret)}${r.settingsWms?.regSecret ? ' · proxy password set' : ''}`);
  } else {
    lines.push(
      `${kind === 'pstn' ? `technology ${r.technology ?? '-'} · ports ${r.ports ?? '-'} · ` : `model ${r.model ?? '-'} · `}address ${r.address || '-'} · context ${contextOf(kind, r) || '-'}`,
    );
    if (statusOf(kind, r)) lines.push(statusOf(kind, r));
  }
  return lines;
}

// Every field of a new SIP trunk (as WMS makes them, seen live); the options fill in the rest.
function sipTemplate() {
  return {
    title: '',
    name: '',
    register: '',
    settingsPbx: {
      audioCodecs: [
        {key: 'alaw', value: 20, enable: true},
        {key: 'ulaw', value: 20, enable: true},
        {key: 'g729', value: 20, enable: true},
      ],
      allowTransfer: false,
      cidBody: '',
      cidHeader: '',
      context: 'main',
      countryCode: 0,
      isoCode: '',
      disallow: 'all',
      diversionHeader: '',
      dtmfMode: 'rfc2833',
      forceSrtp: false,
      fromDomain: '',
      fromName: '',
      fromNumber: '',
      fromUser: '',
      historyInfoHeader: '',
      host: '',
      insecure: 'invite,port',
      language: '',
      peername: '',
      port: '',
      preserveOrigCid: true,
      priceList: 0,
      privacyHeader: '',
      qualify: true,
      rfcPayload: 101,
      rport: 'invite',
      secret: '',
      sessionExpires: 600,
      sessionMinse: 90,
      sessionTimer: true,
      ssrcChange: false,
      symmetricRtp: true,
      thirtyEightPtUdptl: true,
      thirtyEightPtErrorCorrection: 'redundancy',
      thirtyEightPtMaxDatagram: 400,
      toneZone: '',
      transportWildix: 'udp',
      trustRpid: true,
      type: 'friend',
      userName: '',
      videoCodecs: false,
      playRemoteMoh: false,
      contactNumber: '',
      kernelLevelMedia: false,
    },
    settingsWms: {
      dnsServer: '',
      enableReg: false,
      expiry: '',
      natIp: '',
      outboundProxy: '',
      outboundProxyPort: '',
      overwriteReg: false,
      regFromUser: '',
      regHost: '',
      regPort: '',
      regSecret: '',
      regUsername: '',
    },
  };
}

const SETTINGS_KEYS = ['settingsPbx', 'settingsWms', 'settingsMgw'];
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// The trunk with the fields of src applied (the settings objects one level deep); a masked secret keeps the current one.
function merged(current, src) {
  const out = structuredClone(current);
  for (const [k, v] of Object.entries(src ?? {})) {
    if (k === 'id' || k === 'kind' || k === 'status') continue;
    if (SETTINGS_KEYS.includes(k) && isObject(v)) {
      out[k] = {...(out[k] ?? {})};
      for (const [sk, sv] of Object.entries(v)) if (sv !== MASK) out[k][sk] = sv;
    } else if (v !== MASK) out[k] = v;
  }
  return out;
}

const PORT = /^\d{1,5}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const TRANSPORTS = ['udp', 'tcp', 'tls'];

const SIP_OPTIONS = {
  host: {
    type: 'string',
    placeholder: 'HOST',
    description: 'the SIP proxy of the carrier (dynamic: the carrier registers to the PBX)',
  },
  port: {type: 'string', placeholder: 'N', description: 'its port (empty: the default)'},
  user: {type: 'string', placeholder: 'LOGIN', description: 'the login the carrier gave (the name of the trunk)'},
  context: {
    type: 'string',
    placeholder: 'DIALPLAN',
    description: 'the dialplan for the calls that come in from the trunk',
  },
  transport: {type: 'string', choices: TRANSPORTS, description: 'the SIP transport'},
  secret: {type: 'boolean', description: 'set the password: typed hidden, or the first line of stdin'},
};

// The SIP options applied to a trunk body (changes it).
async function applySipOptions(ctx, body) {
  const v = ctx.values;
  const p = body.settingsPbx;
  if (v.host !== undefined) {
    if (!HOST.test(v.host)) throw new UsageError(`Not a host: ${v.host}`);
    p.host = v.host;
  }
  if (v.port !== undefined) {
    if (v.port !== '' && (!PORT.test(v.port) || Number(v.port) > 65535)) throw new UsageError(`Not a port: ${v.port}`);
    p.port = v.port;
  }
  if (v.user !== undefined) {
    if (!/^\S{1,128}$/.test(v.user)) throw new UsageError(`Not a login: ${v.user}`);
    body.name = v.user;
    p.peername = v.user;
    p.userName = v.user;
  }
  if (v.transport !== undefined) p.transportWildix = v.transport;
  if (v.secret) {
    if (v.from === '-') throw new UsageError('--secret reads stdin: give --from as a file');
    const secret = await readSecret(ctx, 'Trunk password: ');
    if (!secret) throw new UsageError('An empty password');
    p.secret = secret;
  }
}

const checkContext = (c) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c)) throw new UsageError(`Not a dialplan name: ${c}`);
  return c;
};

// ---------------------------------------------------------------------------------------------------------------------
// Trunk groups: {id, name, description, rules: [{trunkName, remove, prepend, maxCalls, timeout}]}, tried in order.

const GROUPS = '/Trunks/Groups/';
const groupPath = (id) => apiPath`/Trunks/Groups/${id}`;
const GROUP_NAME = /^[0-9a-zA-Z_]{1,64}$/;
const PREPEND = /^\+?[0-9*#]*$/;

// A rule with the fields WMS sends (remove 0 and prepend '' when not given).
function groupRule(r) {
  if (!isObject(r) || typeof r.trunkName !== 'string' || !r.trunkName)
    throw new UsageError('A rule needs trunkName (the name of a trunk)');
  const out = {
    ...r,
    trunkName: r.trunkName,
    remove: wholeNumber(r.remove ?? 0, `${r.trunkName}: remove`, 0, 64),
    prepend: String(r.prepend ?? ''),
  };
  if (!PREPEND.test(out.prepend))
    throw new UsageError(`${r.trunkName}: prepend is digits, * and # (a + first): ${out.prepend}`);
  for (const k of ['maxCalls', 'timeout'])
    if (r[k] !== undefined && r[k] !== '') out[k] = wholeNumber(r[k], `${r.trunkName}: ${k}`, 0, 100000);
  return out;
}

// --trunk "NAME remove=1 prepend=0 maxCalls=2 timeout=30" or JSON.
function parseRule(spec) {
  const s = String(spec).trim();
  if (s.startsWith('{')) {
    try {
      return groupRule(JSON.parse(s));
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError(`--trunk is not JSON: ${e.message}`);
    }
  }
  const [trunkName, ...pairs] = s.split(/\s+/);
  const rule = {trunkName};
  for (const p of pairs) {
    const at = p.indexOf('=');
    const key = p.slice(0, at);
    if (at < 1 || !['remove', 'prepend', 'maxCalls', 'timeout'].includes(key))
      throw new UsageError(`--trunk takes remove=, prepend=, maxCalls=, timeout=: ${p}`);
    rule[key] = p.slice(at + 1);
  }
  return groupRule(rule);
}

const ruleText = (r) => {
  const extra = [
    r.remove ? `-${r.remove}` : '',
    r.prepend ? `+"${r.prepend}"` : '',
    r.maxCalls ? `max ${r.maxCalls}` : '',
    r.timeout ? `${r.timeout}s` : '',
  ].filter(Boolean);
  return extra.length ? `${r.trunkName}(${extra.join(' ')})` : r.trunkName;
};
const groupLines = (g) => [
  `${g.name}${g.id !== undefined ? ` (id ${g.id})` : ''}${g.description ? ` — ${g.description}` : ''}`,
  ...((g.rules ?? []).length ? g.rules.map((r, i) => `${String(i + 1).padStart(3)}  ${ruleText(r)}`) : ['  no trunks']),
];

// A note when a rule names a trunk the PBX does not have (the PBX decides).
async function noteUnknownTrunks(ctx, client, rules) {
  const names = new Set();
  for (const k of KINDS) for (const t of await listKind(client, k)) names.add(trunkName(t));
  for (const r of rules)
    if (!names.has(r.trunkName))
      ctx.info(`Note: no trunk is named ${r.trunkName} (wx-admin trunk list); the PBX decides.`);
}

const RULE_HELP = [
  'A --trunk is the name of a trunk (wx-admin trunk list) and what to do to the number before it is sent there:',
  '--trunk "carrier1 remove=1 prepend=+39 maxCalls=10 timeout=30" (remove digits first, then prepend). The trunks are',
  'tried in the order given. Or JSON: --trunk \'{"trunkName": "carrier1", "remove": 1}\'.',
].join('\n');

// ---------------------------------------------------------------------------------------------------------------------
// Price lists: {id, name, items: [{dialprefix, destination, rate, minDuration, billingBlock, connectCharge, startDay,
// stopDay, startTime, stopTime}]}, made from a CSV file.

const PRICES = '/Trunks/Prices/';
const pricePath = (id) => apiPath`/Trunks/Prices/${id}/`;

async function findPrice(client, ref) {
  return findRecord(
    (await client.call('GET', PRICES, undefined, SCOPE))?.records ?? [],
    ref,
    'price list',
    'wx-admin trunk prices',
    'name',
  );
}

function priceForm(ctx, name, file, extra = {}) {
  const form = new FormData();
  form.append('name', name);
  if (file) {
    const data = readForUpload(path.resolve(ctx.cwd ?? process.cwd(), file), ctx.env);
    form.append('upload', new Blob([data], {type: 'text/csv'}), path.basename(file));
  }
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

const priceLine = (p) => `${p.name} (id ${p.id}) · ${(p.items ?? []).length} rates`;

// ---------------------------------------------------------------------------------------------------------------------

const TYPE = {type: 'string', choices: KINDS, description: 'the kind of trunk'};
const SHOW = {
  'show-secrets': {type: 'boolean', description: 'show the passwords in the JSON (masked otherwise; never in text)'},
};

export const groups = {
  trunk: {
    summary: 'trunks (SIP, PSTN, FXO), trunk groups and price lists: list, show, create, change, delete',
    commands: {
      list: {
        summary: 'the trunks of the PBX: kind, name, host, dialplan, registration',
        usage: 'wx-admin trunk list [--type sip|pstn|fxo] [--show-secrets]',
        details:
          'JSON: the answer of the PBX for one --type, else {sip, pstn, fxo} lists. Passwords are masked unless --show-secrets.',
        options: {type: TYPE, ...SHOW},
        args: [0, 0],
        async run(ctx) {
          const client = await pbxClient(ctx);
          if (ctx.values.type)
            return shown(ctx, await client.call('GET', LIST_PATH[ctx.values.type], undefined, SCOPE));
          const out = {};
          for (const k of KINDS) out[k] = await listKind(client, k);
          return shown(ctx, out);
        },
        text: (r, ctx) => {
          const rows = r.records
            ? r.records.map((t) => row(ctx.values.type, t))
            : KINDS.flatMap((k) => (r[k] ?? []).map((t) => row(k, t)));
          return rows.length ? table(rows) : 'No trunks';
        },
      },
      get: {
        summary: 'one trunk and its settings (passwords never in text)',
        usage: 'wx-admin trunk get <trunk> [--type sip|pstn|fxo] [--show-secrets]',
        details: 'A trunk is its id, title or name. The JSON (with a `kind`) is what trunk update --from takes.',
        options: {type: TYPE, ...SHOW},
        args: [1, 1],
        async run(ctx) {
          const {kind, trunk} = await findTrunk(await pbxClient(ctx), ctx.positionals[0], ctx.values.type);
          return shown(ctx, {kind, ...trunk});
        },
        text: trunkLines,
      },
      create: {
        summary: 'create a SIP trunk',
        usage:
          'wx-admin trunk create <title> --host HOST --user LOGIN [--secret] [--port N] [--context DIALPLAN] [--transport udp|tcp|tls] [--register] [--from FILE]',
        details: [
          'The password is typed hidden, or read from the first line of stdin: never an argument.',
          '--from reads a trunk as JSON (trunk get --output json of another one, without its secrets); the options win.',
          'Every other setting is what WMS gives a new trunk.',
        ].join('\n'),
        options: {
          ...SIP_OPTIONS,
          register: {type: 'boolean', description: 'register the PBX to the carrier (outgoing registration)'},
          from: {type: 'string', placeholder: 'FILE', description: 'the trunk as JSON (a file)'},
        },
        args: [1, 1],
        async run(ctx) {
          const v = ctx.values;
          const title = ctx.positionals[0];
          if (!/^\S(.{0,98}\S)?$/.test(title)) throw new UsageError(`A trunk needs a title: ${JSON.stringify(title)}`);
          const src = v.from ? await readJsonInput(ctx, v.from) : {};
          if (src.kind && src.kind !== 'sip')
            throw new UsageError(`Only SIP trunks are created; the file holds a ${src.kind} trunk`);
          // Masked passwords of the file are left empty: the trunk's own one must be given.
          if (JSON.stringify(src).includes(MASK) && !v.secret)
            throw new UsageError('The file holds masked passwords: give the password with --secret');
          const body = merged(sipTemplate(), src);
          body.title = title;
          body.register = typeof src.register === 'string' && src.register !== MASK ? src.register : '';
          await applySipOptions(ctx, body);
          if (v.context !== undefined) body.settingsPbx.context = checkContext(v.context);
          if (v.register) body.settingsWms.enableReg = true;
          if (!body.settingsPbx.host)
            throw new UsageError('--host is needed (dynamic: the carrier registers to the PBX)', ctx.usage());
          if (!body.name) throw new UsageError('--user is needed (the login of the trunk)', ctx.usage());
          const client = await pbxClient(ctx);
          await client.call('POST', LIST_PATH.sip, body, SCOPE);
          const made = (await listKind(client, 'sip')).find((t) => t.name === body.name && t.title === title);
          return shown(ctx, {kind: 'sip', ...(made ?? {title, name: body.name})});
        },
        text: (r, ctx) => [
          `Created SIP trunk ${r.title}${r.id !== undefined ? ` (id ${r.id})` : ''}`,
          ...(r.settingsPbx ? trunkLines(r, ctx).slice(1) : []),
        ],
      },
      update: {
        summary: 'change a trunk (needs --yes: a wrong setting stops its calls)',
        usage:
          'wx-admin trunk update <trunk> [--type sip|pstn|fxo] [--title TEXT] [--context DIALPLAN] [--host HOST] [--port N] [--user LOGIN] [--transport udp|tcp|tls] [--secret] [--from FILE] --yes',
        details: [
          '--host, --port, --user, --transport and --secret are for SIP trunks; --context for SIP and PSTN (FXO: per port, with --from).',
          '--from reads the fields to change as JSON (trunk get --output json, edited); masked passwords in it are kept as they are.',
          'The trunk is written whole: what is not changed stays.',
        ].join('\n'),
        options: {
          type: TYPE,
          title: {type: 'string', placeholder: 'TEXT', description: 'the new title'},
          ...SIP_OPTIONS,
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'the fields to change as JSON (a file, or - for stdin)',
          },
          yes: {type: 'boolean', description: 'yes, change the trunk'},
          ...SHOW,
        },
        args: [1, 1],
        async run(ctx) {
          const v = ctx.values;
          const sipOnly = ['host', 'port', 'user', 'transport', 'secret'].filter(
            (k) => v[k] !== undefined && v[k] !== false,
          );
          if (v.title === undefined && v.context === undefined && !v.from && !sipOnly.length)
            throw new UsageError('Nothing to change', ctx.usage());
          if (!v.yes)
            throw new UsageError(
              'Changing a trunk can stop the calls that go through it: confirm with --yes',
              ctx.usage(),
            );
          // A new host with the old password would send that password to the new host.
          if (v.host !== undefined && !v.secret)
            throw new UsageError(
              'A new --host needs the password for it too: add --secret (the current one is not sent to another host)',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const {kind, trunk} = await findTrunk(client, ctx.positionals[0], v.type);
          if (sipOnly.length && kind !== 'sip')
            throw new UsageError(
              `--${sipOnly[0]} is for SIP trunks; ${trunk.title ?? trunk.id} is ${KIND_NAME[kind]}: use --from`,
            );
          if (v.context !== undefined && kind === 'fxo')
            throw new UsageError('An FXO trunk has a dialplan per port: use --from with settingsMgw.ports');
          const src = v.from ? await readJsonInput(ctx, v.from) : {};
          if (src.kind && src.kind !== kind)
            throw new UsageError(`The file holds a ${src.kind} trunk; ${trunk.title ?? trunk.id} is ${kind}`);
          const body = merged(trunk, src);
          if (v.title !== undefined) body.title = v.title;
          if (kind === 'sip') await applySipOptions(ctx, body);
          if (v.context !== undefined) {
            body.settingsPbx = {...(body.settingsPbx ?? {}), context: checkContext(v.context)};
          }
          await client.call('PUT', trunkPath[kind](trunk.id), body, SCOPE);
          return shown(ctx, {kind, ...body});
        },
        text: (r, ctx) => [
          `Updated ${KIND_NAME[r.kind]} trunk ${r.title ?? trunkName(r)} (id ${r.id})`,
          ...trunkLines(r, ctx).slice(1),
        ],
      },
      delete: {
        summary: 'delete a SIP trunk (needs --yes: its calls stop)',
        usage: 'wx-admin trunk delete <trunk> --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete it'}},
        args: [1, 1],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'Deleting a trunk stops the calls that go through it: confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const {trunk} = await findTrunk(client, ctx.positionals[0], 'sip');
          await client.call('DELETE', trunkPath.sip(trunk.id), undefined, SCOPE);
          return {deleted: {id: trunk.id, title: trunk.title, name: trunk.name}};
        },
        text: (r) => `Deleted SIP trunk ${r.deleted.title} (id ${r.deleted.id})`,
      },
      groups: {
        summary: 'the trunk groups (trunks tried in order for outgoing calls)',
        usage: 'wx-admin trunk groups [<group>]',
        details: 'With a group (its id or name): its trunks in order.',
        options: {},
        args: [0, 1],
        async run(ctx) {
          const r = await (await pbxClient(ctx)).call('GET', GROUPS, undefined, SCOPE);
          return ctx.positionals[0]
            ? findRecord(r?.records ?? [], ctx.positionals[0], 'trunk group', 'wx-admin trunk groups', 'name')
            : r;
        },
        text: (r) =>
          r.records
            ? r.records.length
              ? table(
                  r.records.map((g) => [
                    g.id,
                    g.name,
                    oneLine((g.rules ?? []).map(ruleText).join(' → '), 70),
                    g.description ?? '',
                  ]),
                )
              : 'No trunk groups'
            : groupLines(r),
      },
      'group-create': {
        summary: 'create a trunk group',
        usage: 'wx-admin trunk group-create <name> --trunk SPEC... [--description TEXT]',
        details: RULE_HELP,
        options: {
          trunk: {
            type: 'string',
            multiple: true,
            placeholder: 'SPEC',
            description: 'a trunk of the group and its number changes',
          },
          description: {type: 'string', placeholder: 'TEXT', description: 'what the group is for'},
        },
        args: [1, 1],
        async run(ctx) {
          const name = ctx.positionals[0];
          if (!GROUP_NAME.test(name)) throw new UsageError(`A trunk group name is letters, digits and _: ${name}`);
          if (!ctx.values.trunk?.length)
            throw new UsageError('Give the trunks of the group: --trunk NAME', ctx.usage());
          const body = {name, description: ctx.values.description ?? '', rules: ctx.values.trunk.map(parseRule)};
          const client = await pbxClient(ctx);
          await noteUnknownTrunks(ctx, client, body.rules);
          await client.call('POST', GROUPS, body, SCOPE);
          return (
            ((await client.call('GET', GROUPS, undefined, SCOPE))?.records ?? []).find((g) => g.name === name) ?? body
          );
        },
        text: (g) => [`Created trunk group ${groupLines(g)[0]}`, ...groupLines(g).slice(1)],
      },
      'group-update': {
        summary: 'change a trunk group: name, description, trunks (--trunk replaces them all)',
        usage: 'wx-admin trunk group-update <group> [--name NAME] [--description TEXT] [--trunk SPEC]... [--yes]',
        details: RULE_HELP,
        options: {
          name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
          description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
          trunk: {
            type: 'string',
            multiple: true,
            placeholder: 'SPEC',
            description: 'the trunks of the group, in order (they replace all of them)',
          },
          yes: {type: 'boolean', description: 'yes, replace the trunks of the group'},
        },
        args: [1, 1],
        async run(ctx) {
          const v = ctx.values;
          if (v.name === undefined && v.description === undefined && !v.trunk?.length)
            throw new UsageError('Nothing to change', ctx.usage());
          if (v.trunk?.length && !v.yes)
            throw new UsageError('--trunk replaces every outgoing route of the group: confirm with --yes', ctx.usage());
          const client = await pbxClient(ctx);
          const current = findRecord(
            (await client.call('GET', GROUPS, undefined, SCOPE))?.records ?? [],
            ctx.positionals[0],
            'trunk group',
            'wx-admin trunk groups',
            'name',
          );
          const body = {
            name: v.name ?? current.name,
            description: v.description ?? current.description ?? '',
            rules: v.trunk?.length ? v.trunk.map(parseRule) : (current.rules ?? []).map(groupRule),
          };
          if (!GROUP_NAME.test(body.name))
            throw new UsageError(`A trunk group name is letters, digits and _: ${body.name}`);
          if (v.trunk?.length) await noteUnknownTrunks(ctx, client, body.rules);
          await client.call('PUT', groupPath(current.id), body, SCOPE);
          return {id: current.id, ...body};
        },
        text: (g) => [`Updated trunk group ${groupLines(g)[0]}`, ...groupLines(g).slice(1)],
      },
      'group-delete': {
        summary: 'delete trunk groups (needs --yes: dialplans that dial them fail)',
        usage: 'wx-admin trunk group-delete <group>... --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete them'}},
        args: [1, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'Deleting a trunk group stops the calls the dialplans send to it: confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const records = (await client.call('GET', GROUPS, undefined, SCOPE))?.records ?? [];
          const found = ctx.positionals.map((ref) =>
            findRecord(records, ref, 'trunk group', 'wx-admin trunk groups', 'name'),
          );
          for (const g of found) await client.call('DELETE', groupPath(g.id), undefined, SCOPE);
          return {deleted: found.map(({id, name}) => ({id, name}))};
        },
        text: (r) =>
          `Deleted trunk ${r.deleted.length === 1 ? 'group' : 'groups'} ${r.deleted.map((g) => `${g.name} (id ${g.id})`).join(', ')}`,
      },
      prices: {
        summary: 'the price lists of the trunks (call costs); with one, its rates',
        usage: 'wx-admin trunk prices [<pricelist>]',
        details: 'A price list is its id or its name.',
        options: {},
        args: [0, 1],
        async run(ctx) {
          const client = await pbxClient(ctx);
          return ctx.positionals[0]
            ? findPrice(client, ctx.positionals[0])
            : client.call('GET', PRICES, undefined, SCOPE);
        },
        text: (r) => {
          if (r.records)
            return r.records.length
              ? table(r.records.map((p) => [p.id, p.name, `${(p.items ?? []).length} rates`]))
              : 'No price lists';
          const rates = (r.items ?? []).map((i) => [
            i.dialprefix,
            i.destination,
            i.rate,
            `min ${i.minDuration}s`,
            `block ${i.billingBlock}s`,
            `connect ${i.connectCharge}`,
            `days ${i.startDay}-${i.stopDay}`,
            `${i.startTime}-${i.stopTime}`,
          ]);
          return [priceLine(r), ...(rates.length ? table(rates) : ['no rates'])];
        },
      },
      'price-create': {
        summary: 'create a price list from a CSV file (the format of price-export)',
        usage: 'wx-admin trunk price-create <name> --file CSV',
        details:
          'The CSV columns: dialprefix, destination, rate, min_duration, billing_block, connect_charge, start_day, stop_day, start_time, stop_time.',
        options: {file: {type: 'string', placeholder: 'CSV', description: 'the rates as CSV'}},
        args: [1, 1],
        async run(ctx) {
          const name = ctx.positionals[0];
          if (!/^\S(.{0,98}\S)?$/.test(name))
            throw new UsageError(`A price list needs a name: ${JSON.stringify(name)}`);
          if (!ctx.values.file) throw new UsageError('--file is needed', ctx.usage());
          const form = priceForm(ctx, name, ctx.values.file);
          return (await pbxClient(ctx)).request('POST', PRICES, {data: form, ...SCOPE});
        },
        text: (p) => `Created price list ${priceLine(p)}`,
      },
      'price-update': {
        summary: 'rename a price list, or replace its rates from a CSV file',
        usage: 'wx-admin trunk price-update <pricelist> [--name NAME] [--file CSV]',
        options: {
          name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
          file: {type: 'string', placeholder: 'CSV', description: 'the new rates as CSV (they replace all of them)'},
        },
        args: [1, 1],
        async run(ctx) {
          const v = ctx.values;
          if (v.name === undefined && !v.file)
            throw new UsageError('Nothing to change: give --name or --file', ctx.usage());
          const client = await pbxClient(ctx);
          const current = await findPrice(client, ctx.positionals[0]);
          const form = priceForm(ctx, v.name ?? current.name, v.file, {method: 'PUT'});
          return client.request('POST', pricePath(current.id), {data: form, ...SCOPE});
        },
        text: (p) => `Updated price list ${priceLine(p)}`,
      },
      'price-delete': {
        summary: 'delete price lists (needs --yes)',
        usage: 'wx-admin trunk price-delete <pricelist>... --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete them'}},
        args: [1, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'Deleting a price list loses its rates (export it first): confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const found = [];
          for (const ref of ctx.positionals) found.push(await findPrice(client, ref));
          for (const p of found) await client.call('DELETE', pricePath(p.id), undefined, SCOPE);
          return {deleted: found.map(({id, name}) => ({id, name}))};
        },
        text: (r) =>
          `Deleted price ${r.deleted.length === 1 ? 'list' : 'lists'} ${r.deleted.map((p) => `${p.name} (id ${p.id})`).join(', ')}`,
      },
      'price-export': {
        summary: 'a price list as CSV (to stdout, or to a new file)',
        usage: 'wx-admin trunk price-export <pricelist> [--to FILE]',
        options: {
          to: {type: 'string', placeholder: 'FILE', description: 'write it to this file (which must not exist)'},
        },
        args: [1, 1],
        async run(ctx) {
          const client = await pbxClient(ctx);
          // The PBX exports any id (a header only for one it does not have): find it first.
          const p = await findPrice(client, ctx.positionals[0]);
          const csv = await client.request('GET', apiPath`/Trunks/Prices/${p.id}/export`, {
            responseType: 'buffer',
            ...SCOPE,
          });
          const data = Buffer.isBuffer(csv) ? csv : Buffer.from(typeof csv === 'string' ? csv : JSON.stringify(csv));
          if (!ctx.values.to) return {id: p.id, name: p.name, csv: data.toString('utf8')};
          const file = path.resolve(ctx.cwd ?? process.cwd(), ctx.values.to);
          refuseUnsafeWrite(file, ctx.env);
          try {
            fs.writeFileSync(file, data, {flag: 'wx'});
          } catch (e) {
            if (e.code === 'EEXIST')
              throw new UsageError(`${ctx.values.to} exists: choose another file (nothing was overwritten)`);
            throw e;
          }
          return {id: p.id, name: p.name, file, bytes: data.length};
        },
        text: (r) =>
          r.file ? `Exported ${r.name} (id ${r.id}, ${r.bytes} bytes) to ${r.file}` : r.csv.replace(/\n$/, ''),
      },
    },
  },
};
