import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyPlan, StageError} from '../src/transfer/apply.mjs';
import {readKinds, TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {makePlan} from '../src/transfer/plan.mjs';
import {keyOf, refsOf, toPortable} from '../src/transfer/refs.mjs';
import {clientOf, fakePbx} from './fake-pbx.mjs';

const A = {serial: 'aaaa00000001', host: 'a.wildixin.com'};
const B = {serial: 'bbbb00000002', host: 'demo.wildixin.com'};
const gid = (n) => `gid=${n},o=com0,dc=wildix`;
const SELF = 'pbxid=bbbb00000002,dc=wildix';

// The source: ACL groups and dialplans that point at each other, a queue, a trunk with its password, a trunk group,
// a user.
const SOURCE = () =>
  toPortable(
    {
      'acl-groups': [
        {
          id: '1',
          dn: gid(1),
          name: 'Ops',
          data: {
            name: 'Ops',
            inherits: null,
            rules: [{rule: 'CALL', ability: 'yes', group: gid(2)}],
            adminRules: [{subject: `pbxid=${A.serial},dc=wildix`, operation: 'epbx'}],
          },
        },
        {
          id: '2',
          dn: gid(2),
          name: 'Sales',
          data: {
            name: 'Sales',
            inherits: {dn: gid(1)},
            rules: [{rule: 'CALL', ability: 'yes', group: gid(1)}],
            adminRules: [],
          },
        },
      ],
      users: [
        {
          id: '1',
          name: '101',
          data: {
            extension: '101',
            name: 'Ann',
            role: 'user',
            licenseType: 'business',
            groupDn: gid(2),
            dialplan: 'main',
          },
        },
      ],
      'trunks-sip': [
        {
          id: '3',
          name: 'carrier',
          data: {title: 'carrier', name: 'login', settingsPbx: {secret: 'old', context: 'main'}},
        },
      ],
      'trunk-groups': [{id: '4', name: 'out', data: {name: 'out', rules: [{trunkName: 'carrier'}]}}],
      queues: [{id: '5', name: 'support', data: {title: 'support', members: ['101@internalcalls'], settings: {}}}],
      dialplans: [
        {
          id: '1',
          name: 'main',
          data: {
            name: 'main',
            description: '',
            includedDialplans: [{dialplanId: 2}],
            numbers: [{number: '1', apps: [{name: 'Queue', params: {queueId: '5'}}]}],
          },
        },
        {
          id: '2',
          name: 'night',
          data: {
            name: 'night',
            description: '',
            includedDialplans: [],
            numbers: [
              {
                number: '1',
                apps: [
                  {name: 'Goto', params: {dialplan: 'main', number: '1'}},
                  {name: 'DialTrunk', params: {trunk: 'carrier'}},
                ],
              },
            ],
          },
        },
      ],
    },
    A,
  );
const EMPTY = () => ({
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
  '/Dialplan/GeneralSettings/': {},
});
const KINDS = ['acl-groups', 'users', 'trunks-sip', 'trunk-groups', 'queues', 'dialplans'];

async function importInto(pbx, {secrets = {'trunks-sip/carrier': {'settingsPbx.secret': 'new-pw'}}} = {}) {
  const client = await clientOf(pbx);
  const plan = makePlan(SOURCE(), await readKinds({pbx: client}, KINDS), {...B, licenses: {business: 5}});
  const chosen = new Set(plan.items.filter((i) => i.state === 'new' || i.state === 'differs').map((i) => i.key));
  const events = [];
  const results = await applyPlan({pbx: client}, plan, chosen, {secrets, selfDn: SELF, onEvent: (e) => events.push(e)});
  return {plan, results, events, client};
}
const by = (results, key) => results.find((r) => r.key === key);

test('writes in dependency order, references turned into the ids of the target', async () => {
  const pbx = fakePbx(EMPTY());
  const {results} = await importInto(pbx);
  assert.deepEqual(
    results.filter((r) => r.action !== 'create').map((r) => [r.key, r.action, r.error ?? r.because]),
    [],
  );
  const posts = pbx.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.ok(posts.indexOf('/PBX/AclGroups/') < posts.indexOf('/PBX/Colleagues/'));
  assert.ok(posts.indexOf('/Trunks/Sip/') < posts.indexOf('/Trunks/Groups/'));
  const s = pbx.state;
  const queue = s['/Dialplan/CallGroups/'][0];
  const [main, night] = ['main', 'night'].map((n) => s['/PBX/Dialplans/'].find((d) => d.name === n));
  assert.equal(main.numbers[0].apps[0].params.queueId, queue.id);
  assert.deepEqual(main.includedDialplans, [{dialplanId: Number(night.id)}]);
  assert.equal(night.numbers[0].apps[0].params.dialplan, 'main');
  const user = s['/PBX/Colleagues/'][0];
  const sales = s['/PBX/AclGroups/'].find((g) => g.name === 'Sales');
  assert.equal(user.groupDn, sales.dn);
  assert.equal(s['/Trunks/Groups/'][0].rules[0].trunkName, 'carrier');
});

test('ACL groups that reference each other in a cycle; admin rules point at the target PBX', async () => {
  const pbx = fakePbx(EMPTY());
  await importInto(pbx);
  const g = Object.fromEntries(pbx.state['/PBX/AclGroups/'].map((x) => [x.name, x]));
  assert.equal(g.Ops.rules[0].group, g.Sales.dn);
  assert.equal(g.Sales.rules[0].group, g.Ops.dn);
  assert.deepEqual(g.Sales.inherits, {dn: g.Ops.dn});
  assert.equal(g.Ops.adminRules[0].subject, SELF);
});

test('secrets are sent and never in the results or events; a trunk without its password is skipped with what needs it', async () => {
  let pbx = fakePbx(EMPTY());
  let r = await importInto(pbx);
  assert.equal(pbx.state['/Trunks/Sip/'][0].settingsPbx.secret, 'new-pw');
  assert.ok(!JSON.stringify(r.results).includes('new-pw'));
  assert.ok(!JSON.stringify(r.events).includes('new-pw'));
  pbx = fakePbx(EMPTY());
  r = await importInto(pbx, {secrets: {}});
  assert.deepEqual(
    [by(r.results, 'trunks-sip/carrier').action, by(r.results, 'trunks-sip/carrier').because],
    ['skip', 'no password: settingsPbx.secret'],
  );
  assert.deepEqual(
    [by(r.results, 'trunk-groups/out').action, by(r.results, 'trunk-groups/out').because],
    ['skip', 'trunks-sip/carrier'],
  );
  assert.equal(by(r.results, 'dialplans/night').because, 'trunks-sip/carrier');
  assert.equal(pbx.state['/Trunks/Sip/'].length, 0);
});

test('a failure skips what needs it and goes on', async () => {
  const pbx = fakePbx(EMPTY(), {
    failOn: ({method, path}) => method === 'POST' && path === '/Dialplan/CallGroups/' && 'Already present',
  });
  const {results} = await importInto(pbx);
  assert.equal(by(results, 'queues/support').action, 'failed');
  assert.match(by(results, 'queues/support').error, /Already present/);
  assert.deepEqual(
    [by(results, 'dialplans/main').action, by(results, 'dialplans/main').because],
    ['skip', 'queues/support'],
  );
  assert.equal(by(results, 'users/101').action, 'create');
});

test('a second run writes nothing', async () => {
  const pbx = fakePbx(EMPTY());
  await importInto(pbx);
  const writes = pbx.calls.filter((c) => c.method !== 'GET').length;
  const {plan, results} = await importInto(pbx);
  assert.deepEqual(
    plan.counts.new + plan.counts.differs,
    0,
    JSON.stringify(plan.items.filter((i) => i.state !== 'same').map((i) => [i.key, i.state, i.reason])),
  );
  assert.deepEqual(results, []);
  assert.equal(pbx.calls.filter((c) => c.method !== 'GET').length, writes);
});

test('review 3: a reference by login to a trunk already on the target resolves', async () => {
  const s = EMPTY();
  s['/Trunks/Sip/'] = [{id: '33', title: 'carrier', name: 'login1', settingsPbx: {secret: {}}}];
  const pbx = fakePbx(s);
  const client = await clientOf(pbx);
  const portable = toPortable(
    {
      'trunks-sip': [{id: '3', name: 'carrier', data: {title: 'carrier', name: 'login1'}}],
      'trunk-groups': [{id: '4', name: 'out', data: {name: 'out', rules: [{trunkName: 'login1'}]}}],
    },
    A,
  );
  portable.kinds = {'trunk-groups': portable.kinds['trunk-groups']};
  const plan = makePlan(portable, await readKinds({pbx: client}, ['trunks-sip', 'trunk-groups']), {...B});
  const results = await applyPlan({pbx: client}, plan, new Set(['trunk-groups/out']), {selfDn: SELF});
  assert.deepEqual(
    results.map((r) => [r.key, r.action]),
    [['trunk-groups/out', 'create']],
  );
  assert.equal(pbx.state['/Trunks/Groups/'][0].rules[0].trunkName, 'login1');
});

test('review 1: a dialplan made bare in the first pass and then skipped is reported bare', async () => {
  const pbx = fakePbx(EMPTY());
  const {results} = await importInto(pbx, {secrets: {}});
  const night = by(results, 'dialplans/night');
  assert.equal(night.action, 'skip');
  assert.equal(night.bare, true);
  assert.ok(pbx.state['/PBX/Dialplans/'].some((d) => d.name === 'night'));
});

test('PBX first pass as it was: a dialplan whose include failed its bare create is still made bare, then skipped', async () => {
  const dialplan = (name, includes = []) => ({
    name,
    data: {name, description: '', numbers: [], includedDialplans: includes},
  });
  const portable = {
    kinds: {
      dialplans: [dialplan('A'), dialplan('B', [{dialplanId: {$ref: 'dialplans/A', as: 'id', number: true}}])],
    },
  };
  const pbx = fakePbx(EMPTY(), {
    failOn: ({method, path, body}) => method === 'POST' && path === '/PBX/Dialplans/' && body?.name === 'A' && 'no',
  });
  const client = await clientOf(pbx);
  const plan = makePlan(portable, await readKinds({pbx: client}, ['dialplans']), {...B});
  const results = await applyPlan({pbx: client}, plan, new Set(plan.items.map((i) => i.key)), {selfDn: SELF});
  assert.deepEqual(
    pbx.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body?.name]),
    [
      ['POST', '/PBX/Dialplans/', 'A'],
      ['POST', '/PBX/Dialplans/', 'B'],
    ],
  );
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.because, r.bare]),
    [
      ['dialplans/A', 'failed', undefined, undefined],
      ['dialplans/B', 'skip', 'dialplans/A', true],
    ],
  );
});

// Fake kinds (cloud side, service `fake`), registered for one test. Their write hook records what it gets and answers
// the id it is given (else id-<name>) and `version`, unless `answer` says otherwise.
function fakeKind(t, name, extra = {}) {
  TRANSFER_KINDS[name] = {
    group: 'test',
    label: name,
    side: 'cloud',
    service: 'fake',
    async read() {
      return [];
    },
    async write(client, item, data, opts) {
      client.calls.push({
        key: item.key,
        data,
        existing: opts.existing,
        ...(opts.unconfigured ? {unconfigured: true} : {}),
      });
      return {id: opts.existing ?? `id-${item.name}`};
    },
    ...extra,
  };
  t.after(() => delete TRANSFER_KINDS[name]);
}
const fakeClients = () => ({fake: {calls: []}});
const planOf = (items, target = {}) => ({
  host: B.host,
  target,
  items: items.map(({kind, name, data, state = 'new'}) => {
    const key = keyOf(kind, name);
    return {key, kind, name, data, state, warnings: [], needs: refsOf(data).map((r) => keyOf(r.kind, r.name))};
  }),
});
const all = (plan) => new Set(plan.items.map((i) => i.key));

test('write hook is used for new and differs', async (t) => {
  fakeKind(t, 'test-tools', {
    async write(client, item, data, {existing}) {
      client.calls.push({key: item.key, data, existing});
      return {id: existing ?? '9', version: existing ? 8 : 3, steps: ['create', 'publish']};
    },
  });
  fakeKind(t, 'test-agents');
  const clients = fakeClients();
  const plan = planOf(
    [
      {kind: 'test-tools', name: 'x', data: {name: 'x'}},
      {kind: 'test-tools', name: 'y', data: {name: 'y', description: 'new'}, state: 'differs'},
      {
        kind: 'test-agents',
        name: 'a',
        data: {
          name: 'a',
          tools: [
            {$ref: 'test-tools/x', as: 'version'},
            {$ref: 'test-tools/y', as: 'version'},
            {$ref: 'test-tools/z', as: 'version'},
          ],
        },
      },
    ],
    {'test-tools/y': {id: '7', name: 'y', version: 2}, 'test-tools/z': {id: '5', name: 'z', version: 4}},
  );
  const results = await applyPlan(clients, plan, all(plan));
  // The steps of a write hook travel on its result (for the log).
  assert.deepEqual(results, [
    {key: 'test-tools/x', action: 'create', id: '9', version: 3, steps: ['create', 'publish']},
    {key: 'test-tools/y', action: 'overwrite', id: '7', version: 8, steps: ['create', 'publish']},
    {key: 'test-agents/a', action: 'create', id: 'id-a'},
  ]);
  assert.deepEqual(
    clients.fake.calls.map((c) => [c.key, c.existing]),
    [
      ['test-tools/x', undefined],
      ['test-tools/y', '7'],
      ['test-agents/a', undefined],
    ],
  );
  assert.deepEqual(clients.fake.calls[2].data.tools, [3, 8, 4]);
});

test('the plan carries the version and the value of a target object into the table', () => {
  const plan = makePlan(
    {kinds: {}},
    {
      'test-tools': [{id: '5', name: 'z', version: 4, data: {}}],
      'xbees-services': [{id: 's1', name: 'Sales', value: {id: 's1', uri: 's1@pbx:5060'}, data: {}}],
    },
    {...B},
  );
  assert.deepEqual(plan.target['test-tools/z'], {id: '5', name: 'z', version: 4});
  assert.deepEqual(plan.target['xbees-services/Sales'], {
    id: 's1',
    name: 'Sales',
    value: {id: 's1', uri: 's1@pbx:5060'},
  });
});

test('StageError marks the stage', async (t) => {
  fakeKind(t, 'test-tools', {
    async write() {
      throw new StageError('publish', 'boom');
    },
  });
  fakeKind(t, 'test-agents');
  const clients = fakeClients();
  const plan = planOf([
    {kind: 'test-tools', name: 'x', data: {name: 'x'}},
    {kind: 'test-agents', name: 'a', data: {name: 'a', tool: {$ref: 'test-tools/x', as: 'id'}}},
  ]);
  const results = await applyPlan(clients, plan, all(plan));
  assert.deepEqual(results, [
    {key: 'test-tools/x', action: 'failed', stage: 'publish', error: 'boom'},
    {key: 'test-agents/a', action: 'skip', because: 'test-tools/x'},
  ]);
  assert.equal(clients.fake.calls.length, 0);
  const e = new StageError('deploy', 'no');
  assert.ok(e instanceof Error);
  assert.deepEqual([e.stage, e.message], ['deploy', 'no']);
});

test('twoPass kind is written bare first', async (t) => {
  fakeKind(t, 'test-loop', {twoPass: {bare: (data) => ({name: data.name})}});
  const clients = fakeClients();
  const plan = planOf([
    {kind: 'test-loop', name: 'a', data: {name: 'a', peer: {$ref: 'test-loop/b', as: 'id'}}},
    {kind: 'test-loop', name: 'b', data: {name: 'b', peer: {$ref: 'test-loop/a', as: 'id'}}},
  ]);
  const results = await applyPlan(clients, plan, all(plan));
  assert.deepEqual(
    clients.fake.calls.map((c) => [c.key, c.data, c.existing]),
    [
      ['test-loop/a', {name: 'a'}, undefined],
      ['test-loop/b', {name: 'b'}, undefined],
      ['test-loop/a', {name: 'a', peer: 'id-b'}, 'id-a'],
      ['test-loop/b', {name: 'b', peer: 'id-a'}, 'id-b'],
    ],
  );
  assert.deepEqual(results, [
    {key: 'test-loop/a', action: 'create', id: 'id-a'},
    {key: 'test-loop/b', action: 'create', id: 'id-b'},
  ]);
});

test('a twoPass object that will be skipped is not made bare, nor anything that needs it', async (t) => {
  fakeKind(t, 'test-loop', {
    twoPass: {bare: (data) => ({name: data.name})},
    secrets: [{path: 'key', empty: 'skip'}],
  });
  const clients = fakeClients();
  const plan = planOf([
    {kind: 'test-loop', name: 'locked', data: {name: 'locked', key: {$secret: 'key'}}},
    {kind: 'test-loop', name: 'peer', data: {name: 'peer', other: {$ref: 'test-loop/locked', as: 'id'}}},
    {kind: 'test-loop', name: 'free', data: {name: 'free'}},
  ]);
  const results = await applyPlan(clients, plan, all(plan));
  assert.deepEqual(
    clients.fake.calls.map((c) => [c.key, c.data, c.existing]),
    [
      ['test-loop/free', {name: 'free'}, undefined],
      ['test-loop/free', {name: 'free'}, 'id-free'],
    ],
  );
  assert.deepEqual(results, [
    {key: 'test-loop/locked', action: 'skip', because: 'no secret: key'},
    {key: 'test-loop/peer', action: 'skip', because: 'test-loop/locked'},
    {key: 'test-loop/free', action: 'create', id: 'id-free'},
  ]);

  // Given its secret, the object is made bare and finished as usual.
  const given = fakeClients();
  const again = await applyPlan(given, plan, all(plan), {secrets: {'test-loop/locked': {key: 'k-1'}}});
  assert.deepEqual(
    again.map((r) => [r.key, r.action]),
    [
      ['test-loop/locked', 'create'],
      ['test-loop/peer', 'create'],
      ['test-loop/free', 'create'],
    ],
  );
  assert.equal(given.fake.calls.length, 6);
});

test('empty secret policies', async (t) => {
  fakeKind(t, 'test-skip', {secrets: [{path: 'key', empty: 'skip'}]});
  fakeKind(t, 'test-pending', {secrets: [{path: /^value$/, empty: 'pending'}]});
  fakeKind(t, 'test-unconf', {secrets: [{path: 'configuration.apiKey', empty: 'unconfigured'}]});
  fakeKind(t, 'test-gen', {secrets: [{path: 'secret', empty: 'generate'}]});
  fakeKind(t, 'test-none');
  const clients = fakeClients();
  const plan = planOf(
    [
      {kind: 'test-skip', name: 's', data: {name: 's', key: {$secret: 'key'}}},
      {kind: 'test-pending', name: 'p', data: {name: 'p', value: {$secret: 'value'}}},
      {kind: 'test-pending', name: 'given', data: {name: 'given', value: {$secret: 'value'}}},
      {
        kind: 'test-unconf',
        name: 'u',
        data: {name: 'u', configuration: {url: 'https://wiki.example.com', apiKey: {$secret: 'configuration.apiKey'}}},
      },
      {kind: 'test-gen', name: 'w', data: {url: 'https://crm.example.com/hook', secret: {$secret: 'secret'}}},
      {kind: 'test-none', name: 'n', data: {name: 'n', token: {$secret: 'token'}}},
      {kind: 'test-pending', name: 'pd', data: {name: 'pd', note: 'x', value: {$secret: 'value'}}, state: 'differs'},
      {
        kind: 'test-gen',
        name: 'wd',
        data: {url: 'https://crm.example.com/b', secret: {$secret: 'secret'}},
        state: 'differs',
      },
    ],
    {'test-pending/pd': {id: 'p7', name: 'pd'}, 'test-gen/wd': {id: 'w7', name: 'wd'}},
  );
  const events = [];
  const results = await applyPlan(clients, plan, all(plan), {
    secrets: {'test-pending/given': {value: 'kept-value'}},
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(results, [
    {key: 'test-skip/s', action: 'skip', because: 'no secret: key'},
    {key: 'test-pending/p', action: 'create', id: 'id-p', pending: true},
    {key: 'test-pending/given', action: 'create', id: 'id-given'},
    {key: 'test-pending/pd', action: 'overwrite', id: 'p7'},
    {key: 'test-unconf/u', action: 'create', id: 'id-u', unconfigured: true},
    {key: 'test-gen/w', action: 'create', id: 'id-w', generated: {path: 'secret'}},
    {key: 'test-gen/wd', action: 'overwrite', id: 'w7'},
    {key: 'test-none/n', action: 'skip', because: 'no password: token'},
  ]);
  const written = Object.fromEntries(clients.fake.calls.map((c) => [c.key, c]));
  assert.deepEqual(written['test-pending/p'].data, {name: 'p'});
  assert.deepEqual(written['test-pending/given'].data, {name: 'given', value: 'kept-value'});
  // On an overwrite the target keeps its own secret: the path is left out, nothing generated.
  assert.deepEqual(written['test-pending/pd'], {key: 'test-pending/pd', data: {name: 'pd', note: 'x'}, existing: 'p7'});
  assert.deepEqual(written['test-gen/wd'], {
    key: 'test-gen/wd',
    data: {url: 'https://crm.example.com/b'},
    existing: 'w7',
  });
  assert.deepEqual(written['test-unconf/u'], {
    key: 'test-unconf/u',
    data: {name: 'u', configuration: {url: 'https://wiki.example.com'}},
    existing: undefined,
    unconfigured: true,
  });
  const value = written['test-gen/w'].data.secret;
  assert.match(value, /^[A-Za-z0-9]{30}$/);
  assert.deepEqual(results.generatedSecrets, {'test-gen/w': {secret: value}});
  assert.ok(!JSON.stringify(results).includes(value));
  assert.ok(!JSON.stringify(events).includes(value));
  assert.ok(!Object.keys(results).includes('generatedSecrets'));
});

test('a StageError after a create names the id: the object is in the table, its generated secret kept', async (t) => {
  fakeKind(t, 'test-tools', {
    secrets: [{path: 'secret', empty: 'generate'}],
    async write(client, item, data) {
      client.calls.push({key: item.key, data});
      throw new StageError('publish', 'boom', {id: '7'});
    },
  });
  fakeKind(t, 'test-agents');
  const clients = fakeClients();
  const plan = planOf([
    {kind: 'test-tools', name: 'x', data: {name: 'x', secret: {$secret: 'secret'}}},
    {kind: 'test-agents', name: 'a', data: {name: 'a', tool: {$ref: 'test-tools/x', as: 'id'}}},
  ]);
  plan.items[1].needs = []; // a soft need: the agent is written whatever happened to the tool
  const results = await applyPlan(clients, plan, all(plan));
  assert.deepEqual(results, [
    {key: 'test-tools/x', action: 'failed', stage: 'publish', id: '7', generated: {path: 'secret'}, error: 'boom'},
    {key: 'test-agents/a', action: 'create', id: 'id-a'},
  ]);
  assert.equal(clients.fake.calls[1].data.tool, '7');
  assert.deepEqual(results.generatedSecrets, {'test-tools/x': {secret: clients.fake.calls[0].data.secret}});
  assert.equal('id' in new StageError('create', 'no'), false);
});

test('an undeclared secret given as an empty string is written as it is (PBX rule)', async (t) => {
  fakeKind(t, 'test-trunk');
  const clients = fakeClients();
  const plan = planOf([
    {
      kind: 'test-trunk',
      name: 'carrier',
      data: {title: 'carrier', settingsPbx: {secret: {$secret: 'settingsPbx.secret'}}},
    },
  ]);
  const results = await applyPlan(clients, plan, all(plan), {
    secrets: {'test-trunk/carrier': {'settingsPbx.secret': ''}},
  });
  assert.deepEqual(results, [{key: 'test-trunk/carrier', action: 'create', id: 'id-carrier'}]);
  assert.deepEqual(clients.fake.calls[0].data, {title: 'carrier', settingsPbx: {secret: ''}});
});

test('resolve as object', async (t) => {
  const made = [];
  fakeKind(t, 'test-x', {
    write: undefined,
    async create(client, data, name) {
      made.push({client, data, name});
      return 'x1';
    },
  });
  const plan = makePlan(
    {kinds: {'test-x': [{name: 'a', data: {service: {$ref: 'xbees-services/Sales', as: 'object'}}}]}},
    {'test-x': [], 'xbees-services': [{id: 's1', name: 'Sales', value: {id: 's1', uri: 's1@pbx:5060'}, data: {}}]},
    {...B},
  );
  assert.equal(plan.items[0].state, 'new');
  const clients = fakeClients();
  const results = await applyPlan(clients, plan, all(plan));
  assert.deepEqual(results, [{key: 'test-x/a', action: 'create', id: 'x1'}]);
  assert.deepEqual(made, [{client: clients.fake, data: {service: {id: 's1', uri: 's1@pbx:5060'}}, name: 'a'}]);
});

test('objects of one kind are written after the objects of that kind they point at; a cycle keeps file order', async (t) => {
  fakeKind(t, 'test-tools');
  fakeKind(t, 'test-agents');
  const clients = fakeClients();
  const ref = (name) => ({$ref: `test-tools/${name}`, as: 'id'});
  const plan = planOf([
    {kind: 'test-agents', name: 'bot', data: {tool: ref('a')}},
    {kind: 'test-tools', name: 'a', data: {server: ref('b')}},
    {kind: 'test-tools', name: 'b', data: {}},
    {kind: 'test-tools', name: 'c', data: {}},
    {kind: 'test-tools', name: 'd', data: {}},
  ]);
  // c and d need each other (no order satisfies both): they keep the order of the file.
  plan.items[3].needs = ['test-tools/d'];
  plan.items[4].needs = ['test-tools/c'];
  const results = await applyPlan(clients, plan, all(plan));
  assert.deepEqual(
    results.map((r) => r.key),
    ['test-tools/b', 'test-tools/a', 'test-tools/c', 'test-tools/d', 'test-agents/bot'],
  );
  assert.deepEqual(clients.fake.calls[1].data, {server: 'id-b'});
  assert.deepEqual(clients.fake.calls[4].data, {tool: 'id-a'});
});

test('PBX kinds keep the file order: a dialplan including one listed later is written first', async () => {
  const dialplan = (id, name, includes) => ({
    id,
    name,
    data: {name, description: '', includedDialplans: includes.map((d) => ({dialplanId: d})), numbers: []},
  });
  const source = toPortable({dialplans: [dialplan('1', 'A', [2]), dialplan('2', 'B', [])]}, A);
  const pbx = fakePbx(EMPTY());
  const client = await clientOf(pbx);
  const plan = makePlan(source, await readKinds({pbx: client}, ['dialplans']), {...B});
  assert.deepEqual(plan.items.find((i) => i.name === 'A').needs, ['dialplans/B']);
  const results = await applyPlan({pbx: client}, plan, all(plan), {selfDn: SELF});
  assert.deepEqual(
    results.map((r) => [r.key, r.action]),
    [
      ['dialplans/A', 'create'],
      ['dialplans/B', 'create'],
    ],
  );
});

test('a failure never reports a secret value of the object, given or generated', async (t) => {
  const gen = [];
  fakeKind(t, 'test-leaky', {
    secrets: [
      {path: 'key', empty: 'skip'},
      {path: 'secret', empty: 'generate'},
    ],
    async write(client, item, data) {
      gen.push(data.secret);
      throw new StageError('publish', `refused ${data.key} and ${data.secret}`, {id: '5'});
    },
  });
  fakeKind(t, 'test-plain', {
    async write(client, item, data) {
      throw new Error(`boom: ${data.token}`);
    },
  });
  const plan = planOf([
    {kind: 'test-leaky', name: 'x', data: {name: 'x', key: {$secret: 'key'}, secret: {$secret: 'secret'}}},
    {kind: 'test-plain', name: 'y', data: {name: 'y', token: {$secret: 'token'}}},
  ]);
  const results = await applyPlan(fakeClients(), plan, all(plan), {
    secrets: {'test-leaky/x': {key: 'GivenKey-123'}, 'test-plain/y': {token: 'GivenTok-456'}},
  });
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.stage, r.error]),
    [
      ['test-leaky/x', 'failed', 'publish', 'refused ******** and ********'],
      ['test-plain/y', 'failed', undefined, 'boom: ********'],
    ],
  );
  assert.equal(gen.length, 1);
  assert.ok(!JSON.stringify(results).includes(gen[0]));
});
