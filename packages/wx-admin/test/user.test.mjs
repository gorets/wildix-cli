import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {groups, presenceUntil} from '../src/commands/user.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

const USERS = [
  {
    id: '501',
    extension: '101',
    name: 'Anna Test',
    email: 'anna@example.com',
    mobilePhone: '+390000001',
    role: 'admin',
    licenseType: 'premium',
    groupDn: 'gid=1,o=com0,dc=wildix',
    groupName: 'Admin',
    department: 'Sales',
    language: 'en',
    dialplan: 'users',
  },
  {
    id: '502',
    extension: '102',
    name: 'Bob Test',
    email: 'bob@example.com',
    role: 'user',
    licenseType: 'basic',
    groupDn: 'gid=2,o=com0,dc=wildix',
    groupName: 'Default',
    department: '',
    language: 'it',
    dialplan: 'users',
  },
  {
    id: '503',
    extension: '103',
    name: 'Bob Test',
    email: 'bob2@example.com',
    role: 'user',
    licenseType: 'basic',
    groupDn: 'gid=2,o=com0,dc=wildix',
    groupName: 'Default',
    department: '',
    language: 'it',
    dialplan: 'users',
  },
];
const GROUPS = {
  total: 2,
  records: [
    {dn: 'gid=1,o=com0,dc=wildix', id: '1', name: 'Admin'},
    {dn: 'gid=2,o=com0,dc=wildix', id: '2', name: 'Default'},
  ],
};

// A PBX that answers the colleagues routes from memory (wrapped as the PBX does) and records every request.
// `answers` overrides a route: {'PUT /PBX/presence/': body}.
function fakePbx(answers = {}) {
  const users = structuredClone(USERS);
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), {status});
  const result = (r) => reply(200, {type: 'result', result: r});
  const fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path: p, query: u.searchParams, body});
    const key = `${init.method} ${p}`;
    if (key in answers) return reply(200, answers[key]);
    if (key === 'GET /Groups/') return result(GROUPS);
    if (key === 'GET /Departments/')
      return result({
        records: [
          {id: 'All', name: 'All', users: ['101', '102'], items: []},
          {id: 'RND', name: 'RND', users: [], items: [{id: 'M', name: 'Management', users: ['101'], items: []}]},
        ],
      });
    if (key === 'GET /PBX/Colleagues/') {
      let list = users;
      for (const [k, v] of u.searchParams) {
        const f = /^filter\[(\w+)\]\[\]$/.exec(k);
        if (f) list = list.filter((x) => String(x[f[1]]).toLowerCase() === v.toLowerCase());
      }
      const fields = u.searchParams.get('fields')?.split(',');
      const count = Number(u.searchParams.get('count') ?? list.length);
      const start = Number(u.searchParams.get('start') ?? 0);
      const records = list
        .slice(start, start + count)
        .map((x) => (fields ? Object.fromEntries(fields.filter((k) => k in x).map((k) => [k, x[k]])) : x));
      return result({total: list.length, records});
    }
    if (key === 'POST /PBX/Colleagues/') return result({id: '600', ...body});
    let m = /^\/PBX\/Colleagues\/(\d+)\/$/.exec(p);
    if (m) {
      const user = users.find((x) => x.id === m[1]);
      if (!user) return reply(404, {type: 'error', reason: 'Not found'});
      if (init.method === 'GET') return result(user);
      if (init.method === 'PUT') return result({...user, ...body});
      if (init.method === 'DELETE') return result('Success');
    }
    if (/^\/PBX\/Colleagues\/\d+\/preferences\/$/.test(p)) return result('Success');
    m = /^\/User\/(\d+)\/Presence\/$/.exec(p);
    if (m)
      return result({
        online: true,
        show: 'dnd',
        device_show: 'talking',
        status: 'lunch',
        until: '2026-11-07 13:00:00+00:00',
        location: {address: 'Somewhere 1', lat: '1', lng: '2'},
      });
    if (key === 'PUT /PBX/presence/') return result('Success');
    if (/^\/PBX\/Users\/([\d,]+\/)?Sip\/Registrations$/.test(p)) return result([]);
    return reply(404, {type: 'error', reason: '404 Not Found'});
  };
  return {fetch, calls, last: () => calls.at(-1)};
}

const registry = {groups};
const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry, ...options});

test('list: fields without --full (the e-mail too), filters (the group by name), paging and its note in the text', async () => {
  const pbx = fakePbx();
  let r = await wx(
    pbx,
    ['user', 'list', '--group', 'default', '--role', 'user', '--limit', '1', '--sort', 'extension', '--desc'],
    {output: 'text'},
  );
  assert.equal(r.code, 0, r.stderr);
  const q = pbx.last().query;
  assert.equal(q.get('filter[groupDn][]'), 'gid=2,o=com0,dc=wildix');
  assert.equal(q.get('filter[role][]'), 'user');
  assert.equal(q.get('count'), '1');
  assert.equal(q.get('dir'), 'desc');
  assert.ok(q.get('fields').split(',').includes('email'));
  assert.ok(!q.get('fields').includes('Phone'));
  assert.equal(pbx.calls[0].path, '/Groups/');
  assert.match(
    r.stdout,
    /^102 +Bob Test +bob@example\.com +user +basic +Default\n1 of 2 users: --start 1 for the next ones\n$/,
  );
  r = await wx(pbx, ['user', 'list', '--full'], {output: 'text'});
  assert.equal(pbx.last().query.get('fields'), null);
  assert.match(r.stdout, /anna@example\.com/);
  const json = JSON.parse((await wx(pbx, ['user', 'list', '--department', 'Sales'])).stdout);
  assert.deepEqual(
    json.records.map((u) => u.extension),
    ['101'],
  );
  assert.equal((await wx(pbx, ['user', 'list', '--desc'])).code, 64);
  assert.equal((await wx(pbx, ['user', 'list', '--limit', 'ten'])).code, 64);
  assert.equal((await wx(pbx, ['user', 'list', '--group', 'nope'])).code, 64);
  assert.equal((await wx(pbx, ['user', 'list', '--role', 'boss'])).code, 64);
});

test('get: by extension, e-mail, id (when no extension matches), name; ambiguous and unknown refused', async () => {
  const pbx = fakePbx();
  const byExt = await wx(pbx, ['user', 'get', '101'], {output: 'text'});
  assert.equal(byExt.code, 0, byExt.stderr);
  assert.equal(pbx.last().query.get('filter[extension][]'), '101');
  assert.match(byExt.stdout, /^Anna Test \(ext 101, id 501\)\n/);
  assert.match(byExt.stdout, /e-mail +anna@example\.com/);
  assert.equal(JSON.parse((await wx(pbx, ['user', 'get', 'BOB@example.com'])).stdout).id, '502');
  assert.equal(JSON.parse((await wx(pbx, ['user', 'get', '502'])).stdout).extension, '102');
  assert.equal(pbx.last().path, '/PBX/Colleagues/502/');
  const twice = await wx(pbx, ['user', 'get', 'Bob Test']);
  assert.equal(twice.code, 64);
  assert.match(twice.stderr, /2 users match Bob Test: give the extension \(102, 103\)/);
  assert.equal((await wx(pbx, ['user', 'get', '999'])).code, 64);
  assert.equal(JSON.parse((await wx(pbx, ['user', 'get', 'Anna Test'])).stdout).id, '501');
});

test('create: required fields, checks, group resolved; a password from --from is sent and never printed', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['user', 'create', '--extension', '110', '--name', 'New One'])).code, 64);
  assert.equal(
    (await wx(pbx, ['user', 'create', '--extension', '11a', '--name', 'New One', '--license', 'basic'])).code,
    64,
  );
  assert.equal(
    (
      await wx(pbx, [
        'user',
        'create',
        '--extension',
        '110',
        '--name',
        'New One',
        '--license',
        'basic',
        '--email',
        'not-mail',
      ])
    ).code,
    64,
  );
  assert.equal(
    (await wx(pbx, ['user', 'create', '--extension', '110', '--name', 'New;One', '--license', 'basic'])).code,
    64,
  );
  assert.ok(!pbx.calls.some((c) => c.method === 'POST'));
  const r = await wx(
    pbx,
    [
      'user',
      'create',
      '--extension',
      '110',
      '--name',
      'New One',
      '--license',
      'premium',
      '--email',
      'new@example.com',
      '--role',
      'user',
      '--group',
      'Admin',
      '--department',
      'Sales',
    ],
    {output: 'text'},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.last().body, {
    extension: '110',
    name: 'New One',
    licenseType: 'premium',
    email: 'new@example.com',
    role: 'user',
    groupDn: 'gid=1,o=com0,dc=wildix',
    department: 'Sales',
  });
  assert.equal(r.stdout, 'Created New One (ext 110, id 600)\n');
  const file = path.join(tempConfigDir(), 'user.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      extension: '111',
      name: 'From File',
      licenseType: 'basic',
      password: 'Secret!Pass1',
      groupDn: 'Default',
    }),
  );
  const f = await wx(pbx, ['user', 'create', '--from', file, '--name', 'Option Wins']);
  assert.equal(f.code, 0, f.stderr);
  assert.deepEqual(pbx.last().body, {
    extension: '111',
    name: 'Option Wins',
    licenseType: 'basic',
    password: 'Secret!Pass1',
    groupDn: 'gid=2,o=com0,dc=wildix',
  });
  assert.doesNotMatch(f.stdout, /Secret/);
  assert.equal(JSON.parse(f.stdout).id, '600');
});

test('update: only the given fields, by id in the path, --transfer-chats', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['user', 'update', '101'])).code, 64);
  const r = await wx(
    pbx,
    ['user', 'update', '101', '--email', 'anna2@example.com', '--license', 'business', '--transfer-chats'],
    {output: 'text'},
  );
  assert.equal(r.code, 0, r.stderr);
  const put = pbx.last();
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/PBX/Colleagues/501/');
  assert.equal(put.query.get('transferRnaChats'), 'true');
  assert.deepEqual(put.body, {email: 'anna2@example.com', licenseType: 'business'});
  assert.equal(r.stdout, 'Updated Anna Test (ext 101, id 501)\n');
});

test('delete needs --yes; data[] names the user and what --also adds', async () => {
  const pbx = fakePbx();
  const no = await wx(pbx, ['user', 'delete', '101']);
  assert.equal(no.code, 64);
  assert.match(no.stderr, /--yes/);
  assert.equal(pbx.calls.length, 0);
  const r = await wx(pbx, ['user', 'delete', '101', '102', '--yes', '--also', 'voicemails', '--also', 'devices'], {
    output: 'text',
  });
  assert.equal(r.code, 0, r.stderr);
  const deletes = pbx.calls.filter((c) => c.method === 'DELETE');
  assert.deepEqual(
    deletes.map((c) => c.path),
    ['/PBX/Colleagues/501/', '/PBX/Colleagues/502/'],
  );
  assert.deepEqual(deletes[0].query.getAll('data[]'), ['user', 'voicemails', 'devices']);
  assert.equal(r.stdout, 'Deleted Anna Test (ext 101, id 501)\nDeleted Bob Test (ext 102, id 502)\n');
  assert.equal((await wx(pbx, ['user', 'delete', '101', '--yes', '--also', 'everything'])).code, 64);
});

test('copy-preferences needs --yes, one PUT per target with the id of the source; warnings shown', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['user', 'copy-preferences', '101', '102'])).code, 64);
  assert.equal((await wx(pbx, ['user', 'copy-preferences', '101', '101', '--yes'])).code, 64);
  const r = await wx(pbx, ['user', 'copy-preferences', '101', '102', '103', '--yes'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  const puts = pbx.calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(
    puts.map((c) => [c.path, c.body]),
    [
      ['/PBX/Colleagues/502/preferences/', {from: '501'}],
      ['/PBX/Colleagues/503/preferences/', {from: '501'}],
    ],
  );
  assert.match(r.stdout, /^Copied the preferences of Anna Test \(ext 101, id 501\) to Bob Test \(ext 102, id 502\)\n/);
  const warn = fakePbx({
    'PUT /PBX/Colleagues/502/preferences/': {
      type: 'warning',
      result: 'Success',
      reason: 'Some failed',
      warnings: {102: 'no phone'},
    },
  });
  const w = await wx(warn, ['user', 'copy-preferences', '101', '102', '--yes'], {output: 'text'});
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /Warning: Some failed\n {2}102: no phone/);
});

test('presence: the location only with --full; presence-set: one batch, --until in UTC', async () => {
  const pbx = fakePbx();
  const r = await wx(pbx, ['user', 'presence', '101', 'bob2@example.com']);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.deepEqual(
    data.presence.map((p) => p.extension),
    ['101', '103'],
  );
  assert.equal(data.presence[0].location, undefined);
  assert.ok(pbx.calls.some((c) => c.path === '/User/103/Presence/'));
  const text = await wx(pbx, ['user', 'presence', '101'], {output: 'text'});
  assert.match(text.stdout, /^101 +online +dnd +talking +lunch +until \d{4}-\d\d-\d\d \d\d:\d\d\n$/);
  assert.equal(
    JSON.parse((await wx(pbx, ['user', 'presence', '101', '--full'])).stdout).presence[0].location.address,
    'Somewhere 1',
  );

  assert.equal((await wx(pbx, ['user', 'presence-set', '101'])).code, 64);
  assert.equal((await wx(pbx, ['user', 'presence-set', '10a', '--status', 'dnd'])).code, 64);
  assert.equal((await wx(pbx, ['user', 'presence-set', '101', '--status', 'busy'])).code, 64);
  assert.equal((await wx(pbx, ['user', 'presence-set', '101', '--status', 'dnd', '--until', 'tomorrow'])).code, 64);
  const set = await wx(
    pbx,
    ['user', 'presence-set', '101', '102', '--status', 'dnd', '--message', 'meeting', '--until', '+2h'],
    {output: 'text'},
  );
  assert.equal(set.code, 0, set.stderr);
  assert.equal(pbx.last().path, '/PBX/presence/');
  assert.deepEqual(pbx.last().body, {
    items: [
      {extension: '101', status: 'dnd', message: 'meeting', until: '07/11/2026 14:00'},
      {extension: '102', status: 'dnd', message: 'meeting', until: '07/11/2026 14:00'},
    ],
  });
  assert.equal(set.stdout, 'Presence of 101, 102: dnd (meeting) until 07/11/2026 14:00 UTC\n');
});

test('presenceUntil: relative and local times, the past refused', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  assert.equal(presenceUntil('+30m', now), '07/11/2026 12:30');
  assert.equal(presenceUntil('+1d', now), '08/11/2026 12:00');
  const local = new Date(2026, 10, 9, 9, 5);
  assert.equal(
    presenceUntil('2026-11-09 09:05', now),
    `${String(local.getUTCDate()).padStart(2, '0')}/11/2026 ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`,
  );
  assert.throws(() => presenceUntil('2020-01-01 10:00', now), /past/);
});

test('registrations: [] means none; addresses only with --full; extensions in the path', async () => {
  const none = fakePbx();
  const r = await wx(none, ['user', 'registrations'], {output: 'text'});
  assert.equal(r.stdout, 'No SIP registrations\n');
  assert.equal(none.last().path, '/PBX/Users/Sip/Registrations');
  const regs = {
    101: {
      registrations: [
        {online: '1', contact: 'sip:101@10.0.0.1:5060', received: 'sip:10.0.0.1:5060', useragent: 'Wildix W-AIR'},
        {online: '0', useragent: 'Wildix WP480'},
      ],
    },
  };
  const pbx = fakePbx({'GET /PBX/Users/101,102/Sip/Registrations': {type: 'result', result: regs}});
  const text = await wx(pbx, ['user', 'registrations', '101', '102'], {output: 'text'});
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stdout, '101  online   Wildix W-AIR\n101  offline  Wildix WP480\n');
  assert.equal(
    JSON.parse((await wx(pbx, ['user', 'registrations', '101', '102'])).stdout)['101'].registrations[0].contact,
    undefined,
  );
  assert.match(
    (await wx(pbx, ['user', 'registrations', '101', '102', '--full'], {output: 'text'})).stdout,
    /10\.0\.0\.1/,
  );
  assert.equal((await wx(pbx, ['user', 'registrations', '1,2'])).code, 64);
});

test('groups and departments as text', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['user', 'groups'], {output: 'text'})).stdout, '1  Admin\n2  Default\n');
  assert.equal(
    (await wx(pbx, ['user', 'departments', '--no-color'], {output: 'text'})).stdout,
    'All  2 users\nRND  0 users\n  Management  1 user\n',
  );
  const arr = fakePbx({'GET /Groups/': {type: 'result', result: GROUPS.records}});
  assert.equal(JSON.parse((await wx(arr, ['user', 'groups'])).stdout).total, 2);
});
