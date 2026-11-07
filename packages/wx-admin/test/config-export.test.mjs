import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {toPortable} from '../src/transfer/refs.mjs';
import {chooseExport, closure, dbFamiliesOf, parseOnly, pickerGroups} from '../src/transfer/selection.mjs';
import {fakePbx} from './fake-pbx.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});
const SERIAL = '2211000000ab';
const gid = (n) => `gid=${n},o=com0,dc=wildix`;

// An anonymised copy of the test PBX: dialplans, queues, ACL groups, SIP trunks, a user.
const STATE = () => ({
  '/PBX/settings/': {pbxSerial: SERIAL},
  '/PBX/version/': {version: '7.11.20261106.2'},
  '/PBX/AclGroups/': [
    {
      id: '1',
      dn: gid(1),
      name: 'Default',
      inherits: null,
      rules: [],
      adminRules: [{subject: `pbxid=${SERIAL},dc=wildix`, operation: 'epbx'}],
    },
    {
      id: '2',
      dn: gid(2),
      name: 'Admin',
      inherits: null,
      rules: [{rule: 'CALL', ability: 'yes', group: gid(1)}],
      adminRules: [],
    },
  ],
  '/PBX/Colleagues/': [
    {id: '9', dn: 'uid=9', extension: '101', name: 'Ann', role: 'user', dialplan: 'users', groupDn: gid(1)},
  ],
  '/Trunks/Sip/': [
    {id: '3', title: 'carrier', name: 'login', settingsPbx: {secret: 'pw', host: 'sip.example.com', context: 'users'}},
  ],
  '/Trunks/Groups/': [],
  '/Trunks/Prices/': [],
  '/Dialplan/timeTables/': [{id: '11', title: 'office', items: []}],
  '/Dialplan/Ivr/': [],
  '/Dialplan/Switches/': [],
  '/Dialplan/PagingGroups/': [],
  '/Dialplan/CallGroups/': [{id: '1', title: 'support', members: ['101@internalcalls'], settings: {aclGroup: null}}],
  '/PBX/Dialplans/': [
    {
      id: '1',
      name: 'users',
      description: '',
      includedDialplans: [],
      numbers: [{number: '9', apps: [{name: 'Set', params: {key: 'x', value: '${DB(cfg/night)}'}}]}],
    },
    {
      id: '2',
      name: 'main',
      description: '',
      includedDialplans: [{dialplanId: 1}],
      numbers: [
        {
          number: '1',
          apps: [
            {name: 'Queue', params: {queueId: '1'}},
            {name: 'Timetable', params: {timetableId: '11', dialplan: '', number: ''}},
          ],
        },
      ],
    },
    {
      id: '3',
      name: 'leaky',
      description: '',
      includedDialplans: [],
      numbers: [{number: '2', apps: [{name: 'Set', params: {key: 'u', value: 'https://demo.wildixin.com/x'}}]}],
    },
  ],
  '/Dialplan/DB/cfg/': {records: [{key: '/cfg/night', value: '0'}]},
  '/Dialplan/GeneralSettings/': {codecs: 'alaw'},
});

const exportTo = async (args) => {
  const pbx = fakePbx(STATE());
  const dir = path.join(tempConfigDir(), 'exp');
  const r = await run(['config', 'export', '--to', dir, '--pbx', 'demo', ...args], {env: env(), fetch: pbx.fetch});
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const read = (kind) =>
    fs
      .readFileSync(path.join(dir, `${kind}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {r, dir, files, read, pbx};
};

test('--all exports everything but users and bound objects; the serial is nowhere', async () => {
  const {r, dir, files, read} = await exportTo(['--all']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!files.includes('users.jsonl'));
  assert.deepEqual(
    read('dialplans')
      .map((o) => o.name)
      .sort(),
    ['main', 'users'],
  );
  assert.deepEqual(read('dialplan-db'), [{name: 'cfg/night', data: {value: '0'}}]);
  for (const f of files) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(SERIAL), f);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.bound, [
    {kind: 'dialplans', name: 'leaky', path: 'numbers[0].apps[0].params.value', found: 'host'},
  ]);
});

test('--users adds users', async () => {
  const {read} = await exportTo(['--all', '--users']);
  assert.deepEqual(
    read('users').map((o) => o.name),
    ['101'],
  );
});

test('--only dialplans:main brings what main needs', async () => {
  const {r, read, files} = await exportTo(['--only', 'dialplans:main']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    read('dialplans')
      .map((o) => o.name)
      .sort(),
    ['main', 'users'],
  );
  assert.deepEqual(
    read('queues').map((o) => o.name),
    ['support'],
  );
  assert.deepEqual(
    read('timetables').map((o) => o.name),
    ['office'],
  );
  assert.ok(!files.includes('trunks-sip.jsonl'));
});

test('without a terminal and without --all/--only it refuses, before writing', async () => {
  const {r, files} = await exportTo([]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--all or --only/);
  assert.deepEqual(files, []);
});

test('parseOnly: kinds and names, * for every object of a kind; unknown kinds refused', () => {
  assert.deepEqual(parseOnly('dialplans:main,queues:*,dialplan-db:cfg/a'), [
    {kind: 'dialplans', name: 'main'},
    {kind: 'queues', name: '*'},
    {kind: 'dialplan-db', name: 'cfg/a'},
  ]);
  assert.throws(() => parseOnly('nope:x'), /Unknown kind/);
});

test('dbFamiliesOf finds the families dialplans read', () => {
  assert.deepEqual(dbFamiliesOf([{data: {numbers: [{apps: [{params: {v: '${DB(cfg/a)} ${DB_EXISTS(other/b)}'}}]}]}}]), [
    'cfg',
    'other',
  ]);
});

test('the picker gets the groups, bound objects disabled; its choice and their needs are exported', async () => {
  const snap = {
    dialplans: [
      {
        id: '2',
        name: 'main',
        data: {numbers: [{number: '1', apps: [{name: 'Queue', params: {queueId: '1'}}]}], includedDialplans: []},
      },
      {
        id: '3',
        name: 'leaky',
        data: {numbers: [{number: '1', apps: [{name: 'Set', params: {value: 'demo.wildixin.com'}}]}]},
      },
    ],
    queues: [{id: '1', name: 'support', data: {title: 'support'}}],
    users: [{id: '9', name: '101', data: {extension: '101'}}],
  };
  const portable = toPortable(snap, {serial: SERIAL, host: 'demo.wildixin.com'});
  const groups = pickerGroups(portable, {});
  assert.equal(pickerGroups(portable, {users: true})[1].items[0].checked, true);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['routing', 'users'],
  );
  const leaky = groups[0].items.find((i) => i.id === 'dialplans/leaky');
  assert.match(leaky.disabled, /bound to the source PBX/);
  assert.equal(groups[1].items[0].checked, false);
  assert.deepEqual([...closure(portable, new Set(['dialplans/main']))].sort(), ['dialplans/main', 'queues/support']);
  const picked = await chooseExport(
    portable,
    {},
    {
      interactive: true,
      select: async (opts) => {
        assert.equal(opts.requires('dialplans/main')[0], 'queues/support');
        return new Set(['dialplans/main', 'queues/support']);
      },
    },
  );
  assert.deepEqual([...picked].sort(), ['dialplans/main', 'queues/support']);
});
