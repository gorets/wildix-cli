import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {saveAccess} from '../src/pbx.mjs';
import {fakePbx} from './fake-pbx.mjs';
import {run, tempConfigDir} from './helpers.mjs';

// Pins what config export, import and copy do today for a PBX, so that generalising the engine can be proved to
// change nothing: exact exported lines, exact calls received by the target PBX.

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const SERIAL = '2211000000ab';
const TARGET_SERIAL = '2211000000cd';
const gid = (n) => `gid=${n},o=com0,dc=wildix`;

const SOURCE = () => ({
  '/PBX/settings/': {pbxSerial: SERIAL},
  '/PBX/version/': {version: '7.11.20261106.2'},
  '/PBX/AclGroups/': [
    {
      id: '1',
      dn: gid(1),
      name: 'alpha',
      inherits: null,
      rules: [{rule: 'CALL', ability: 'yes', group: gid(2)}],
      adminRules: [],
    },
    {
      id: '2',
      dn: gid(2),
      name: 'beta',
      inherits: null,
      rules: [{rule: 'CALL', ability: 'yes', group: gid(1)}],
      adminRules: [],
    },
  ],
  '/PBX/Colleagues/': [],
  '/Trunks/Sip/': [
    {id: '3', title: 'carrier', name: 'login', settingsPbx: {secret: 'pw', host: 'sip.example.com', context: 'users'}},
  ],
  '/Trunks/Groups/': [],
  '/Trunks/Prices/': [],
  '/Dialplan/timeTables/': [{id: '11', title: 'office', items: [1]}],
  '/Dialplan/Ivr/': [],
  '/Dialplan/Switches/': [],
  '/Dialplan/PagingGroups/': [],
  '/Dialplan/CallGroups/': [{id: '5', title: 'support', members: [], settings: {aclGroup: null}}],
  '/PBX/Dialplans/': [
    {
      id: '1',
      name: 'main',
      description: '',
      includedDialplans: [],
      numbers: [
        {
          number: '1',
          apps: [
            {name: 'Queue', params: {queueId: '5'}},
            {name: 'Timetable', params: {timetableId: '11', dialplan: '', number: ''}},
            {name: 'DialTrunk', params: {trunk: 'carrier'}},
          ],
        },
      ],
    },
  ],
  '/Dialplan/DB/cfg/': {records: []},
  '/Dialplan/GeneralSettings/': {codecs: 'alaw'},
});

const EMPTY_TARGET = () => ({
  '/PBX/settings/': {pbxSerial: TARGET_SERIAL},
  '/PBX/version/': {version: '7.11.20261106.2'},
  '/PBX/settings/license/': {limitations: {licenseTypes: {business: 5}}, licenseUsage: {business: 1}},
  '/Sounds/': {records: []},
  '/Sounds/MusicOnHold/': {records: []},
  '/Phonebooks/?count=1000': {records: []},
  '/PBX/AclGroups/': [],
  '/PBX/Colleagues/': [],
  '/Trunks/Sip/': [],
  '/Trunks/Groups/': [],
  '/Trunks/Prices/': [],
  '/Dialplan/timeTables/': [],
  '/Dialplan/Ivr/': [],
  '/Dialplan/Switches/': [],
  '/Dialplan/PagingGroups/': [],
  '/Dialplan/CallGroups/': [],
  '/PBX/Dialplans/': [],
});

const secretsFile = () => {
  const f = path.join(tempConfigDir(), 'secrets.json');
  fs.writeFileSync(f, JSON.stringify({'trunks-sip/carrier': {password: 'new-pw'}}));
  return f;
};
const readJsonl = (dir, kind) =>
  fs
    .readFileSync(path.join(dir, `${kind}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const sent = (pbx) => pbx.calls.map((c) => [c.method, c.path, c.body]);
const hostEnv = (host) => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: host});

async function exportSource() {
  const pbx = fakePbx(SOURCE());
  const dir = path.join(tempConfigDir(), 'exp');
  const r = await run(['config', 'export', '--to', dir, '--pbx', 'a.wildixin.com', '--all'], {
    env: hostEnv('a.wildixin.com'),
    fetch: pbx.fetch,
  });
  assert.equal(r.code, 0, r.stderr);
  return dir;
}

test('export folder is unchanged', async () => {
  const dir = await exportSource();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  delete manifest.source.exportedAt;
  assert.deepEqual(manifest, MANIFEST);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    Object.keys(LINES)
      .map((k) => `${k}.jsonl`)
      .concat('manifest.json')
      .sort(),
  );
  for (const [kind, lines] of Object.entries(LINES)) assert.deepEqual(readJsonl(dir, kind), lines, kind);
});

test('import calls are unchanged', async () => {
  const dir = await exportSource();
  const pbx = fakePbx(EMPTY_TARGET());
  const r = await run(
    [
      'config',
      'import',
      dir,
      '--pbx',
      'b.wildixin.com',
      '--all',
      '--yes',
      '--secrets',
      secretsFile(),
      '--log',
      tempConfigDir(),
    ],
    {env: hostEnv('b.wildixin.com'), fetch: pbx.fetch},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sent(pbx), CALLS);
});

test('copy calls are unchanged', async () => {
  const a = fakePbx(SOURCE());
  const b = fakePbx(EMPTY_TARGET());
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  saveAccess({host: 'a.wildixin.com', port: 443, auth: 'apikey', key: KEY}, env);
  saveAccess({host: 'b.wildixin.com', port: 443, auth: 'apikey', key: KEY}, env);
  const fetch = (url, init) => (new URL(url).hostname === 'a.wildixin.com' ? a.fetch(url, init) : b.fetch(url, init));
  const r = await run(
    [
      'config',
      'copy',
      '--from',
      'a.wildixin.com',
      '--to',
      'b.wildixin.com',
      '--all',
      '--yes',
      '--secrets',
      secretsFile(),
      '--log',
      tempConfigDir(),
    ],
    {env, fetch},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sent(a), COPY_SOURCE_CALLS);
  assert.deepEqual(sent(b), [['GET', '/PBX/settings/', undefined], ...CALLS]);
});

const MANIFEST = {
  format: 'wx-admin-export/1',
  source: {host: 'a.wildixin.com', wms: '7.11.20261106.2'},
  kinds: {'acl-groups': 2, 'trunks-sip': 1, timetables: 1, queues: 1, dialplans: 1, 'dialplan-settings': 1},
  errors: {},
  bound: [],
  external: [],
  unresolved: [{kind: 'trunks-sip', name: 'carrier', path: 'settingsPbx.context', value: 'users'}],
  outside: [],
  needs: {
    'acl-groups/alpha': ['acl-groups/beta'],
    'acl-groups/beta': ['acl-groups/alpha'],
    'dialplans/main': ['queues/support', 'timetables/office', 'trunks-sip/carrier'],
  },
  soft: {},
};
const LINES = {
  'acl-groups': [
    {
      name: 'alpha',
      data: {
        name: 'alpha',
        inherits: null,
        rules: [{rule: 'CALL', ability: 'yes', group: {$ref: 'acl-groups/beta', as: 'dn'}}],
        adminRules: [],
      },
    },
    {
      name: 'beta',
      data: {
        name: 'beta',
        inherits: null,
        rules: [{rule: 'CALL', ability: 'yes', group: {$ref: 'acl-groups/alpha', as: 'dn'}}],
        adminRules: [],
      },
    },
  ],
  'dialplan-settings': [{name: 'settings', data: {codecs: 'alaw'}}],
  dialplans: [
    {
      name: 'main',
      data: {
        name: 'main',
        description: '',
        includedDialplans: [],
        numbers: [
          {
            number: '1',
            apps: [
              {name: 'Queue', params: {queueId: {$ref: 'queues/support', as: 'id'}}},
              {
                name: 'Timetable',
                params: {timetableId: {$ref: 'timetables/office', as: 'id'}, dialplan: '', number: ''},
              },
              {name: 'DialTrunk', params: {trunk: {$ref: 'trunks-sip/carrier', as: 'name'}}},
            ],
          },
        ],
      },
    },
  ],
  queues: [{name: 'support', data: {title: 'support', members: [], settings: {aclGroup: null}}}],
  timetables: [{name: 'office', data: {title: 'office', items: [1]}}],
  'trunks-sip': [
    {
      name: 'carrier',
      data: {
        title: 'carrier',
        name: 'login',
        settingsPbx: {secret: {$secret: 'settingsPbx.secret'}, host: 'sip.example.com', context: 'users'},
      },
    },
  ],
};
const CALLS = [
  ['GET', '/PBX/settings/', undefined],
  ['GET', '/PBX/AclGroups/', undefined],
  ['GET', '/Trunks/Sip/', undefined],
  ['GET', '/Dialplan/timeTables/', undefined],
  ['GET', '/Dialplan/CallGroups/', undefined],
  ['GET', '/PBX/Dialplans/', undefined],
  ['GET', '/Dialplan/GeneralSettings/', undefined],
  ['GET', '/PBX/settings/license/', undefined],
  ['GET', '/Sounds/MusicOnHold/', undefined],
  ['GET', '/Sounds/', undefined],
  ['GET', '/Phonebooks/', undefined],
  ['POST', '/PBX/AclGroups/', {name: 'alpha'}],
  ['POST', '/PBX/AclGroups/', {name: 'beta'}],
  ['POST', '/PBX/Dialplans/', {name: 'main', description: '', numbers: [], includedDialplans: []}],
  ['GET', '/PBX/AclGroups/', undefined],
  [
    'PUT',
    '/PBX/AclGroups/1000/',
    {
      name: 'alpha',
      inherits: null,
      rules: [{rule: 'CALL', ability: 'yes', group: 'gid=1001,o=com0,dc=wildix'}],
      adminRules: [],
    },
  ],
  [
    'PUT',
    '/PBX/AclGroups/1001/',
    {
      name: 'beta',
      inherits: null,
      rules: [{rule: 'CALL', ability: 'yes', group: 'gid=1000,o=com0,dc=wildix'}],
      adminRules: [],
    },
  ],
  [
    'POST',
    '/Trunks/Sip/',
    {title: 'carrier', name: 'login', settingsPbx: {secret: 'new-pw', host: 'sip.example.com', context: 'users'}},
  ],
  ['GET', '/Trunks/Sip/', undefined],
  ['POST', '/Dialplan/timeTables/', {title: 'office', items: [1]}],
  ['GET', '/Dialplan/timeTables/', undefined],
  ['POST', '/Dialplan/CallGroups/', {title: 'support', members: [], settings: {aclGroup: null}}],
  ['GET', '/Dialplan/CallGroups/', undefined],
  [
    'PUT',
    '/PBX/Dialplans/1002/',
    {
      description: '',
      numbers: [
        {
          number: '1',
          apps: [
            {name: 'Queue', params: {queueId: '1005'}},
            {name: 'Timetable', params: {timetableId: '1004', dialplan: '', number: ''}},
            {name: 'DialTrunk', params: {trunk: 'carrier'}},
          ],
        },
      ],
      includedDialplans: [],
    },
  ],
];

// The source PBX of a copy is only read: the serial (twice: the identity check and the export), then every kind.
const COPY_SOURCE_CALLS = [
  ['GET', '/PBX/settings/', undefined],
  ['GET', '/PBX/settings/', undefined],
  ['GET', '/PBX/version/', undefined],
  ['GET', '/PBX/AclGroups/', undefined],
  ['GET', '/Trunks/Sip/', undefined],
  ['GET', '/Trunks/Groups/', undefined],
  ['GET', '/Trunks/Prices/', undefined],
  ['GET', '/Dialplan/timeTables/', undefined],
  ['GET', '/Dialplan/Ivr/', undefined],
  ['GET', '/Dialplan/Switches/', undefined],
  ['GET', '/Dialplan/PagingGroups/', undefined],
  ['GET', '/Dialplan/CallGroups/', undefined],
  ['GET', '/PBX/Dialplans/', undefined],
  ['GET', '/PBX/Dialplans/1/', undefined],
  ['GET', '/Dialplan/GeneralSettings/', undefined],
];
