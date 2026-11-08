import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {PBX_PORTABLE} from '../src/transfer/pbx-portable.mjs';
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

test('the portable hooks of the PBX kinds are on their kinds, and toPortable drives a kind through its hook', (t) => {
  for (const [kind, hook] of Object.entries(PBX_PORTABLE)) assert.equal(TRANSFER_KINDS[kind].portable, hook, kind);
  assert.deepEqual(Object.keys(PBX_PORTABLE).sort(), [
    'acl-groups',
    'dialplans',
    'queues',
    'trunk-groups',
    'trunks-sip',
    'users',
  ]);
  const saved = TRANSFER_KINDS.ivr.portable;
  t.after(() => {
    if (saved) TRANSFER_KINDS.ivr.portable = saved;
    else delete TRANSFER_KINDS.ivr.portable;
  });
  TRANSFER_KINDS.ivr.portable = (data, h) => {
    data.next = h.ref(data.next, 'switches', 'next', ['name']);
    h.secret(data, 'pin', 'pin');
    h.soft('users/100');
  };
  const p = toPortable(
    {
      switches: [{id: '1', name: 'night', data: {title: 'night'}}],
      ivr: [{id: '2', name: 'menu', data: {title: 'menu', next: 'night', pin: '1234'}}],
    },
    SOURCE,
  );
  assert.deepEqual(p.kinds.ivr[0].data, {
    title: 'menu',
    next: {$ref: 'switches/night', as: 'name'},
    pin: {$secret: 'pin'},
  });
  assert.deepEqual(p.needs['ivr/menu'], ['switches/night']);
  assert.deepEqual(p.soft['ivr/menu'], ['users/100']);
});

// Fake kinds (cloud side, service `fake`), registered for one test.
function fakeKind(t, name, extra = {}) {
  TRANSFER_KINDS[name] = {group: 'test', label: name, side: 'cloud', service: 'fake', read: async () => [], ...extra};
  t.after(() => delete TRANSFER_KINDS[name]);
}

test('cloud object changed by maskCloud is bound', async (t) => {
  fakeKind(t, 'test-hooks', {
    portable(data, h) {
      h.secret(data.handler, 'token', 'handler.token');
      data.owner = h.ref(data.owner, 'test-hooks', 'owner', ['name']);
    },
  });
  const p = toPortable(
    {
      'test-hooks': [
        {
          id: '1',
          name: 'leaky',
          data: {owner: 'clean', handler: {url: 'https://x.example/', token: 't', customHeaders: {'X-Key': 'v'}}},
        },
        {id: '2', name: 'clean', data: {owner: 'clean', handler: {url: 'https://x.example/', token: 't'}}},
      ],
    },
    SOURCE,
  );
  assert.deepEqual(p.bound, [
    {kind: 'test-hooks', name: 'leaky', path: 'handler.customHeaders.X-Key', found: 'secret'},
  ]);
  assert.deepEqual(
    p.kinds['test-hooks'].map((o) => o.name),
    ['leaky', 'clean'],
  );
  assert.deepEqual(p.kinds['test-hooks'][1].data.handler.token, {$secret: 'handler.token'});
  const {chooseExport} = await import('../src/transfer/selection.mjs');
  assert.deepEqual([...(await chooseExport(p, {all: true, cloud: true}, {interactive: false}))], ['test-hooks/clean']);
  const {boundText} = await import('../src/transfer/refs.mjs');
  assert.equal(boundText(p.bound[0]), 'secret field handler.customHeaders.X-Key not known');
});

test('h.bound marks the object bound with the hook reason', async (t) => {
  fakeKind(t, 'test-nango', {
    portable(data, h) {
      h.bound('config.gdrive.nangoConnectionId', 'nango');
      delete data.id;
    },
  });
  const p = toPortable({'test-nango': [{id: '1', name: 'drive', data: {id: 'conn-1'}}]}, SOURCE);
  assert.deepEqual(p.bound, [
    {kind: 'test-nango', name: 'drive', path: 'config.gdrive.nangoConnectionId', found: 'nango'},
  ]);
  const {boundText} = await import('../src/transfer/refs.mjs');
  assert.equal(boundText(p.bound[0]), 'bound to a Nango connection of the source (config.gdrive.nangoConnectionId)');
});

test('a PBX kind is not checked by the mask', () => {
  const p = toPortable({ivr: [{id: '1', name: 'm', data: {title: 'm', customHeaders: {'X-Key': 'v'}}}]}, SOURCE);
  assert.deepEqual(p.bound, []);
});

test('company id in a string is bound', () => {
  const p = toPortable(
    {
      ivr: [
        {id: '1', name: 'm', data: {title: 'm', url: 'https://hooks.example/IT_X/in'}},
        {id: '2', name: 'n', data: {title: 'n', url: 'https://hooks.example/it_y/in'}},
      ],
    },
    {...SOURCE, company: 'it_x'},
  );
  assert.deepEqual(p.bound, [{kind: 'ivr', name: 'm', path: 'url', found: 'company'}]);
});

// An agent pinned to a version of a tool; the hook deletes the pin when h.version answers undefined.
function pinned(t) {
  fakeKind(t, 'test-tools');
  fakeKind(t, 'test-agents', {
    portable(data, h) {
      const v = h.version('test-tools', data.tool, data.toolVersion, 'toolVersion');
      if (v === undefined) delete data.toolVersion;
      else data.toolVersion = v;
    },
  });
  return toPortable(
    {
      'test-tools': [{id: 't1', name: 'lookup', version: 3, data: {}}],
      'test-agents': [
        {id: 'a1', name: 'latest', data: {tool: 'lookup', toolVersion: '3'}},
        {id: 'a2', name: 'older', data: {tool: 'lookup', toolVersion: 2}},
      ],
    },
    SOURCE,
  );
}

test('version pin equal to latest becomes a version ref', (t) => {
  const p = pinned(t);
  assert.deepEqual(p.kinds['test-agents'][0].data, {
    tool: 'lookup',
    toolVersion: {$ref: 'test-tools/lookup', as: 'version'},
  });
  assert.deepEqual(p.needs['test-agents/latest'], ['test-tools/lookup']);
});

test('older pin is dropped with a warning', async (t) => {
  const p = pinned(t);
  assert.deepEqual(p.kinds['test-agents'][1].data, {tool: 'lookup'});
  assert.deepEqual(p.warnings, [
    {kind: 'test-agents', name: 'older', path: 'toolVersion', text: 'pinned to an older version, dropped'},
  ]);
  assert.equal(p.needs['test-agents/older'], undefined);
  const {selectFrom} = await import('../src/transfer/selection.mjs');
  assert.deepEqual(selectFrom(p, new Set(['test-agents/latest'])).warnings, []);
  assert.deepEqual(selectFrom(p, new Set(['test-agents/older'])).warnings, p.warnings);
});

test('lookup kinds are indexed, not exported', (t) => {
  fakeKind(t, 'test-people', {lookup: true});
  fakeKind(t, 'test-agents', {
    portable(data, h) {
      data.owner = h.ref(data.owner, 'test-people', 'owner');
    },
  });
  const p = toPortable(
    {
      'test-people': [{id: 'u1', name: 'ann@x.example', data: {email: 'ann@x.example'}}],
      'test-agents': [{id: 'a1', name: 'bot', data: {owner: 'u1'}}],
    },
    SOURCE,
  );
  assert.deepEqual(Object.keys(p.kinds), ['test-agents']);
  assert.deepEqual(p.kinds['test-agents'][0].data.owner, {$ref: 'test-people/ann@x.example', as: 'id'});
  assert.deepEqual(p.needs['test-agents/bot'], ['test-people/ann@x.example']);
});

test('fix 1: a secret in the value of an $external marker is bound at the marker path', async (t) => {
  fakeKind(t, 'test-hooks', {
    portable(data, h) {
      data.hook = h.external('hook', 'url', data.hook);
    },
  });
  const p = toPortable(
    {
      'test-hooks': [
        {id: '1', name: 'leaky', data: {hook: 'https://e.example/in?token=abc'}},
        {id: '2', name: 'clean', data: {hook: 'https://e.example/in'}},
      ],
    },
    SOURCE,
  );
  assert.deepEqual(p.bound, [{kind: 'test-hooks', name: 'leaky', path: 'hook', found: 'secret'}]);
  const {chooseExport} = await import('../src/transfer/selection.mjs');
  assert.deepEqual([...(await chooseExport(p, {all: true, cloud: true}, {interactive: false}))], ['test-hooks/clean']);
});

test('fix 1: a marker next to a plain secret does not hide it', (t) => {
  fakeKind(t, 'test-hooks', {
    portable(data, h) {
      h.secret(data.auth, 'secret', 'auth.secret');
    },
  });
  const p = toPortable(
    {'test-hooks': [{id: '1', name: 'pair', data: {auth: {secret: 's', password: 'plain'}}}]},
    SOURCE,
  );
  assert.deepEqual(p.kinds['test-hooks'][0].data.auth.secret, {$secret: 'auth.secret'});
  assert.deepEqual(p.bound, [{kind: 'test-hooks', name: 'pair', path: 'auth.password', found: 'secret'}]);
});

// A voice URI that names a secret in its query: the reference becomes an argument of a $template.
const VOICE_KEY = /[?&]apiKey=secrets:([A-Za-z0-9_-]+)/g;
function voices(t, list) {
  fakeKind(t, 'test-secrets');
  fakeKind(t, 'test-voices', {
    portable(data, h) {
      data.voice = h.template(data.voice, 'voice', VOICE_KEY, 'test-secrets', ['id']);
    },
  });
  return toPortable(
    {
      'test-secrets': [{id: 'S1', name: 'eleven', data: {}}],
      'test-voices': list.map(([name, voice], i) => ({id: `v${i}`, name, data: {voice}})),
    },
    SOURCE,
  );
}

test('a reference inside a string is a $template: its args are references, put back by fromPortable', (t) => {
  const p = voices(t, [
    ['own', 'elevenlabs://abc?model=x&apiKey=secrets:S1'],
    ['braces', 'x://{0}?apiKey=secrets:S1&b={}'],
    ['gone', 'elevenlabs://abc?apiKey=secrets:S9'],
    ['plain', 'google://en-US-Chirp3-HD-Aoede'],
  ]);
  const [own, braces, gone, plain] = p.kinds['test-voices'].map((o) => o.data.voice);
  const ref = {$ref: 'test-secrets/eleven', as: 'id'};
  assert.deepEqual(own, {$template: 'elevenlabs://abc?model=x&apiKey=secrets:{0}', args: [ref]});
  assert.deepEqual(braces, {$template: 'x://{{0}}?apiKey=secrets:{0}&b={{}}', args: [ref]});
  assert.equal(gone, 'elevenlabs://abc?apiKey=secrets:S9');
  assert.equal(plain, 'google://en-US-Chirp3-HD-Aoede');
  assert.deepEqual(p.unresolved, [{kind: 'test-voices', name: 'gone', path: 'voice', value: 'S9'}]);
  assert.deepEqual(p.needs, {
    'test-voices/own': ['test-secrets/eleven'],
    'test-voices/braces': ['test-secrets/eleven'],
  });
  assert.deepEqual(refsOf({voice: own}), [{kind: 'test-secrets', name: 'eleven', path: 'voice.args[0]'}]);
  // The mask takes a reference to a Wilma secret for what it is: nothing is bound.
  assert.deepEqual(p.bound, []);

  const resolve = ({kind, name, as}) =>
    kind === 'test-secrets' && name === 'eleven' && as === 'id' ? 'T7' : undefined;
  assert.equal(fromPortable('test-voices', own, resolve), 'elevenlabs://abc?model=x&apiKey=secrets:T7');
  assert.equal(fromPortable('test-voices', braces, resolve), 'x://{0}?apiKey=secrets:T7&b={}');
  assert.throws(() => fromPortable('test-voices', own, () => undefined), /test-secrets\/eleven is not on the target/);
});

test('the safety net checks the string of a $template; the serial in it binds the object', (t) => {
  const p = voices(t, [
    ['leaky', 'elevenlabs://abc?token=tk-1&apiKey=secrets:S1'],
    ['serial', `elevenlabs://${SOURCE.serial}?apiKey=secrets:S1`],
  ]);
  assert.deepEqual(p.kinds['test-voices'][0].data.voice.$template, 'elevenlabs://abc?token=tk-1&apiKey=secrets:{0}');
  assert.deepEqual(p.bound, [
    {kind: 'test-voices', name: 'leaky', path: 'voice', found: 'secret'},
    {kind: 'test-voices', name: 'serial', path: 'voice', found: 'serial'},
  ]);
});

test('a cloud object whose name the mask changes goes by the masked name and is bound', () => {
  const p = toPortable(
    {
      'kite-channels': [{id: 'sms:1', name: 'sms:+3902?token=Tok3nInName', data: {routes: []}}],
      'wilma-secrets': [{id: 'S1', name: 'plain', data: {name: 'plain'}}],
    },
    SOURCE,
  );
  assert.deepEqual(
    p.kinds['kite-channels'].map((o) => o.name),
    ['sms:+3902?token=********'],
  );
  assert.deepEqual(p.bound, [{kind: 'kite-channels', name: 'sms:+3902?token=********', path: 'name', found: 'secret'}]);
  assert.ok(!JSON.stringify(p).includes('Tok3nInName'));
  assert.deepEqual(
    p.kinds['wilma-secrets'].map((o) => o.name),
    ['plain'],
  );
});
