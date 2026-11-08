import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {makePlan} from '../src/transfer/plan.mjs';
import {toPortable} from '../src/transfer/refs.mjs';

const A = {serial: 'aaaa00000001', host: 'a.wildixin.com'};
const B = {serial: 'bbbb00000002', host: 'b.wildixin.com'};
const gid = (n) => `gid=${n},o=com0,dc=wildix`;

// The source as exported, and a target snapshot as readKinds gives it.
const SOURCE = () =>
  toPortable(
    {
      dialplans: [
        {
          id: '1',
          name: 'main',
          data: {
            name: 'main',
            includedDialplans: [],
            numbers: [
              {
                number: '1',
                apps: [
                  {name: 'Queue', params: {queueId: '5', mohClass: 'jazz'}},
                  {name: 'Playback', params: {filename: 'hello'}},
                ],
              },
            ],
          },
        },
        {id: '2', name: 'users', data: {name: 'users', includedDialplans: [], numbers: []}},
        {
          id: '3',
          name: 'night',
          data: {
            name: 'night',
            includedDialplans: [],
            numbers: [{number: '1', apps: [{name: 'IVR', params: {ivrName: 'menu'}}]}],
          },
        },
      ],
      queues: [
        {
          id: '5',
          name: 'support',
          data: {title: 'support', members: ['101@internalcalls', '777@internalcalls'], settings: {}},
        },
      ],
      ivr: [{id: '6', name: 'menu', data: {title: 'menu'}}],
      'acl-groups': [
        {id: '7', dn: gid(7), name: 'Sales', data: {name: 'Sales', inherits: null, rules: [], adminRules: []}},
      ],
      users: [
        {
          id: '1',
          name: '101',
          data: {
            extension: '101',
            name: 'Ann',
            email: 'ann@x.example',
            licenseType: 'business',
            groupDn: gid(7),
            dialplan: 'users',
          },
        },
        {
          id: '2',
          name: '102',
          data: {extension: '102', name: 'Bob', email: '', licenseType: 'business', groupDn: gid(7), dialplan: 'users'},
        },
        {
          id: '3',
          name: '103',
          data: {extension: '103', name: 'Cid', email: '', licenseType: 'premium', groupDn: gid(7), dialplan: 'users'},
        },
      ],
    },
    A,
  );
const TARGET = () => ({
  dialplans: [{id: '40', name: 'users', data: {name: 'users', includedDialplans: [], numbers: []}}],
  queues: [],
  ivr: {error: 'Access error'},
  'acl-groups': [
    {id: '70', dn: gid(70), name: 'Default', data: {name: 'Default', inherits: null, rules: [], adminRules: []}},
  ],
  users: [{id: '9', name: '103', data: {extension: '103', name: 'Someone else', licenseType: 'premium'}}],
});
const CHECKS = {licenses: {business: 1, premium: 5}, sounds: ['hello'], moh: [], phonebooks: []};
const plan = (source = SOURCE(), target = TARGET(), checks = CHECKS) => makePlan(source, target, {...B, ...checks});
const item = (p, key) => p.items.find((i) => i.key === key);

test('new, same and differs', () => {
  const p = plan();
  assert.equal(item(p, 'dialplans/users').state, 'same');
  assert.equal(item(p, 'queues/support').state, 'new');
  const t = TARGET();
  t.dialplans[0].data.numbers = [{number: '9', apps: []}];
  assert.equal(item(plan(SOURCE(), t), 'dialplans/users').state, 'differs');
});

test('an unreadable target kind blocks its objects, and what needs them, with the chain', () => {
  const p = plan();
  assert.equal(item(p, 'ivr/menu').state, 'blocked');
  assert.match(item(p, 'ivr/menu').reason, /ivr cannot be read on b\.wildixin\.com: Access error/);
  assert.equal(item(p, 'dialplans/night').state, 'blocked');
  assert.match(item(p, 'dialplans/night').reason, /needs ivr\/menu/);
});

test('a missing reference blocks with its chain', () => {
  const s = SOURCE();
  s.kinds.queues = [];
  const p = plan(s);
  assert.equal(item(p, 'dialplans/main').state, 'blocked');
  assert.match(
    item(p, 'dialplans/main').reason,
    /needs queues\/support: neither in the export nor on b\.wildixin\.com/,
  );
});

test('duplicate names are blocked', () => {
  const s = SOURCE();
  s.kinds.queues.push({name: 'support', data: {title: 'support', members: [], settings: {}}});
  const p = plan(s);
  assert.deepEqual(
    p.items.filter((i) => i.key === 'queues/support').map((i) => i.state),
    ['blocked', 'blocked'],
  );
  assert.match(item(p, 'queues/support').reason, /two objects named support/);
});

test('licenses and taken extensions', () => {
  const p = plan();
  assert.equal(item(p, 'users/101').state, 'new');
  assert.equal(item(p, 'users/102').state, 'blocked');
  assert.match(item(p, 'users/102').reason, /no free business license on b\.wildixin\.com/);
  assert.equal(item(p, 'users/103').state, 'blocked');
  assert.match(item(p, 'users/103').reason, /extension 103 is Someone else on b\.wildixin\.com/);
  assert.equal(p.welcomeMails, 1);
});

test('missing sounds and music on hold are warnings; queue members missing as users too', () => {
  const p = plan();
  const main = item(p, 'dialplans/main');
  assert.notEqual(main.state, 'blocked');
  assert.ok(
    main.warnings.some(
      (w) => w.type === 'moh' && w.value === 'jazz' && /music on hold jazz is not on b\.wildixin\.com/.test(w.text),
    ),
  );
  assert.ok(!main.warnings.some((w) => /hello/.test(w.text)));
  assert.ok(
    item(p, 'queues/support').warnings.some(
      (w) => w.type === 'member' && w.value === '777' && /777 is not a user/.test(w.text),
    ),
  );
  assert.ok(!item(p, 'queues/support').warnings.some((w) => /101 is not a user/.test(w.text)));
});

test('counts and the target ids for writing', () => {
  const p = plan();
  assert.deepEqual(p.counts, {new: 4, same: 1, differs: 0, blocked: 4});
  assert.deepEqual(p.target['dialplans/users'], {id: '40', name: 'users'});
  assert.deepEqual(p.target['acl-groups/Default'], {id: '70', dn: gid(70), name: 'Default'});
});

test('a number and the same number as a string compare the same (the PBX answers either)', () => {
  const s = toPortable({queues: [{id: '1', name: 'q', data: {title: 'q', settings: {broadcastPriority: '0'}}}]}, A);
  const t = {queues: [{id: '9', name: 'q', data: {title: 'q', settings: {broadcastPriority: 0}}}]};
  assert.equal(makePlan(s, t, {...B}).items[0].state, 'same');
});

test('review 9: two objects of one name on the target block the object of the export', () => {
  const s = toPortable({switches: [{id: '1', name: 'night', data: {title: 'night', state: 0}}]}, A);
  const t = {
    switches: [
      {id: '7', name: 'night', data: {title: 'night', state: 0}},
      {id: '8', name: 'night', data: {title: 'night', state: 1}},
    ],
  };
  const it = makePlan(s, t, {...B}).items[0];
  assert.equal(it.state, 'blocked');
  assert.match(it.reason, /two objects named night on b\.wildixin\.com/);
});

test('review 3: the target ids carry the login of trunks', () => {
  const t = {'trunks-sip': [{id: '3', name: 'carrier', data: {title: 'carrier', name: 'login1'}}]};
  assert.deepEqual(makePlan({kinds: {}}, t, {...B}).target['trunks-sip/carrier'], {
    id: '3',
    name: 'carrier',
    login: 'login1',
  });
});

test('review 4: queue members are checked against the users of the target; not checked when they could not be read', () => {
  const s = toPortable(
    {queues: [{id: '5', name: 'q', data: {title: 'q', members: ['101@internalcalls'], settings: {}}}]},
    A,
  );
  let p = makePlan(s, {queues: [], users: [{id: '9', name: '101', data: {extension: '101'}}]}, {...B});
  assert.deepEqual(p.items[0].warnings, []);
  p = makePlan(s, {queues: [], users: {error: 'Access error'}}, {...B});
  assert.equal(p.items[0].warnings[0].type, 'not-checked');
  assert.match(p.items[0].warnings[0].text, /101/);
});

// Fake kinds (cloud side, service `fake`), registered for one test.
function fakeKind(t, name, extra = {}) {
  TRANSFER_KINDS[name] = {group: 'test', label: name, side: 'cloud', service: 'fake', read: async () => [], ...extra};
  t.after(() => delete TRANSFER_KINDS[name]);
}

test('differing paths are listed', () => {
  const s = toPortable(
    {
      switches: [
        {id: '1', name: 'night', data: {title: 'night', state: 1, list: ['a', 'b'], deep: {x: {y: 1}}}},
        {id: '2', name: 'many', data: {title: 'many', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6}},
        {id: '3', name: 'same', data: {title: 'same', state: 0}},
      ],
    },
    A,
  );
  const t = {
    switches: [
      {id: '7', name: 'night', data: {title: 'night', state: '1', list: ['a'], deep: {x: {y: 2}}, more: {z: 1}}},
      {id: '8', name: 'many', data: {title: 'many'}},
      {id: '9', name: 'same', data: {title: 'same', state: '0'}},
    ],
  };
  const p = makePlan(s, t, {...B});
  assert.equal(item(p, 'switches/night').state, 'differs');
  assert.deepEqual(item(p, 'switches/night').paths, ['list[1]', 'deep.x.y', 'more']);
  assert.deepEqual(item(p, 'switches/many').paths, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(item(p, 'switches/same').state, 'same');
  assert.equal(item(p, 'switches/same').paths, undefined);
});

test('missing lookup blocks with a map hint', (t) => {
  fakeKind(t, 'test-people', {lookup: true});
  fakeKind(t, 'test-agents', {
    portable(data, h) {
      data.owner = h.ref(data.owner, 'test-people', 'owner');
    },
  });
  const s = toPortable(
    {
      'test-people': [{id: 'u1', name: 'ann@x.example', data: {}}],
      'test-agents': [{id: 'a1', name: 'bot', data: {owner: 'u1'}}],
    },
    A,
  );
  let p = makePlan(s, {'test-people': [], 'test-agents': []}, {...B});
  assert.equal(item(p, 'test-agents/bot').state, 'blocked');
  assert.equal(
    item(p, 'test-agents/bot').reason,
    'needs test-people/ann@x.example: not on b.wildixin.com (map it with --map)',
  );
  const ann = {id: 'u9', name: 'ann@x.example', value: {id: 'u9', email: 'ann@x.example'}, data: {}};
  p = makePlan(s, {'test-people': [ann], 'test-agents': []}, {...B});
  assert.equal(item(p, 'test-agents/bot').state, 'new');
  assert.deepEqual(p.target['test-people/ann@x.example'], {id: 'u9', name: 'ann@x.example', value: ann.value});
  assert.equal(item(p, 'test-people/ann@x.example'), undefined);
});

test('overwritten deployed agent deploys', () => {
  const s = {
    kinds: {
      'wilma-agents': [
        {name: 'deployed', data: {prompt: 'new', deploy: true}},
        {name: 'draft', data: {prompt: 'new', deploy: false}},
        {name: 'fresh', data: {prompt: 'new', deploy: true}},
        {name: 'same', data: {prompt: 'old', deploy: true}},
      ],
    },
  };
  const t = {
    'wilma-agents': [
      {id: '1', name: 'deployed', data: {prompt: 'old', deploy: true}},
      {id: '2', name: 'draft', data: {prompt: 'old', deploy: true}},
      {id: '4', name: 'same', data: {prompt: 'old', deploy: true}},
    ],
  };
  const p = makePlan(s, t, {...B});
  assert.equal(item(p, 'wilma-agents/deployed').deploys, true);
  assert.equal(item(p, 'wilma-agents/draft').deploys, undefined);
  assert.equal(item(p, 'wilma-agents/fresh').deploys, undefined);
  assert.equal(item(p, 'wilma-agents/same').deploys, undefined);
});

test('portable warnings are copied onto their items', () => {
  const s = {
    kinds: {switches: [{name: 'night', data: {title: 'night'}}]},
    warnings: [{kind: 'switches', name: 'night', path: 'toolVersion', text: 'pinned to an older version, dropped'}],
  };
  const p = makePlan(s, {switches: []}, {...B});
  assert.deepEqual(item(p, 'switches/night').warnings, [
    {type: 'portable', path: 'toolVersion', text: 'pinned to an older version, dropped'},
  ]);
});

test('a cloud object bound by a secret is blocked with the field', () => {
  const s = {
    kinds: {switches: [{name: 'night', data: {title: 'night'}}]},
    bound: [{kind: 'switches', name: 'night', path: 'handler.customHeaders.X-Key', found: 'secret'}],
  };
  const it = makePlan(s, {switches: []}, {...B}).items[0];
  assert.equal(it.state, 'blocked');
  assert.equal(it.reason, 'secret field handler.customHeaders.X-Key not known');
});

test('a lookup the target lacks is named on the item (a name with spaces too); one it cannot read is not mappable', (t) => {
  fakeKind(t, 'test-people', {lookup: true, label: 'person'});
  fakeKind(t, 'test-agents', {
    portable(data, h) {
      data.owner = h.ref(data.owner, 'test-people', 'owner');
    },
  });
  const s = toPortable(
    {
      'test-people': [{id: 'u1', name: 'Sales team', data: {}}],
      'test-agents': [{id: 'a1', name: 'bot', data: {owner: 'u1'}}],
    },
    A,
  );
  let p = makePlan(s, {'test-people': [], 'test-agents': []}, {...B});
  assert.deepEqual(item(p, 'test-agents/bot').missing, {kind: 'test-people', name: 'Sales team'});
  assert.equal(
    item(p, 'test-agents/bot').reason,
    'needs test-people/Sales team: not on b.wildixin.com (map it with --map)',
  );

  p = makePlan(s, {'test-people': {error: 'HTTP 503'}, 'test-agents': []}, {...B});
  assert.equal(item(p, 'test-agents/bot').state, 'blocked');
  assert.equal(
    item(p, 'test-agents/bot').reason,
    'needs test-people/Sales team: test-people cannot be read on b.wildixin.com: HTTP 503',
  );
  assert.equal(item(p, 'test-agents/bot').missing, undefined);

  // The same for any cloud kind the export does not carry (a knowledge base the agent points at).
  fakeKind(t, 'test-bases');
  const q = makePlan(
    {kinds: {'test-agents': [{name: 'kb-user', data: {kb: {$ref: 'test-bases/Docs', as: 'id'}}}]}},
    {'test-bases': {error: 'HTTP 503'}, 'test-agents': []},
    {...B},
  );
  assert.equal(
    item(q, 'test-agents/kb-user').reason,
    'needs test-bases/Docs: test-bases cannot be read on b.wildixin.com: HTTP 503',
  );
});

test('a lookup name two target objects share blocks what needs it', (t) => {
  fakeKind(t, 'test-people', {lookup: true, label: 'x-bees service'});
  fakeKind(t, 'test-agents', {
    portable(data, h) {
      data.owner = h.ref(data.owner, 'test-people', 'owner');
    },
  });
  const s = toPortable(
    {
      'test-people': [{id: 'u1', name: 'Sales', data: {}}],
      'test-agents': [{id: 'a1', name: 'bot', data: {owner: 'u1'}}],
    },
    A,
  );
  const twice = [
    {id: 's1', name: 'Sales', data: {}},
    {id: 's2', name: 'Sales', data: {}},
  ];
  const p = makePlan(s, {'test-people': twice, 'test-agents': []}, {...B});
  assert.equal(item(p, 'test-agents/bot').state, 'blocked');
  assert.equal(
    item(p, 'test-agents/bot').reason,
    'needs test-people/Sales: two x-bees services named Sales on b.wildixin.com',
  );
});

test('a target access list naming users the target did not read is kept as it is: it differs, never same', () => {
  const app = (deniedEmails) => ({
    id: 'ap1',
    name: 'Orders',
    data: {title: 'Orders', accessEmails: ['ann@x.example'], deniedEmails},
  });
  const s = toPortable(
    {'integration-apps': [app([])], 'xbees-users': [{id: 'u1', name: 'ann@x.example', data: {}}]},
    A,
  );
  const target = {
    'integration-apps': [app(['eve@x.example'])],
    'xbees-users': [{id: 'u-y', name: 'ann@x.example', data: {}}],
  };
  const it = item(makePlan(s, target, {...B}), 'integration-apps/Orders');
  assert.equal(it.state, 'differs');
  assert.deepEqual(it.paths, ['deniedEmails[0]']);
});

test('a need on a synced lookup the target cannot read blocks, even when its source object is new', (t) => {
  fakeKind(t, 'test-services', {lookup: true, label: 'x-bees service', syncedFrom: 'test-queues'});
  fakeKind(t, 'test-queues');
  fakeKind(t, 'test-widgets');
  const s = {
    kinds: {
      'test-queues': [{name: 'Support', data: {}}],
      'test-widgets': [{name: 'w', data: {service: {$ref: 'test-services/Support', as: 'id'}}}],
    },
  };
  const p = makePlan(s, {'test-services': {error: 'HTTP 503'}, 'test-queues': [], 'test-widgets': []}, {...B});
  assert.equal(item(p, 'test-queues/Support').state, 'new');
  assert.equal(item(p, 'test-widgets/w').state, 'blocked');
  assert.equal(
    item(p, 'test-widgets/w').reason,
    'needs test-services/Support: test-services cannot be read on b.wildixin.com: HTTP 503',
  );
});
