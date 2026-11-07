// wx-admin user: the users (colleagues) of a PBX, their presence and SIP registrations, the user groups and the
// departments, over the PBX REST API. Operations used:
//   GET/POST /PBX/Colleagues/, GET/PUT/DELETE /PBX/Colleagues/{id}/, PUT /PBX/Colleagues/{id}/preferences/ (colleagues)
//   PUT /PBX/presence/ (colleagues: the batch of the administrators), GET /User/{extension}/Presence/ (pbx)
//   GET /PBX/Users/Sip/Registrations, GET /PBX/Users/{extensions}/Sip/Registrations (pbx)
//   GET /Groups/ (pbx), GET /Departments/ (info)
// The model of the API: a user is {id, extension, name, email, officePhone, mobilePhone, faxNumber, role, licenseType,
// groupDn, groupName, department, language, dialplan, faxDialplan, login, jid, …}; id is the LDAP uid (a number as a
// string), groupDn names the user group (an ACL group: gid=…). Filters of the list are exact matches on a field
// (filter[field][]=value); `search` looks into every field. The PBX never returns passwords; a password given in a
// --from file is sent and never printed.
//
// Live checks (WMS 7.x test PBX): GET /Groups/ answers {total, records} (the OpenAPI says an array);
// GET /PBX/Users/…/Sip/Registrations answers [] when nobody is registered (an object by extension otherwise);
// fields=groupName works although the OpenAPI does not list it; filter[email][] ignores the case.
import {readJsonInput as readJsonFile} from 'wldx-core/files';
import {UsageError} from 'wldx-core/errors';
import {localTime, oneLine, paint, table} from 'wldx-core/format';
import {apiPath, query} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';

const SCOPE = 'colleagues';
export const ROLES = ['admin', 'user', 'fax', 'park_orbit', 'room'];
export const LICENSES = ['basic', 'essential', 'business', 'premium', 'wizyconf'];
const SORTS = ['extension', 'name', 'email', 'role', 'department', 'licenseType', 'groupDn', 'id'];
const PRESENCES = ['available', 'away', 'dnd', 'mur'];
// What `user delete --also` may remove with the user (data[] of DELETE /PBX/Colleagues/{id}/).
export const DELETE_DATA = [
  'userAvatar',
  'personalData',
  'voicemails',
  'voicemailGreetings',
  'calls',
  'chatHistory',
  'phonebooks',
  'callGroupMember',
  'missedCallManager',
  'pagingGroupMember',
  'applications',
  'devices',
];
// The fields a list asks for without --full: no e-mail, phone or picture of other people.
const LIST_FIELDS = 'id,extension,name,role,licenseType,groupName,groupDn,department,language,dialplan';
const SECRETS = ['password', 'sipPassword'];

const withoutSecrets = (u) =>
  u && typeof u === 'object' ? Object.fromEntries(Object.entries(u).filter(([k]) => !SECRETS.includes(k))) : u;

async function readJsonInput(ctx, from) {
  const data = await readJsonFile(ctx, from); // no credentials, nothing hidden in the home folder
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new UsageError('--from holds one JSON object of user fields');
  return data;
}

// A user by extension, id, e-mail or exact name: the record of the PBX (all its fields).
async function findUser(client, ref) {
  const s = String(ref).trim();
  const by = (field) =>
    client.call('GET', `/PBX/Colleagues/${query({[`filter[${field}][]`]: s})}`, undefined, {scope: SCOPE});
  let found = [];
  if (s.includes('@')) found = (await by('email'))?.records ?? [];
  else if (/^\d+$/.test(s)) {
    found = (await by('extension'))?.records ?? [];
    if (!found.length) {
      try {
        found = [await client.call('GET', apiPath`/PBX/Colleagues/${s}/`, undefined, {scope: SCOPE})];
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
  } else if (s) found = (await by('name'))?.records ?? [];
  if (!found.length) throw new UsageError(`No user ${s} on this PBX (wx-admin user list --search TEXT)`);
  if (found.length > 1)
    throw new UsageError(
      `${found.length} users match ${s}: give the extension (${found.map((u) => u.extension).join(', ')})`,
    );
  return found[0];
}

// The DN of a user group from its name, id or DN.
async function groupDn(client, ref) {
  const s = String(ref).trim();
  if (/^gid=\d+,/.test(s)) return s;
  const r = await client.call('GET', '/Groups/', undefined, {scope: 'pbx'});
  const groups = Array.isArray(r) ? r : (r?.records ?? []);
  const g =
    groups.find((x) => x.id === s || x.name === s) ??
    groups.find((x) => String(x.name).toLowerCase() === s.toLowerCase());
  if (!g) throw new UsageError(`No user group ${s} (wx-admin user groups)`);
  return g.dn;
}

// The fields of create and update: the option, the API field, a check.
const FIELDS = {
  extension: {field: 'extension', check: /^\d{2,50}$/, says: 'digits (2 to 50)'},
  name: {field: 'name', check: /^[\p{L}\p{M}\p{N} _-]{2,50}$/u, says: 'letters, digits, spaces, - and _ (2 to 50)'},
  email: {field: 'email', check: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, says: 'an e-mail address'},
  role: {field: 'role'},
  license: {field: 'licenseType'},
  department: {field: 'department', check: /^[^@&<>]{1,250}$/, says: 'up to 250 characters without @ & < >'},
  language: {field: 'language', check: /^[a-z]{2}(-[a-z]{2})?$/i, says: 'a language code: en, it, fr, en-us…'},
  dialplan: {field: 'dialplan', check: /^[A-Za-z0-9_-]{1,64}$/, says: 'a dialplan name'},
  'fax-dialplan': {field: 'faxDialplan', check: /^[A-Za-z0-9_-]{1,64}$/, says: 'a dialplan name'},
  'office-phone': {field: 'officePhone', check: /^\+?[\d ()-]{2,50}$/, says: 'a phone number'},
  'mobile-phone': {field: 'mobilePhone', check: /^\+?[\d ()-]{2,50}$/, says: 'a phone number'},
  'fax-number': {field: 'faxNumber', check: /^\+?[\d ()-]{2,50}$/, says: 'a phone number'},
  login: {field: 'login', check: /^[A-Za-z0-9._-]{2,50}$/, says: 'letters, digits, . _ - (2 to 50)'},
};
const BY_FIELD = Object.fromEntries(Object.entries(FIELDS).map(([opt, f]) => [f.field, {...f, opt}]));

const fieldOptions = (verb) => ({
  extension: {type: 'string', placeholder: 'N', description: `${verb} extension (digits)`},
  name: {type: 'string', placeholder: 'NAME', description: `${verb} full name`},
  email: {type: 'string', placeholder: 'EMAIL', description: `${verb} e-mail (notifications, x-bees login)`},
  role: {type: 'string', choices: ROLES, description: `${verb} role`},
  license: {type: 'string', choices: LICENSES, description: `${verb} license type`},
  group: {
    type: 'string',
    placeholder: 'GROUP',
    description: `${verb} user group: its name, id or DN (wx-admin user groups)`,
  },
  department: {type: 'string', placeholder: 'NAME', description: `${verb} department`},
  language: {type: 'string', placeholder: 'CODE', description: `${verb} language: en, it, fr, de, en-us…`},
  dialplan: {type: 'string', placeholder: 'NAME', description: `${verb} dialplan of the calls the user makes`},
  'fax-dialplan': {type: 'string', placeholder: 'NAME', description: `${verb} dialplan of the faxes`},
  'office-phone': {type: 'string', placeholder: 'NUMBER', description: `${verb} office phone number`},
  'mobile-phone': {type: 'string', placeholder: 'NUMBER', description: `${verb} mobile phone number`},
  'fax-number': {type: 'string', placeholder: 'NUMBER', description: `${verb} fax number`},
  login: {type: 'string', placeholder: 'NAME', description: `${verb} login name`},
  from: {
    type: 'string',
    placeholder: 'FILE',
    description: 'more fields as JSON, as the API names them (a file, or - for stdin); options win',
  },
});

// The body of POST/PUT /PBX/Colleagues from --from and the options, checked; the group resolved to its DN.
async function userBody(ctx, client) {
  const src = ctx.values.from ? await readJsonInput(ctx, ctx.values.from) : {};
  const body = {...src};
  for (const [opt, f] of Object.entries(FIELDS)) if (ctx.values[opt] !== undefined) body[f.field] = ctx.values[opt];
  for (const [field, value] of Object.entries(body)) {
    if (SECRETS.includes(field) || field === 'groupDn') continue;
    const f = BY_FIELD[field];
    if (typeof value !== 'string') throw new UsageError(`${field} is a string`);
    if (field === 'role' && !ROLES.includes(value))
      throw new UsageError(`role is one of ${ROLES.join(', ')}: ${value}`);
    if (field === 'licenseType' && !LICENSES.includes(value))
      throw new UsageError(`licenseType is one of ${LICENSES.join(', ')}: ${value}`);
    if (f?.check && !f.check.test(value)) throw new UsageError(`--${f.opt} is ${f.says}: ${value}`);
  }
  for (const k of SECRETS)
    if (body[k] !== undefined && (typeof body[k] !== 'string' || body[k].length < 8))
      throw new UsageError(`${k} in --from is too short`);
  const group = ctx.values.group ?? (body.groupDn && !/^gid=/.test(body.groupDn) ? body.groupDn : undefined);
  if (group !== undefined) body.groupDn = await groupDn(client, group);
  return body;
}

const userTitle = (u) => `${u.name ?? ''} (ext ${u.extension ?? '?'}, id ${u.id ?? '?'})`;

function userLines(u) {
  const pairs = [
    ['role', u.role],
    ['license', u.licenseType],
    ['group', u.groupName],
    ['department', u.department],
    ['e-mail', u.email],
    ['office phone', u.officePhone],
    ['mobile phone', u.mobilePhone],
    ['fax number', u.faxNumber],
    ['language', u.language],
    ['dialplan', u.dialplan],
    ['fax dialplan', u.faxDialplan],
    ['login', u.login],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  return [userTitle(u), ...table(pairs.map(([k, v]) => [`  ${k}`, v]))];
}

// "19/09/2017 11:30" in UTC, as the presence API wants it, from "YYYY-MM-DD HH:MM" (local time) or "+30m", "+2h", "+1d".
export function presenceUntil(value, now) {
  const s = String(value).trim();
  let t;
  const rel = /^\+(\d+)([mhd])$/.exec(s);
  if (rel) t = new Date(now + Number(rel[1]) * {m: 60_000, h: 3_600_000, d: 86_400_000}[rel[2]]);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(s)) t = new Date(s.replace(' ', 'T'));
  if (!t || Number.isNaN(t.getTime()))
    throw new UsageError(`--until is "YYYY-MM-DD HH:MM" (local time) or +30m, +2h, +1d: ${value}`);
  if (t.getTime() <= now) throw new UsageError(`--until is in the past: ${value}`);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

const EXTENSION = /^\d{1,50}$/;
const checkExtensions = (list) => {
  for (const e of list) if (!EXTENSION.test(e)) throw new UsageError(`Not an extension: ${e}`);
  return list;
};

// The extension of a user ref: digits are taken as an extension, anything else is looked up.
const extensionOf = async (client, ref) =>
  EXTENSION.test(String(ref)) ? String(ref) : (await findUser(client, ref)).extension;

// A PBX answer {type: 'warning', reason, warnings: {extension: reason}} (copy-preferences, presence): the warnings.
const warningsOf = (r) =>
  r && typeof r === 'object' && r.type === 'warning' ? {reason: r.reason, warnings: r.warnings ?? {}} : undefined;

const warningLines = (w, ctx) => {
  if (!w) return [];
  const c = paint(ctx);
  return [
    c.yellow(`Warning: ${w.reason ?? 'not everything was done'}`),
    ...Object.entries(w.warnings ?? {}).map(([k, v]) => c.yellow(`  ${k}: ${oneLine(v, 100)}`)),
  ];
};

const deviceState = (s) => (s ? String(s).replace(/_/g, ' ') : '');

export const groups = {
  user: {
    summary:
      'users (colleagues): list, show, create, change, delete, copy preferences, presence, SIP registrations, groups, departments',
    commands: {
      list: {
        summary: 'the users of the PBX, with filters',
        usage:
          'wx-admin user list [--search TEXT] [--group GROUP] [--department NAME] [--role ROLE] [--license TYPE] [--sort FIELD [--desc]] [--limit N] [--start N] [--full]',
        details:
          'Filters are exact (--department "Level 1"); --search looks into every field. E-mails and phones only with --full.',
        options: {
          search: {type: 'string', placeholder: 'TEXT', description: 'users with this text in any field'},
          group: {type: 'string', placeholder: 'GROUP', description: 'users of this user group: its name, id or DN'},
          department: {type: 'string', placeholder: 'NAME', description: 'users of this department (exact name)'},
          role: {type: 'string', choices: ROLES, description: 'users with this role'},
          license: {type: 'string', choices: LICENSES, description: 'users with this license type'},
          sort: {type: 'string', choices: SORTS, description: 'sort by this field (default: as the PBX gives them)'},
          desc: {type: 'boolean', description: 'sort in descending order'},
          limit: {type: 'string', placeholder: 'N', description: 'at most N users (default: all)'},
          start: {type: 'string', placeholder: 'N', description: 'skip the first N users (paging)'},
          full: {type: 'boolean', description: 'every field, e-mails and phones included'},
        },
        args: [0, 0],
        readOnly: true,
        async run(ctx) {
          const v = ctx.values;
          for (const k of ['limit', 'start'])
            if (v[k] !== undefined && !/^\d+$/.test(v[k])) throw new UsageError(`--${k} is a whole number: ${v[k]}`);
          if (v.desc && !v.sort) throw new UsageError('--desc goes with --sort');
          const client = await pbxClient(ctx);
          const q = {
            'filter[groupDn][]': v.group === undefined ? undefined : await groupDn(client, v.group),
            'filter[department][]': v.department,
            'filter[role][]': v.role,
            'filter[licenseType][]': v.license,
            search: v.search,
            sort: v.sort,
            dir: v.sort ? (v.desc ? 'desc' : 'asc') : undefined,
            count: v.limit,
            start: v.start,
            fields: v.full ? undefined : LIST_FIELDS,
          };
          const r = await client.call('GET', `/PBX/Colleagues/${query(q)}`, undefined, {scope: SCOPE});
          return {...r, records: (r?.records ?? []).map(withoutSecrets)};
        },
        text(r, ctx) {
          const records = r.records ?? [];
          if (!records.length) return 'No users';
          const full = ctx.values.full;
          const rows = records.map((u) => [
            u.extension,
            u.name,
            u.role,
            u.licenseType,
            u.groupName ?? '',
            u.department ?? '',
            ...(full ? [u.email ?? '', u.mobilePhone || u.officePhone || ''] : []),
          ]);
          const start = Number(ctx.values.start ?? 0);
          const more =
            r.total > start + records.length
              ? [
                  paint(ctx).dim(
                    `${records.length} of ${r.total} users: --start ${start + records.length} for the next ones`,
                  ),
                ]
              : [];
          return [...table(rows), ...more];
        },
      },
      get: {
        summary: 'one user: role, license, group, department, e-mail, phones, dialplan',
        usage: 'wx-admin user get <user>',
        details: 'A user is an extension, an id, an e-mail or the exact name.',
        options: {},
        args: [1, 1],
        readOnly: true,
        async run(ctx) {
          return withoutSecrets(await findUser(await pbxClient(ctx), ctx.positionals[0]));
        },
        text: (u) => userLines(u),
      },
      create: {
        summary: 'create a user (it takes a license; the PBX may send the user a welcome e-mail)',
        usage:
          'wx-admin user create --extension N --name NAME --license TYPE [--email EMAIL] [--role ROLE] [--group GROUP] [--department NAME] [... | --from FILE|-]',
        details: [
          'Needs an extension, a name and a license type (from the options or --from).',
          'A new user takes a license of that type from the PBX, and with an e-mail the PBX may send the user a welcome',
          'e-mail with the access to x-bees/Collaboration. Passwords are never options: put password and sipPassword in',
          'a --from file if you must set them (else the PBX generates them).',
        ].join('\n'),
        options: fieldOptions('the'),
        args: [0, 0],
        async run(ctx) {
          const client = await pbxClient(ctx);
          const body = await userBody(ctx, client);
          const missing = ['extension', 'name', 'licenseType'].filter((k) => !body[k]);
          if (missing.length)
            throw new UsageError(
              `A new user needs ${missing.map((k) => `--${BY_FIELD[k].opt}`).join(', ')}`,
              ctx.usage(),
            );
          return withoutSecrets(await client.call('POST', '/PBX/Colleagues/', body, {scope: SCOPE}));
        },
        text: (u) => [`Created ${userTitle(u)}`],
      },
      update: {
        summary: 'change fields of a user (only the ones given)',
        usage:
          'wx-admin user update <user> [--name NAME] [--email EMAIL] [--role ROLE] [--license TYPE] [--group GROUP] [... | --from FILE|-] [--transfer-chats]',
        details:
          'A user is an extension, an id, an e-mail or the exact name. --transfer-chats moves the x-bees/Collaboration chats to the new e-mail.',
        options: {
          ...fieldOptions('the new'),
          'transfer-chats': {type: 'boolean', description: 'with a new e-mail: move the chats of the user to it'},
        },
        args: [1, 1],
        async run(ctx) {
          const client = await pbxClient(ctx);
          const body = await userBody(ctx, client);
          if (!Object.keys(body).length) throw new UsageError('Nothing to change: give a field to change', ctx.usage());
          const user = await findUser(client, ctx.positionals[0]);
          const q = query({transferRnaChats: ctx.values['transfer-chats'] ? 'true' : undefined});
          return withoutSecrets(
            await client.call('PUT', `${apiPath`/PBX/Colleagues/${user.id}/`}${q}`, body, {scope: SCOPE}),
          );
        },
        text: (u) => [`Updated ${userTitle(u)}`],
      },
      delete: {
        summary: 'delete users (needs --yes: it cannot be undone); --also removes their data too',
        usage: 'wx-admin user delete <user>... --yes [--also ITEM]...',
        details: `--also takes: ${DELETE_DATA.join(', ')}.`,
        options: {
          yes: {type: 'boolean', description: 'yes, delete them'},
          also: {
            type: 'string',
            multiple: true,
            choices: DELETE_DATA,
            description: 'remove this data of the users too',
          },
        },
        args: [1, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'Deleting a user cannot be undone: their calls stop and the license is freed. Confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const users = [];
          for (const ref of ctx.positionals) users.push(await findUser(client, ref));
          // data[] names what goes: the user always, and what --also adds (as the WMS dialog sends it).
          const q = query({'data[]': ['user', ...new Set(ctx.values.also ?? [])]});
          const deleted = [];
          for (const u of users) {
            await client.call('DELETE', `${apiPath`/PBX/Colleagues/${u.id}/`}${q}`, undefined, {scope: SCOPE});
            deleted.push({id: u.id, extension: u.extension, name: u.name});
          }
          return {deleted};
        },
        text: (r) => r.deleted.map((u) => `Deleted ${userTitle(u)}`),
      },
      'copy-preferences': {
        summary: 'copy the preferences of one user to others (needs --yes: theirs are overwritten)',
        usage: 'wx-admin user copy-preferences <from> <to>... --yes',
        details: 'Users are extensions, ids, e-mails or exact names.',
        options: {yes: {type: 'boolean', description: 'yes, overwrite their preferences'}},
        args: [2, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'The preferences of the target users are overwritten and cannot be restored: confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const [fromRef, ...toRefs] = ctx.positionals;
          const from = await findUser(client, fromRef);
          const targets = [];
          for (const ref of toRefs) targets.push(await findUser(client, ref));
          if (targets.some((t) => t.id === from.id))
            throw new UsageError(`${fromRef} is the source: it cannot be a target too`);
          const copied = [];
          for (const t of targets) {
            const r = await client.call(
              'PUT',
              apiPath`/PBX/Colleagues/${t.id}/preferences/`,
              {from: String(from.id)},
              {scope: SCOPE},
            );
            copied.push({
              id: t.id,
              extension: t.extension,
              name: t.name,
              ...(warningsOf(r) ? {warning: warningsOf(r)} : {}),
            });
          }
          return {from: {id: from.id, extension: from.extension, name: from.name}, to: copied};
        },
        text: (r, ctx) =>
          r.to.flatMap((t) => [
            `Copied the preferences of ${userTitle(r.from)} to ${userTitle(t)}`,
            ...warningLines(t.warning, ctx),
          ]),
      },
      presence: {
        summary: 'the presence of users: online, status, message, until when, what their phone does',
        usage: 'wx-admin user presence <user>... [--full]',
        details: 'A user is an extension (or an id, an e-mail, a name, looked up). Their location only with --full.',
        options: {full: {type: 'boolean', description: 'the location the users shared too'}},
        args: [1, 50],
        readOnly: true,
        async run(ctx) {
          const client = await pbxClient(ctx);
          const out = [];
          for (const ref of ctx.positionals) {
            const extension = await extensionOf(client, ref);
            const p = await client.call('GET', apiPath`/User/${extension}/Presence/`, undefined, {scope: 'pbx'});
            const {location, ...rest} = p ?? {};
            out.push({extension, ...rest, ...(ctx.values.full && location ? {location} : {})});
          }
          return {presence: out};
        },
        text(r, ctx) {
          const c = paint(ctx);
          return table(
            r.presence.map((p) => [
              p.extension,
              p.online ? c.green('online') : c.dim('offline'),
              p.show || (p.online ? 'available' : ''),
              deviceState(p.device_show),
              p.status ? oneLine(p.status, 50) : '',
              p.until
                ? `until ${localTime(
                    String(p.until)
                      .replace(' ', 'T')
                      .replace(/\+00:00$/, 'Z'),
                  )}`
                : '',
              ...(p.location?.address ? [oneLine(p.location.address, 60)] : []),
            ]),
          );
        },
      },
      'presence-set': {
        summary: 'set the presence of users (what their colleagues see): available, away, dnd, mur',
        usage:
          'wx-admin user presence-set <extension>... --status STATUS [--message TEXT] [--until "YYYY-MM-DD HH:MM"|+2h]',
        details:
          'mur: "make up room" (hotels). --until is local time, or +30m, +2h, +1d from now; without it the status stays until changed.',
        options: {
          status: {type: 'string', choices: PRESENCES, description: 'the new status'},
          message: {type: 'string', placeholder: 'TEXT', description: 'the status message'},
          until: {
            type: 'string',
            placeholder: 'TIME',
            description: 'until when: "YYYY-MM-DD HH:MM" (local) or +30m, +2h, +1d',
          },
        },
        args: [1, 100],
        async run(ctx) {
          const v = ctx.values;
          if (!v.status) throw new UsageError('--status is needed', ctx.usage());
          const extensions = checkExtensions(ctx.positionals.map(String));
          const until = v.until === undefined ? undefined : presenceUntil(v.until, ctx.clock());
          const items = extensions.map((extension) => ({
            extension,
            status: v.status,
            ...(v.message !== undefined ? {message: v.message} : {}),
            ...(until ? {until} : {}),
          }));
          const r = await (await pbxClient(ctx)).call('PUT', '/PBX/presence/', {items}, {scope: SCOPE});
          return {items, ...(warningsOf(r) ? {warning: warningsOf(r)} : {})};
        },
        text: (r, ctx) => [
          `Presence of ${r.items.map((i) => i.extension).join(', ')}: ${r.items[0].status}${r.items[0].message ? ` (${oneLine(r.items[0].message, 60)})` : ''}${r.items[0].until ? ` until ${r.items[0].until} UTC` : ''}`,
          ...warningLines(r.warning, ctx),
        ],
      },
      registrations: {
        summary: 'the SIP registrations of users (all, or the extensions given): devices online, user agents',
        usage: 'wx-admin user registrations [<extension>...] [--full]',
        details: 'The addresses (contact, received) of the devices only with --full.',
        options: {full: {type: 'boolean', description: 'the addresses of the devices too'}},
        args: [0, 100],
        readOnly: true,
        async run(ctx) {
          const extensions = checkExtensions(ctx.positionals.map(String));
          const apiPathOf = extensions.length
            ? `/PBX/Users/${extensions.join(',')}/Sip/Registrations`
            : '/PBX/Users/Sip/Registrations';
          const r = await (await pbxClient(ctx)).call('GET', apiPathOf, undefined, {scope: 'pbx'});
          // An object by extension; [] when nobody is registered (PHP).
          const byExt = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
          const strip = ({contact, received, ...rest}) => rest;
          return Object.fromEntries(
            Object.entries(byExt).map(([ext, v]) => [
              ext,
              {...v, registrations: (v?.registrations ?? []).map((x) => (ctx.values.full ? x : strip(x)))},
            ]),
          );
        },
        text(r, ctx) {
          const c = paint(ctx);
          const rows = Object.entries(r).flatMap(([ext, v]) =>
            (v.registrations ?? []).map((x) => [
              ext,
              x.online === '1' || x.online === 1 || x.online === true ? c.green('online') : c.dim('offline'),
              x.useragent ?? '',
              ...(ctx.values.full ? [x.contact ?? '', x.received ?? ''] : []),
            ]),
          );
          return rows.length ? table(rows) : 'No SIP registrations';
        },
      },
      groups: {
        summary: 'the user groups (ACL groups) of the PBX',
        usage: 'wx-admin user groups',
        options: {},
        args: [0, 0],
        readOnly: true,
        async run(ctx) {
          const r = await (await pbxClient(ctx)).call('GET', '/Groups/', undefined, {scope: 'pbx'});
          return Array.isArray(r) ? {total: r.length, records: r} : r;
        },
        text: (r) => (r?.records?.length ? table(r.records.map((g) => [g.id, g.name])) : 'No user groups'),
      },
      departments: {
        summary: 'the departments of the PBX, as a tree, with the number of users',
        usage: 'wx-admin user departments',
        options: {},
        args: [0, 0],
        readOnly: true,
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/Departments/', undefined, {scope: 'info'});
        },
        text(r, ctx) {
          const c = paint(ctx);
          const lines = [];
          const walk = (items, depth) => {
            for (const d of items ?? []) {
              const n = d.users?.length ?? 0;
              lines.push(`${'  '.repeat(depth)}${d.name}${c.dim(`  ${n} ${n === 1 ? 'user' : 'users'}`)}`);
              walk(d.items, depth + 1);
            }
          };
          walk(r?.records, 0);
          return lines.length ? lines : 'No departments';
        },
      },
    },
  },
};
