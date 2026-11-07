import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {groups} from '../src/commands/acl.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});
const dn = (id) => `gid=${id},o=com0,dc=wildix`;

const ADMIN = {
  dn: dn(1),
  id: '1',
  name: 'Admin',
  wcgrp: '1',
  inherits: null,
  rules: [{rule: 'CALL', ability: 'yes', group: 'all'}],
  adminRules: [],
};
const SALES = {
  dn: dn(2),
  id: '2',
  name: 'Sales',
  wcgrp: '2',
  inherits: null,
  rules: [{rule: 'CTI_ANALYTICS', ability: 'use', group: ''}],
  adminRules: [{subject: 'all', operation: 'noepage'}],
};
const PERMISSIONS = [
  {
    ability: ['yes', 'no'],
    key: 'EDIT_PP',
    name: 'Modify public phonebooks',
    containSubGroups: false,
    groups: [
      {groupDn: dn(1), groupName: 'Admin', access: true, subGroups: []},
      {groupDn: dn(2), groupName: 'Sales', access: false, subGroups: []},
    ],
  },
  {
    ability: ['yes', 'no'],
    key: 'CALL',
    name: 'Call',
    containSubGroups: true,
    groups: [
      {
        groupDn: dn(1),
        groupName: 'Admin',
        access: true,
        subGroups: [
          {groupName: 'Admin', access: true},
          {groupName: 'Sales', access: true},
        ],
      },
      {
        groupDn: dn(2),
        groupName: 'Sales',
        access: true,
        subGroups: [
          {groupName: 'Admin', access: false},
          {groupName: 'Sales', access: true},
        ],
      },
    ],
  },
];
const RULES = {
  list: [
    {
      ability: ['yes', 'no'],
      access: [
        {key: 'EDIT_PP', group: false, name: 'Modify public phonebooks'},
        {key: 'CALL', group: true, name: 'Call'},
      ],
    },
  ],
  default: [],
  adminList: [{ability: ['epage', 'noepage'], access: [{name: 'Users', subject: 'users__users'}]}],
};

// The ACL groups of a PBX in memory: GET/POST /PBX/AclGroups/, PUT and DELETE by id, Rules and Permissions.
function fakePbx(initial = [ADMIN, SALES]) {
  const store = new Map(initial.map((g) => [g.id, structuredClone(g)]));
  let next = 100;
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), {status});
  const result = (r) => reply(200, {type: 'result', result: r});
  const fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path: p, search: decodeURIComponent(u.search), body});
    if (p === '/PBX/AclGroups/Rules/' && init.method === 'GET') return result(RULES);
    if (p === '/PBX/AclGroups/Permissions/' && init.method === 'GET') return result(PERMISSIONS);
    if (p === '/PBX/AclGroups/' && init.method === 'GET') return result({records: [...store.values()]});
    if (p === '/PBX/AclGroups/' && init.method === 'POST') {
      const id = String(next++);
      const g = {
        dn: dn(id),
        id,
        name: body.name,
        wcgrp: '5',
        inherits: body.inherits ? {dn: body.inherits.dn} : null,
        rules: body.rules ?? [],
        adminRules: [{subject: 'all', operation: 'noepage'}],
      };
      store.set(id, g);
      return result(g);
    }
    const m = p.match(/^\/PBX\/AclGroups\/([\d,]+)\/$/);
    if (m && init.method === 'PUT') {
      const g = store.get(m[1]);
      if (!g) return reply(400, {type: 'error', reason: 'Bad request'});
      if (body.name !== undefined) g.name = body.name;
      if (body.inherits !== undefined) g.inherits = body.inherits ? {dn: body.inherits.dn} : null;
      if (body.rules) g.rules = body.rules;
      if (body.adminRules) g.adminRules = body.adminRules;
      return result('Success');
    }
    if (m && init.method === 'DELETE') {
      for (const id of m[1].split(',')) store.delete(id);
      return result([]);
    }
    return reply(404, {type: 'error', reason: '404 Not Found'});
  };
  return {fetch, calls, store, writes: () => calls.filter((c) => c.method !== 'GET')};
}

const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry: {groups}, ...options});
const text = (pbx, argv, options = {}) => wx(pbx, [...argv, '--no-color'], {output: 'text', ...options});

test('groups and group (by id, name in any case, or DN) as text', async () => {
  const pbx = fakePbx();
  assert.equal(
    (await text(pbx, ['acl', 'list'])).stdout,
    '1  Admin  1 rules  0 admin rules\n2  Sales  1 rules  1 admin rules\n',
  );
  assert.equal(JSON.parse((await wx(pbx, ['acl', 'list'])).stdout).records.length, 2);
  const g = await text(pbx, ['acl', 'get', 'sales']);
  assert.equal(g.stdout, 'Sales (id 2)\nrules:\n  CTI_ANALYTICS  use\nadmin rules:\n  noepage  all\n');
  assert.equal(JSON.parse((await wx(pbx, ['acl', 'get', dn(1)])).stdout).name, 'Admin');
  assert.equal((await wx(pbx, ['acl', 'get', 'nope'])).code, 64);
});

test('create: rules with group names turned into DNs, a parent, a name that exists is refused', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['acl', 'create', 'Sales'])).code, 64);
  assert.equal((await wx(pbx, ['acl', 'create', 'bad/name'])).code, 64);
  assert.equal((await wx(pbx, ['acl', 'create', 'x', '--rule', 'CALL maybe all'])).code, 64);
  assert.equal(pbx.writes().length, 0);
  const r = await text(pbx, [
    'acl',
    'create',
    'Support',
    '--rule',
    'CALL yes Sales',
    '--rule',
    'SEE_ANALYTICS yes all',
    '--rule',
    'CTI_ANALYTICS use',
    '--inherits',
    'Admin',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Created the ACL group Support (id 100)\n');
  assert.deepEqual(pbx.writes()[0].body, {
    name: 'Support',
    inherits: {dn: dn(1)},
    rules: [
      {rule: 'CALL', ability: 'yes', group: dn(2)},
      {rule: 'SEE_ANALYTICS', ability: 'yes', group: 'all'},
      {rule: 'CTI_ANALYTICS', ability: 'use', group: ''},
    ],
  });
});

test('create --from the JSON of acl get (rules and parent copied, the rest left out)', async () => {
  const pbx = fakePbx();
  const file = path.join(tempConfigDir(), 'sales.json');
  fs.writeFileSync(file, (await wx(pbx, ['acl', 'get', 'Sales'])).stdout);
  const r = await wx(pbx, ['acl', 'create', 'Sales2', '--from', file, '--rule', 'CALL no all']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.writes()[0].body, {
    name: 'Sales2',
    wcgrp: '2',
    rules: [
      {rule: 'CTI_ANALYTICS', ability: 'use', group: ''},
      {rule: 'CALL', ability: 'no', group: 'all'},
    ],
  });
});

test('update: name, parent, a rule replaced, added, removed; admin rules; nothing to change is refused', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['acl', 'update', 'Admin'])).code, 64);
  assert.equal((await wx(pbx, ['acl', 'update', 'Admin', '--inherits', 'Sales', '--no-inherits'])).code, 64);
  assert.equal((await wx(pbx, ['acl', 'update', 'Admin', '--rule', 'CALL no all'])).code, 64); // rights change: --yes
  let r = await text(pbx, [
    'acl',
    'update',
    'Admin',
    '--name',
    'Admins',
    '--rule',
    'CALL no all',
    '--rule',
    'EDIT_PP yes',
    '--inherits',
    'Sales',
    '--yes',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const put = pbx.writes()[0];
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/PBX/AclGroups/1/');
  assert.deepEqual(put.body, {
    name: 'Admins',
    inherits: {dn: dn(2)},
    rules: [
      {rule: 'CALL', ability: 'no', group: 'all'},
      {rule: 'EDIT_PP', ability: 'yes', group: ''},
    ],
  });
  assert.match(r.stdout, /^Admins \(id 1\) · inherits Sales$/m);
  r = await wx(pbx, [
    'acl',
    'update',
    'Admins',
    '--remove-rule',
    'EDIT_PP',
    '--admin-rule',
    'users__users epage',
    '--no-inherits',
    '--yes',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.writes()[1].body, {
    inherits: '',
    rules: [{rule: 'CALL', ability: 'no', group: 'all'}],
    adminRules: [{subject: 'users__users', operation: 'epage'}],
  });
  r = await wx(pbx, ['acl', 'update', 'Sales', '--remove-admin-rule', 'all', '--yes']);
  assert.deepEqual(pbx.writes()[2].body, {adminRules: []});
  assert.ok(!('rules' in pbx.writes()[2].body), 'rules are sent only when they change');
  assert.equal((await wx(pbx, ['acl', 'update', 'Sales', '--remove-rule', 'NOPE', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['acl', 'update', 'Sales', '--admin-rule', 'users__users maybe', '--yes'])).code, 64);
});

test('delete needs --yes; several groups by name and id in one request', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['acl', 'delete', 'Sales'])).code, 64);
  assert.equal(pbx.calls.length, 0);
  const r = await text(pbx, ['acl', 'delete', 'Sales', '1', '--yes']);
  assert.equal(r.stdout, 'Deleted the ACL groups Sales (2), Admin (1)\n');
  assert.equal(pbx.writes()[0].path, '/PBX/AclGroups/2,1/');
  assert.equal(pbx.store.size, 0);
});

test('permissions: filters as permissions[] and groups[] (ids), text per group', async () => {
  const pbx = fakePbx();
  const t = await text(pbx, ['acl', 'permissions']);
  assert.equal(
    t.stdout,
    'EDIT_PP  Modify public phonebooks  Admin -Sales\nCALL     Call                      Admin→all Sales→Sales\n',
  );
  await wx(pbx, ['acl', 'permissions', '--permission', 'CALL', '--permission', 'EDIT_PP', '--group', 'Sales']);
  assert.equal(pbx.calls.at(-1).search, '?permissions[]=CALL&permissions[]=EDIT_PP&groups[]=2');
  assert.equal((await wx(pbx, ['acl', 'permissions', '--permission', 'a b'])).code, 64);
});

test('rules and rules --admin', async () => {
  const pbx = fakePbx();
  assert.equal(
    (await text(pbx, ['acl', 'rules'])).stdout,
    'EDIT_PP  yes/no             Modify public phonebooks\nCALL     yes/no  to groups  Call\n',
  );
  assert.equal((await text(pbx, ['acl', 'rules', '--admin'])).stdout, 'users__users  epage/noepage  Users\n');
});

test('a 403 names the scope aclgroups', async () => {
  const fetch = async () => new Response(JSON.stringify({type: 'error', reason: 'Forbidden'}), {status: 403});
  const r = await run(['acl', 'list', '--pbx', 'demo'], {env: env(), fetch, registry: {groups}});
  assert.match(r.stderr, /aclgroups:read/);
});
