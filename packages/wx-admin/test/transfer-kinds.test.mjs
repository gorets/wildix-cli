import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readKinds, TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {clientOf, fakePbx} from './fake-pbx.mjs';

const state = () => ({
  '/PBX/AclGroups/': [
    {id: '7', dn: 'gid=7,o=com0,dc=wildix', name: 'Sales', wcgrp: '1', inherits: null, rules: [], adminRules: []},
  ],
  '/PBX/Colleagues/': Array.from({length: 2500}, (_, i) => ({
    id: String(i + 1),
    dn: `uid=${i + 1},o=com0,dc=wildix`,
    sourceId: String(i + 1),
    extension: String(1000 + i),
    name: `User ${i}`,
    jid: `${1000 + i}@a.wildixin.com`,
    pbx: 'a.wildixin.com',
    pbxDn: 'pbxid=SERIAL,dc=wildix',
    login: 'x',
    role: 'user',
    dialplan: 'users',
    groupDn: 'gid=7,o=com0,dc=wildix',
  })),
  '/Trunks/Sip/': [{id: '3', title: 'main', name: '+39', status: 'registered', settingsPbx: {secret: 'pw'}}],
  '/Trunks/Groups/': [{id: '4', name: 'out', description: '', rules: []}],
  '/Trunks/Prices/': [{id: '5', name: 'std', items: [{}], csv: 'dialprefix,destination,rate\n39,Italy,0.1\n'}],
  '/Dialplan/timeTables/': [{id: '11', title: 'office', items: []}],
  '/Dialplan/Ivr/': [{id: '12', title: 'menu', type: 'simple'}],
  '/Dialplan/Switches/': [{id: '13', title: 'night', state: 0, isTreeType: false}],
  '/Dialplan/PagingGroups/': [{id: '14', title: 'hall', members: []}],
  '/Dialplan/CallGroups/': [{id: '15', title: 'support', members: ['101@internalcalls'], settings: {}}],
  '/PBX/Dialplans/': [
    {id: '1', name: 'users', description: '', numbers: [{number: '100', apps: []}], includedDialplans: []},
  ],
  '/Dialplan/GeneralSettings/': {codecs: 'alaw'},
});

test('every kind reads its objects by name, without ids, dns and runtime fields', async () => {
  const pbx = fakePbx(state());
  const all = await readKinds(await clientOf(pbx), Object.keys(TRANSFER_KINDS));
  assert.deepEqual(
    all['acl-groups'].map((o) => [o.id, o.name, o.data.dn, o.data.id]),
    [['7', 'Sales', undefined, undefined]],
  );
  assert.equal(all['trunks-sip'][0].name, 'main');
  assert.equal(all['trunks-sip'][0].data.status, undefined);
  assert.equal(all['price-lists'][0].data.csv, 'dialprefix,destination,rate\n39,Italy,0.1\n');
  assert.deepEqual(
    ['timetables', 'ivr', 'switches', 'paging', 'queues'].map((k) => all[k][0].name),
    ['office', 'menu', 'night', 'hall', 'support'],
  );
  assert.deepEqual(all.dialplans[0], {
    id: '1',
    name: 'users',
    data: {name: 'users', description: '', numbers: [{number: '100', apps: []}], includedDialplans: []},
  });
  assert.deepEqual(all['dialplan-settings'], [{id: 'settings', name: 'settings', data: {codecs: 'alaw'}}]);
});

test('users are read over every page and keep no field bound to their PBX', async () => {
  const pbx = fakePbx(state());
  const {users} = await readKinds(await clientOf(pbx), ['users']);
  assert.equal(users.length, 2500);
  assert.equal(users[0].name, '1000');
  for (const k of ['id', 'dn', 'sourceId', 'jid', 'pbx', 'pbxDn', 'login', 'password', 'sipPassword'])
    assert.ok(!(k in users[0].data), k);
  assert.equal(users[0].data.groupDn, 'gid=7,o=com0,dc=wildix');
  assert.ok(pbx.calls.filter((c) => c.path === '/PBX/Colleagues/').length >= 3);
});

test('an unreadable kind is {error}, not missing', async () => {
  const s = state();
  delete s['/Trunks/Sip/'];
  const all = await readKinds(await clientOf(fakePbx(s)), ['trunks-sip', 'queues']);
  assert.match(all['trunks-sip'].error, /Access error/);
  assert.equal(all.queues.length, 1);
});

test('create answers the new id, re-reading the list when the PBX says only Success', async () => {
  const pbx = fakePbx(state());
  const client = await clientOf(pbx);
  for (const [kind, data] of [
    ['queues', {title: 'new-q', members: [], settings: {}}],
    ['trunks-sip', {title: 'new-t', name: 'l', settingsPbx: {secret: 'x'}}],
    ['trunk-groups', {name: 'new-g', description: '', rules: []}],
    ['acl-groups', {name: 'New'}],
    ['dialplans', {name: 'new-d', description: '', numbers: [], includedDialplans: []}],
    ['users', {extension: '9', name: 'n', role: 'user', dialplan: 'users'}],
  ]) {
    const id = await TRANSFER_KINDS[kind].create(client, data);
    assert.ok(id && id !== 'Success', kind);
  }
  const pid = await TRANSFER_KINDS['price-lists'].create(client, {name: 'p2', csv: 'a,b\n1,2\n'});
  assert.equal(pbx.state['/Trunks/Prices/'].find((p) => p.id === pid).csv, 'a,b\n1,2\n');
});

test('update sends the whole object to the object it names', async () => {
  const pbx = fakePbx(state());
  const client = await clientOf(pbx);
  await TRANSFER_KINDS.ivr.update(client, '12', {title: 'menu', type: 'advanced'});
  assert.deepEqual(pbx.calls.at(-1), {
    method: 'PUT',
    path: '/Dialplan/Ivr/12/',
    query: {},
    body: {title: 'menu', type: 'advanced'},
  });
  await TRANSFER_KINDS['dialplan-settings'].update(client, 'settings', {codecs: 'ulaw'});
  assert.deepEqual(pbx.state['/Dialplan/GeneralSettings/'], {codecs: 'ulaw'});
  await TRANSFER_KINDS.dialplans.update(client, '1', {
    name: 'users',
    description: 'd',
    numbers: [],
    includedDialplans: [],
  });
  assert.equal(pbx.calls.at(-1).path, '/PBX/Dialplans/1/');
  assert.deepEqual(Object.keys(pbx.calls.at(-1).body).sort(), ['description', 'includedDialplans', 'numbers']);
});

test('dialplan-db: the keys of the families asked for, by family/key; a key is written by its PUT', async () => {
  const s = {...state(), '/Dialplan/DB/fam/': {records: [{key: '/fam/a/b', value: '1'}]}};
  const pbx = fakePbx(s);
  const client = await clientOf(pbx);
  const all = await readKinds(client, ['dialplan-db'], {dbFamilies: ['fam']});
  assert.deepEqual(all['dialplan-db'], [{id: 'fam/a/b', name: 'fam/a/b', data: {value: '1'}}]);
  assert.deepEqual((await readKinds(client, ['dialplan-db']))['dialplan-db'], []);
  assert.equal(await TRANSFER_KINDS['dialplan-db'].create(client, {value: '2'}, 'fam/x'), 'fam/x');
  assert.deepEqual(pbx.state['/Dialplan/DB/fam/x/'], {value: '2'});
});
