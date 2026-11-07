import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyPlan} from '../src/transfer/apply.mjs';
import {readKinds} from '../src/transfer/kinds.mjs';
import {makePlan} from '../src/transfer/plan.mjs';
import {toPortable} from '../src/transfer/refs.mjs';
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
  const plan = makePlan(SOURCE(), await readKinds(client, KINDS), {...B, licenses: {business: 5}});
  const chosen = new Set(plan.items.filter((i) => i.state === 'new' || i.state === 'differs').map((i) => i.key));
  const events = [];
  const results = await applyPlan(client, plan, chosen, {secrets, selfDn: SELF, onEvent: (e) => events.push(e)});
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
