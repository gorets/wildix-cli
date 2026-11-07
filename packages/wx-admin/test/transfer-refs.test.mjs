import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fromPortable, refsOf, toPortable} from '../src/transfer/refs.mjs';

const SOURCE = {serial: '2211000000AB', host: 'a.wildixin.com'};
const app = (name, params) => ({name, params});
const dn = (gid) => `gid=${gid},o=com0,dc=wildix`;

// A snapshot as readKinds gives it (with the dn next to the id where the PBX has one).
const snapshot = () => ({
  'acl-groups': [
    {
      id: '7',
      dn: dn(7),
      name: 'Sales',
      data: {
        name: 'Sales',
        inherits: {dn: dn(8)},
        rules: [
          {rule: 'CALL', ability: 'yes', group: dn(8)},
          {rule: 'CALL', ability: 'yes', group: 'all'},
        ],
        adminRules: [
          {subject: 'pbxid=2211000000ab,dc=wildix', operation: 'epbx'},
          {subject: 'dialplan__ivr', operation: 'epage'},
        ],
      },
    },
    {id: '8', dn: dn(8), name: 'Default', data: {name: 'Default', inherits: null, rules: [], adminRules: []}},
  ],
  users: [
    {
      id: '1',
      dn: 'uid=1,o=com0,dc=wildix',
      name: '101',
      data: {extension: '101', name: 'Ann', groupDn: dn(8), dialplan: 'users', role: 'user'},
    },
  ],
  'trunks-sip': [
    {
      id: '3',
      name: 'main',
      data: {
        title: 'main',
        name: 'login1',
        register: 'login1:pw@sip.x',
        settingsPbx: {secret: 'pw', host: 'sip.x', context: 'users'},
      },
    },
  ],
  'trunk-groups': [{id: '4', name: 'out', data: {name: 'out', rules: [{trunkName: 'main'}, {trunkName: 'login1'}]}}],
  timetables: [{id: '11', name: 'office', data: {title: 'office'}}],
  ivr: [{id: '12', name: 'Main menu', data: {title: 'Main menu'}}],
  switches: [{id: '13', name: 'night', data: {title: 'night'}}],
  paging: [{id: '14', name: 'hall', data: {title: 'hall'}}],
  queues: [
    {
      id: '1',
      name: 'Support',
      data: {title: 'Support', members: ['101@internalcalls', '777@internalcalls'], settings: {aclGroup: null}},
    },
  ],
  'dialplan-db': [{id: 'fam/a/b', name: 'fam/a/b', data: {value: '1'}}],
  dialplans: [
    {
      id: '1',
      name: 'users',
      data: {
        name: 'users',
        includedDialplans: [{dialplanId: 2}, {dialplanId: -4}],
        numbers: [
          {
            number: '100',
            apps: [
              app('Queue', {queueId: '1', mohClass: 'class1', timeout: '60'}),
              app('IVR', {ivrName: 'Main menu'}),
              app('Timetable', {timetableId: '11', dialplan: 'night', number: '1'}),
              app('GotoIfSwitchIsOn', {switchId: '13', dialplan: '', number: ''}),
              app('FeaturePaging', {groupId: '14'}),
              app('DialTrunk', {trunk: 'main', number: '${EXTEN}'}),
              app('Goto', {dialplan: 'ghost', number: '1'}),
              app('VoiceBot', {botId: 'Ysu45', language: ''}),
              app('Playback', {filename: 'welcome'}),
              app('Set', {key: 'url', value: 'https://a.wildixin.com/x'}),
            ],
          },
        ],
      },
    },
    {id: '2', name: 'night', data: {name: 'night', includedDialplans: [], numbers: []}},
  ],
  'dialplan-settings': [{id: 'settings', name: 'settings', data: {codecs: 'alaw'}}],
});

const port = () => toPortable(snapshot(), SOURCE);
const obj = (p, key) => p.kinds[key.split('/')[0]].find((o) => o.name === key.slice(key.indexOf('/') + 1)).data;
const appOf = (d, name) => d.numbers[0].apps.find((a) => a.name === name).params;

test('queueId becomes a $ref as id; ivrName a $ref as name', () => {
  const d = obj(port(), 'dialplans/users');
  assert.deepEqual(appOf(d, 'Queue').queueId, {$ref: 'queues/Support', as: 'id'});
  assert.deepEqual(appOf(d, 'IVR').ivrName, {$ref: 'ivr/Main menu', as: 'name'});
  assert.deepEqual(appOf(d, 'Timetable'), {
    timetableId: {$ref: 'timetables/office', as: 'id'},
    dialplan: {$ref: 'dialplans/night', as: 'name'},
    number: '1',
  });
  assert.deepEqual(appOf(d, 'GotoIfSwitchIsOn').switchId, {$ref: 'switches/night', as: 'id'});
  assert.deepEqual(appOf(d, 'FeaturePaging').groupId, {$ref: 'paging/hall', as: 'id'});
  assert.deepEqual(appOf(d, 'DialTrunk'), {trunk: {$ref: 'trunks-sip/main', as: 'name'}, number: '${EXTEN}'});
  assert.deepEqual(d.includedDialplans, [
    {dialplanId: {$ref: 'dialplans/night', as: 'id', number: true}},
    {dialplanId: -4},
  ]);
});

test('ACL rules by gid become $ref as dn; pbxid becomes $self; all and page subjects stay', () => {
  const g = obj(port(), 'acl-groups/Sales');
  assert.deepEqual(g.inherits, {dn: {$ref: 'acl-groups/Default', as: 'dn'}});
  assert.deepEqual(
    g.rules.map((r) => r.group),
    [{$ref: 'acl-groups/Default', as: 'dn'}, 'all'],
  );
  assert.deepEqual(
    g.adminRules.map((r) => r.subject),
    [{$self: 'pbx'}, 'dialplan__ivr'],
  );
});

test('users: group by dn and dialplan by name; queue members are soft needs of users', () => {
  const p = port();
  assert.deepEqual(obj(p, 'users/101').groupDn, {$ref: 'acl-groups/Default', as: 'dn'});
  assert.deepEqual(obj(p, 'users/101').dialplan, {$ref: 'dialplans/users', as: 'name'});
  assert.deepEqual(obj(p, 'queues/Support').members, ['101@internalcalls', '777@internalcalls']);
  assert.deepEqual(p.soft['queues/Support'], ['users/101', 'users/777']);
});

test('trunk secrets become $secret; a trunk group names its trunks by title or login', () => {
  const p = port();
  const t = obj(p, 'trunks-sip/main');
  assert.deepEqual(t.settingsPbx.secret, {$secret: 'settingsPbx.secret'});
  assert.deepEqual(t.register, {$secret: 'register'});
  assert.deepEqual(t.settingsPbx.context, {$ref: 'dialplans/users', as: 'name'});
  assert.deepEqual(
    obj(p, 'trunk-groups/out').rules.map((r) => r.trunkName),
    [
      {$ref: 'trunks-sip/main', as: 'name'},
      {$ref: 'trunks-sip/main', as: 'login'},
    ],
  );
});

test('negative dialplan ids, all, empty and ${…} stay literal; a value that matches nothing is unresolved and kept', () => {
  const p = port();
  const d = obj(p, 'dialplans/users');
  assert.equal(appOf(d, 'GotoIfSwitchIsOn').dialplan, '');
  assert.equal(appOf(d, 'Goto').dialplan, 'ghost');
  assert.deepEqual(p.unresolved, [
    {kind: 'dialplans', name: 'users', path: 'numbers[0].apps[6].params.dialplan', value: 'ghost'},
  ]);
});

test('VoiceBot is external; sounds and music on hold are outside', () => {
  const p = port();
  assert.deepEqual(appOf(obj(p, 'dialplans/users'), 'VoiceBot').botId, {$external: 'voicebot', value: 'Ysu45'});
  assert.deepEqual(p.external, [
    {kind: 'dialplans', name: 'users', path: 'numbers[0].apps[7].params.botId', what: 'voicebot'},
  ]);
  assert.deepEqual(
    p.outside.map((o) => [o.kind, o.value]),
    [
      ['moh', 'class1'],
      ['sounds', 'welcome'],
    ],
  );
});

test('needs list the hard references of each object', () => {
  const p = port();
  assert.deepEqual(p.needs['dialplans/users'].sort(), [
    'dialplans/night',
    'ivr/Main menu',
    'paging/hall',
    'queues/Support',
    'switches/night',
    'timetables/office',
    'trunks-sip/main',
  ]);
  assert.deepEqual(p.needs['users/101'].sort(), ['acl-groups/Default', 'dialplans/users']);
});

test('the serial or host left in any string marks the object bound with its path; the serial never appears', () => {
  const p = port();
  assert.deepEqual(p.bound, [
    {kind: 'dialplans', name: 'users', path: 'numbers[0].apps[9].params.value', found: 'host'},
  ]);
  assert.ok(!JSON.stringify(p).toLowerCase().includes(SOURCE.serial.toLowerCase()));
});

test('ref names keep slashes', () => {
  const p = toPortable({'dialplan-db': [{id: 'fam/a/b', name: 'fam/a/b', data: {value: '1'}}]}, SOURCE);
  assert.deepEqual(p.kinds['dialplan-db'], [{name: 'fam/a/b', data: {value: '1'}}]);
  assert.deepEqual(refsOf({x: {$ref: 'dialplan-db/fam/a/b', as: 'name'}}), [
    {kind: 'dialplan-db', name: 'fam/a/b', path: 'x'},
  ]);
});

test('a kind the PBX refused is kept as an error', () => {
  const p = toPortable({queues: {error: 'Access error'}}, SOURCE);
  assert.deepEqual(p.errors, {queues: 'Access error'});
  assert.equal(p.kinds.queues, undefined);
});

test('fromPortable puts the target values back in the form of each reference', () => {
  const d = obj(port(), 'dialplans/users');
  const target = {
    'dialplans/users': {id: '1', name: 'users'},
    'queues/Support': {id: '55', name: 'Support'},
    'dialplans/night': {id: '9', name: 'night'},
    'acl-groups/Default': {dn: 'gid=3,o=com1,dc=wildix'},
  };
  const resolve = ({kind, name, as}) => {
    const t = target[`${kind}/${name}`];
    return t && (as === 'id' ? t.id : as === 'dn' ? t.dn : name);
  };
  resolve.self = () => 'pbxid=B,dc=wildix';
  resolve.secret = (field) => ({'settingsPbx.secret': 'new-pw', register: 'login1:new-pw@sip.x'})[field];
  const out = fromPortable(
    'dialplans',
    {includedDialplans: d.includedDialplans, q: appOf(d, 'Queue'), bot: appOf(d, 'VoiceBot')},
    resolve,
  );
  assert.deepEqual(out, {
    includedDialplans: [{dialplanId: 9}, {dialplanId: -4}],
    q: {queueId: '55', mohClass: 'class1', timeout: '60'},
    bot: {botId: 'Ysu45', language: ''},
  });
  const g = fromPortable('acl-groups', obj(port(), 'acl-groups/Sales'), resolve);
  assert.equal(g.rules[0].group, 'gid=3,o=com1,dc=wildix');
  assert.equal(g.adminRules[0].subject, 'pbxid=B,dc=wildix');
  assert.equal(fromPortable('trunks-sip', obj(port(), 'trunks-sip/main'), resolve).settingsPbx.secret, 'new-pw');
  assert.throws(() => fromPortable('queues', {x: {$ref: 'queues/none', as: 'id'}}, resolve), /queues\/none/);
});

test('a secret that was not given is a MissingValue', () => {
  const resolve = () => undefined;
  resolve.secret = () => undefined;
  assert.throws(() => fromPortable('trunks-sip', {register: {$secret: 'register'}}, resolve), /secret register/);
});

test('a codec key is not a secret; secret paths use [i] for arrays', () => {
  const p = toPortable(
    {
      'trunks-sip': [
        {
          id: '1',
          name: 't',
          data: {title: 't', settingsPbx: {audioCodecs: [{key: 'alaw'}], secret: 's'}, keys: [{password: 'p'}]},
        },
      ],
    },
    SOURCE,
  );
  const t = p.kinds['trunks-sip'][0].data;
  assert.deepEqual(t.settingsPbx.audioCodecs, [{key: 'alaw'}]);
  assert.deepEqual(t.keys, [{password: {$secret: 'keys[0].password'}}]);
});

test('review 5: a soft user reference stays literal (an extension is portable), only noted as soft', () => {
  const p = toPortable(
    {
      users: [{id: '1', name: '101', data: {extension: '101'}}],
      dialplans: [
        {
          id: '1',
          name: 'm',
          data: {
            name: 'm',
            includedDialplans: [],
            numbers: [
              {number: '1', apps: [{name: 'GotoIfUserStatus', params: {user: '101', dialplan: '', number: ''}}]},
            ],
          },
        },
      ],
    },
    SOURCE,
  );
  assert.equal(p.kinds.dialplans[0].data.numbers[0].apps[0].params.user, '101');
  assert.deepEqual(p.soft['dialplans/m'], ['users/101']);
  assert.equal(p.needs['dialplans/m'], undefined);
});

test('review 8: a pbxid of another PBX stays literal and is unresolved; without the source serial nothing becomes $self', () => {
  const s = snapshot();
  s['acl-groups'][0].data.adminRules.push({subject: 'pbxid=cccc00000009,dc=wildix', operation: 'epbx'});
  const p = toPortable(s, SOURCE);
  const rules = obj(p, 'acl-groups/Sales').adminRules;
  assert.equal(rules[2].subject, 'pbxid=cccc00000009,dc=wildix');
  assert.ok(p.unresolved.some((u) => u.value === 'pbxid=cccc00000009,dc=wildix'));
  const q = toPortable(snapshot(), {serial: null, host: SOURCE.host});
  assert.ok(!JSON.stringify(q.kinds).includes('$self'));
});
