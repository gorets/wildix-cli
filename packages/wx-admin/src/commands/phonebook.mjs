// wx-admin phonebook: the phonebooks of a PBX and their contacts.
// Operations (PBX REST API; Company API Key scope phonebooks):
//   GET    /Phonebooks/                                  list (total, records: id, name, type, owner_id, contacts_cnt…)
//   GET    /Phonebooks/{id}/                             one
//   POST   /Phonebooks/                {data: {name, type}}       -> {id}
//   PUT    /Phonebooks/{id}/           {data: {name?, type?}}     -> {changed}
//   DELETE /Phonebooks/{id}/                             -> {phonebooks, contacts} (its contacts go with it)
//   GET    /Phonebooks/{id}/Contacts/                    contacts (start, count, search; total, records)
//   GET    /Phonebooks/{id}/Contacts/?filter[id]=…       one contact (…/Contacts/{contactId} answers the whole list)
//   POST   /Phonebooks/{id}/Contacts   {data: {name, …}}          -> {id}
//   PUT    /phonebooks/{id}/Contacts/{contactId} {data: {…}}      -> {changed}
//   DELETE /Phonebooks/{id}/Contacts/{contactId}/        -> {contacts}
// Every value is a string in the answers (ids too). Phonebook types: 1 personal (of its owner), 2 global (shared).
// The routes by phonebook are the ones the PBX lets a Company API Key use; /Contacts/{id} is not.
// Export and import go through the same contact routes, one contact at a time.
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {pickByName} from '../match.mjs';
import {readForUpload} from 'wldx-core/files';
import {oneLine, paint, table} from 'wldx-core/format';
import {query} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';
import {checkNewFile, writeNewFile} from './records.mjs';

const SCOPE = {scope: 'phonebooks'};
const TYPES = {personal: 1, global: 2};
const TYPE_NAMES = {1: 'personal', 2: 'global'};

// The fields of a contact a person writes (the rest are kept by the PBX).
export const CONTACT_FIELDS = [
  'name',
  'organization',
  'department',
  'email',
  'phone',
  'mobile',
  'office',
  'home',
  'home_mobile',
  'fax',
  'extension',
  'shortcut',
  'note',
  'address',
  'city',
  'postal_code',
  'province',
  'country',
  'vat_id',
  'name_prefix',
  'type',
];
// What the PBX keeps for itself: not exported, not imported.
const SYSTEM_FIELDS = new Set(['id', 'phonebook_id', 'hash', 'last_update', 'source_id', 'group_id', 'owner_id']);

// The options of contact-add and contact-update: one per common field, --set for the others.
const CONTACT_OPTIONS = {
  name: {type: 'string', placeholder: 'TEXT', description: 'the name shown for the contact'},
  phone: {type: 'string', placeholder: 'NUMBER', description: 'the main phone number'},
  mobile: {type: 'string', placeholder: 'NUMBER', description: 'the mobile number'},
  office: {type: 'string', placeholder: 'NUMBER', description: 'the office number'},
  home: {type: 'string', placeholder: 'NUMBER', description: 'the home number'},
  fax: {type: 'string', placeholder: 'NUMBER', description: 'the fax number'},
  email: {type: 'string', placeholder: 'ADDRESS', description: 'the e-mail address'},
  organization: {type: 'string', placeholder: 'TEXT', description: 'the company'},
  department: {type: 'string', placeholder: 'TEXT', description: 'the department'},
  note: {type: 'string', placeholder: 'TEXT', description: 'a note'},
  set: {
    type: 'string',
    multiple: true,
    placeholder: 'FIELD=VALUE',
    description: `another field: ${CONTACT_FIELDS.filter((f) => !['name', 'phone', 'mobile', 'office', 'home', 'fax', 'email', 'organization', 'department', 'note'].includes(f)).join(', ')}`,
  },
};

function contactData(values) {
  const data = {};
  for (const k of ['name', 'phone', 'mobile', 'office', 'home', 'fax', 'email', 'organization', 'department', 'note'])
    if (values[k] !== undefined) data[k] = values[k];
  for (const spec of values.set ?? []) {
    const at = spec.indexOf('=');
    const key = at > 0 ? spec.slice(0, at) : '';
    if (!/^[a-z_]{1,40}$/.test(key) || SYSTEM_FIELDS.has(key))
      throw new UsageError(`--set is FIELD=VALUE with a field of a contact (${CONTACT_FIELDS.join(', ')}): ${spec}`);
    data[key] = spec.slice(at + 1);
  }
  return data;
}

const idOf = (value, what) => {
  if (!/^\d{1,12}$/.test(String(value))) throw new UsageError(`A ${what} id is a number: ${value}`);
  return String(value);
};

// An id of a phonebook or a contact in a request path: digits only (it may come from a PBX answer).
function pid(v) {
  const s = String(v ?? '');
  if (!/^\d{1,12}$/.test(s)) throw new UsageError(`Not an id: ${s}`);
  return s;
}

async function listPhonebooks(client) {
  return (await client.call('GET', `/Phonebooks/${query({count: 1000})}`, undefined, SCOPE)) ?? {records: []};
}

// A phonebook by id or by name (exact, else without case).
async function phonebookId(client, ref) {
  if (/^\d+$/.test(String(ref))) return String(ref);
  const list = (await listPhonebooks(client)).records ?? [];
  return String(pickByName(list, ref, (p) => p.name, 'phonebook', 'wx-admin phonebook list').id);
}

// Every contact of a phonebook, page by page.
async function allContacts(client, id) {
  const out = [];
  for (let start = 0; ; start += 500) {
    const r = await client.call(
      'GET',
      `/Phonebooks/${pid(id)}/Contacts/${query({start, count: 500, sort: 'id', dir: 'ASC'})}`,
      undefined,
      SCOPE,
    );
    const records = r?.records ?? [];
    out.push(...records);
    if (records.length < 500 || out.length >= Number(r?.total ?? 0)) return out;
  }
}

const typeName = (t) => TYPE_NAMES[t] ?? `type ${t}`;

const phonebookLine = (p) =>
  `${p.name} (id ${p.id}, ${typeName(p.type)}${p.contacts_cnt !== undefined ? `, ${p.contacts_cnt} contacts` : ''})`;

// The number a person calls first.
const mainNumber = (c) => c.phone || c.mobile || c.office || c.extension || c.home || c.home_mobile || '';

const filled = (c) =>
  Object.fromEntries(Object.entries(c ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));

// ---- CSV (RFC 4180): fields with a comma, quote or line break are quoted ----

// A cell a spreadsheet would run as a formula (=, @, a tab, or + / - followed by more than a phone number) gets a
// leading ' (OWASP CSV injection); parseCsv takes it off again. Phone numbers like +39 02 1234 stay as they are.
const FORMULA = /^[=@\t\r]|^[+-](?![\d\s().\-+/]*$)/;
const csvCell = (v) => {
  let s = String(v ?? '');
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const unguard = (c) => (c.startsWith("'") && FORMULA.test(c.slice(1)) ? c.slice(1) : c);

export function toCsv(rows, columns) {
  return `${[columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n')}\r\n`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (quoted) throw new UsageError('The CSV has a quote that is not closed');
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  if (!header) return [];
  const columns = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(columns.map((c, i) => [c, unguard(r[i] ?? '')]).filter(([c]) => c)));
}

// The contacts of an export: their own fields, without the ones the PBX keeps.
const exportable = (c) =>
  Object.fromEntries(
    Object.entries(c).filter(([k, v]) => !SYSTEM_FIELDS.has(k) && v !== '' && v !== null && v !== undefined),
  );

const csvColumns = (contacts) => {
  const seen = new Set(['name']);
  for (const c of contacts) for (const k of Object.keys(c)) seen.add(k);
  return [...seen];
};

const formatOf = (format, file) => format ?? (file && /\.csv$/i.test(file) ? 'csv' : 'json');

async function readInput(ctx, from) {
  if (from === '-') {
    const chunks = [];
    for await (const c of ctx.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
  }
  return readForUpload(path.resolve(ctx.cwd ?? process.cwd(), from), ctx.env).toString('utf8');
}

const contactsText = (r, ctx) => {
  const c = paint(ctx);
  const records = r?.records ?? [];
  if (!records.length) return 'No contacts';
  const shown = `${records.length} of ${r.total ?? records.length} contacts`;
  return [
    ...table(
      records.map((x) => [
        x.id,
        oneLine(x.name, 40),
        mainNumber(x),
        oneLine(x.email ?? '', 40),
        oneLine(x.organization ?? '', 30),
      ]),
    ),
    c.dim(Number(r.total) > records.length ? `${shown} (--offset for more)` : shown),
  ];
};

export const groups = {
  phonebook: {
    summary: 'phonebooks and their contacts: list, show, create, change, delete, export, import',
    commands: {
      list: {
        summary: 'the phonebooks of the PBX',
        usage: 'wx-admin phonebook list [--search TEXT]',
        options: {search: {type: 'string', placeholder: 'TEXT', description: 'phonebooks with this text in the name'}},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call(
            'GET',
            `/Phonebooks/${query({count: 1000, search: ctx.values.search})}`,
            undefined,
            SCOPE,
          );
        },
        text: (r) =>
          r?.records?.length
            ? table(
                r.records.map((p) => [
                  p.id,
                  typeName(p.type),
                  p.contacts_cnt === undefined ? '' : `${p.contacts_cnt} contacts`,
                  p.name,
                ]),
              )
            : 'No phonebooks',
      },
      get: {
        summary: 'one phonebook',
        usage: 'wx-admin phonebook get <phonebook>',
        details: 'A phonebook is its id or its name.',
        options: {},
        args: [1, 1],
        async run(ctx) {
          const client = await pbxClient(ctx);
          return client.call('GET', `/Phonebooks/${await phonebookId(client, ctx.positionals[0])}/`, undefined, SCOPE);
        },
        text: (p) => phonebookLine(p),
      },
      create: {
        summary: 'create a phonebook',
        usage: 'wx-admin phonebook create <name> [--type global|personal]',
        options: {
          type: {
            type: 'string',
            choices: Object.keys(TYPES),
            description: 'global: shared by the PBX (default); personal: of the user of the access',
          },
        },
        args: [1, 1],
        async run(ctx) {
          const name = ctx.positionals[0].trim();
          if (!name || name.length > 255) throw new UsageError('A phonebook needs a name (up to 255 characters)');
          const r = await (await pbxClient(ctx)).call(
            'POST',
            '/Phonebooks/',
            {data: {name, type: TYPES[ctx.values.type ?? 'global']}},
            SCOPE,
          );
          return {id: r?.id, name};
        },
        text: (r) => `Created the phonebook ${r.name} (id ${r.id})`,
      },
      update: {
        summary: 'rename a phonebook or change its type',
        usage: 'wx-admin phonebook update <phonebook> [--name NAME] [--type global|personal]',
        options: {
          name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
          type: {type: 'string', choices: Object.keys(TYPES), description: 'global (shared by the PBX) or personal'},
        },
        args: [1, 1],
        async run(ctx) {
          const {name, type} = ctx.values;
          if (name === undefined && type === undefined)
            throw new UsageError('Nothing to change: give --name or --type', ctx.usage());
          const data = {};
          if (name !== undefined) data.name = name.trim();
          if (type !== undefined) data.type = TYPES[type];
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          const r = await client.call('PUT', `/Phonebooks/${pid(id)}/`, {data}, SCOPE);
          return {id, ...data, changed: r?.changed};
        },
        text: (r) => `Updated the phonebook ${r.id}${r.name ? `: ${r.name}` : ''}`,
      },
      delete: {
        summary: 'delete a phonebook with all its contacts (needs --yes)',
        usage: 'wx-admin phonebook delete <phonebook> --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete it and its contacts'}},
        args: [1, 1],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError('Deleting a phonebook deletes its contacts: confirm with --yes', ctx.usage());
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          const r = await client.call('DELETE', `/Phonebooks/${pid(id)}/`, undefined, SCOPE);
          return {id, ...r};
        },
        text: (r) => `Deleted the phonebook ${r.id}${r.contacts !== undefined ? ` and ${r.contacts} contacts` : ''}`,
      },
      contacts: {
        summary: 'the contacts of a phonebook',
        usage: 'wx-admin phonebook contacts <phonebook> [--search TEXT] [--count N] [--offset N]',
        options: {
          search: {
            type: 'string',
            placeholder: 'TEXT',
            description: 'contacts with this text in the name, a number, the e-mail or the company',
          },
          count: {type: 'string', placeholder: 'N', description: 'how many (default 100, at most 1000)'},
          offset: {type: 'string', placeholder: 'N', description: 'skip this many (the next page)'},
        },
        args: [1, 1],
        async run(ctx) {
          const {values} = ctx;
          const count = values.count === undefined ? 100 : Number(values.count);
          if (!Number.isInteger(count) || count < 1 || count > 1000)
            throw new UsageError(`--count is from 1 to 1000: ${values.count}`);
          const start = values.offset === undefined ? undefined : Number(values.offset);
          if (start !== undefined && (!Number.isInteger(start) || start < 0))
            throw new UsageError(`--offset is a whole number: ${values.offset}`);
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          return client.call(
            'GET',
            `/Phonebooks/${pid(id)}/Contacts/${query({start, count, search: values.search, sort: 'name', dir: 'ASC'})}`,
            undefined,
            SCOPE,
          );
        },
        text: contactsText,
      },
      contact: {
        summary: 'one contact of a phonebook: its filled fields',
        usage: 'wx-admin phonebook contact <phonebook> <contactId>',
        options: {},
        args: [2, 2],
        async run(ctx) {
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          // GET /Phonebooks/{id}/Contacts/{contactId} answers the whole list (seen live): the contact is filtered by id.
          const contact = idOf(ctx.positionals[1], 'contact');
          const r = await client.call(
            'GET',
            `/Phonebooks/${pid(id)}/Contacts/${query({'filter[id]': contact})}`,
            undefined,
            SCOPE,
          );
          const found = (r?.records ?? []).find((c) => String(c.id) === contact);
          if (!found) throw Object.assign(new Error(`No contact ${contact} in the phonebook ${id}`), {status: 404});
          return found;
        },
        text: (c) =>
          Object.entries(filled(c))
            .filter(([k]) => !['hash', 'source_id'].includes(k))
            .map(([k, v]) => `${k.padEnd(13)} ${oneLine(v, 200)}`),
      },
      'contact-add': {
        summary: 'add a contact to a phonebook',
        usage:
          'wx-admin phonebook contact-add <phonebook> --name TEXT [--phone N] [--mobile N] [--email A] [--organization T] [--set FIELD=VALUE]...',
        options: CONTACT_OPTIONS,
        args: [1, 1],
        async run(ctx) {
          const data = contactData(ctx.values);
          if (!data.name?.trim()) throw new UsageError('A contact needs --name', ctx.usage());
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          const r = await client.call('POST', `/Phonebooks/${pid(id)}/Contacts`, {data}, SCOPE);
          return {id: r?.id, phonebook: id, name: data.name};
        },
        text: (r) => `Added ${r.name} (id ${r.id}) to the phonebook ${r.phonebook}`,
      },
      'contact-update': {
        summary: 'change fields of a contact (the others stay)',
        usage:
          'wx-admin phonebook contact-update <phonebook> <contactId> [--name TEXT] [--phone N] … [--set FIELD=VALUE]...',
        details: 'An empty value clears a field: --email "".',
        options: CONTACT_OPTIONS,
        args: [2, 2],
        async run(ctx) {
          const data = contactData(ctx.values);
          if (!Object.keys(data).length) throw new UsageError('Nothing to change: give a field', ctx.usage());
          if (data.name !== undefined && !data.name.trim()) throw new UsageError('A contact cannot have an empty name');
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          const contact = idOf(ctx.positionals[1], 'contact');
          const r = await client.call('PUT', `/phonebooks/${pid(id)}/Contacts/${pid(contact)}`, {data}, SCOPE);
          return {id: contact, phonebook: id, changed: r?.changed, fields: Object.keys(data)};
        },
        text: (r) => `Updated the contact ${r.id}: ${r.fields.join(', ')}`,
      },
      'contact-delete': {
        summary: 'delete contacts of a phonebook (needs --yes)',
        usage: 'wx-admin phonebook contact-delete <phonebook> <contactId>... --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete them'}},
        args: [2, 101],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError('A deleted contact cannot be brought back: confirm with --yes', ctx.usage());
          const ids = ctx.positionals.slice(1).map((x) => idOf(x, 'contact'));
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          let deleted = 0;
          for (const contact of ids)
            deleted += Number(
              (await client.call('DELETE', `/Phonebooks/${pid(id)}/Contacts/${pid(contact)}/`, undefined, SCOPE))
                ?.contacts ?? 1,
            );
          return {phonebook: id, deleted, ids};
        },
        text: (r) => `Deleted ${r.deleted} contact${r.deleted === 1 ? '' : 's'} of the phonebook ${r.phonebook}`,
      },
      export: {
        summary: 'the contacts of a phonebook as CSV or JSON (to stdout, or to a new file)',
        usage: 'wx-admin phonebook export <phonebook> [--to FILE] [--format csv|json]',
        details:
          'The format follows the file name (.csv) unless --format says it; JSON is a list of contacts. Fields the PBX keeps (id, hash…) are left out, so phonebook import takes the file.',
        options: {
          to: {type: 'string', placeholder: 'FILE', description: 'write it to this file (which must not exist)'},
          format: {
            type: 'string',
            choices: ['csv', 'json'],
            description: 'csv or json (default: by the file name, else json)',
          },
        },
        args: [1, 1],
        async run(ctx) {
          if (ctx.values.to) checkNewFile(ctx, ctx.values.to);
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          const contacts = (await allContacts(client, id)).map(exportable);
          const format = formatOf(ctx.values.format, ctx.values.to);
          const content =
            format === 'csv' ? toCsv(contacts, csvColumns(contacts)) : `${JSON.stringify(contacts, null, 2)}\n`;
          if (!ctx.values.to) return format === 'csv' ? {csv: content} : contacts;
          return {file: writeNewFile(ctx, ctx.values.to, content), phonebook: id, contacts: contacts.length, format};
        },
        text: (r) =>
          r.file
            ? `Exported ${r.contacts} contacts of the phonebook ${r.phonebook} to ${r.file}`
            : r.csv !== undefined
              ? r.csv.replace(/\r\n$/, '').split('\r\n')
              : JSON.stringify(r, null, 2),
      },
      import: {
        summary: 'add the contacts of a CSV or JSON file to a phonebook',
        usage: 'wx-admin phonebook import <phonebook> --from FILE|- [--format csv|json]',
        details: [
          'CSV: a header row of field names (name, phone, mobile, email, organization…), one contact per row.',
          'JSON: a list of contacts ({name, phone, …}), as phonebook export writes it. Every contact needs a name.',
          'Each contact is added (none is merged or replaced); the ones the PBX refuses are listed, the others stay.',
        ].join('\n'),
        options: {
          from: {type: 'string', placeholder: 'FILE', description: 'the file (or - for stdin)'},
          format: {
            type: 'string',
            choices: ['csv', 'json'],
            description: 'csv or json (default: by the file name, else json)',
          },
        },
        args: [1, 1],
        async run(ctx) {
          if (!ctx.values.from) throw new UsageError('--from is needed', ctx.usage());
          const text = await readInput(ctx, ctx.values.from);
          const format = formatOf(ctx.values.format, ctx.values.from === '-' ? undefined : ctx.values.from);
          let rows;
          if (format === 'csv') rows = parseCsv(text);
          else {
            try {
              rows = JSON.parse(text);
            } catch (e) {
              throw new UsageError(
                `${ctx.values.from === '-' ? 'stdin' : ctx.values.from} is not JSON: ${e.message} (CSV? --format csv)`,
              );
            }
            if (rows && !Array.isArray(rows) && Array.isArray(rows.contacts)) rows = rows.contacts;
            if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r)))
              throw new UsageError('The JSON is a list of contacts ({name, phone, …})');
          }
          const contacts = rows.map((r) =>
            Object.fromEntries(
              Object.entries(r)
                .filter(
                  ([k, v]) =>
                    !SYSTEM_FIELDS.has(k) && /^[a-z_]{1,40}$/.test(k) && v !== null && v !== undefined && v !== '',
                )
                .map(([k, v]) => [k, String(v)]),
            ),
          );
          const unnamed = contacts.findIndex((c) => !c.name?.trim());
          if (unnamed >= 0) throw new UsageError(`The contact ${unnamed + 1} has no name: nothing was imported`);
          if (!contacts.length) throw new UsageError('No contacts in the file');
          const client = await pbxClient(ctx);
          const id = await phonebookId(client, ctx.positionals[0]);
          const added = [];
          const failed = [];
          for (const [i, data] of contacts.entries()) {
            if (ctx.signal.aborted) break;
            try {
              added.push((await client.call('POST', `/Phonebooks/${pid(id)}/Contacts`, {data}, SCOPE))?.id);
            } catch (e) {
              if (e.status === 401 || e.status === 403) throw e;
              failed.push({index: i + 1, name: data.name, error: oneLine(e.message, 200)});
            }
          }
          return {
            phonebook: id,
            added: added.length,
            ids: added,
            failed,
            ...(ctx.signal.aborted ? {stopped: true} : {}),
          };
        },
        text: (r) => [
          `Added ${r.added} contact${r.added === 1 ? '' : 's'} to the phonebook ${r.phonebook}${r.stopped ? ' (stopped)' : ''}`,
          ...r.failed.map((f) => `  not added: ${f.index} ${oneLine(f.name, 40)}: ${f.error}`),
        ],
      },
    },
  },
};
