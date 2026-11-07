import assert from 'node:assert/strict';
import {test} from 'node:test';
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
            email: 'ann@x.com',
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
    main.warnings.some((w) => /music on hold jazz is not on b\.wildixin\.com/.test(w)),
    main.warnings.join('|'),
  );
  assert.ok(!main.warnings.some((w) => /hello/.test(w)));
  assert.ok(item(p, 'queues/support').warnings.some((w) => /777 is not a user/.test(w)));
  assert.ok(!item(p, 'queues/support').warnings.some((w) => /101 is not a user/.test(w)));
});

test('counts and the target ids for writing', () => {
  const p = plan();
  assert.deepEqual(p.counts, {new: 4, same: 1, differs: 0, blocked: 4});
  assert.deepEqual(p.target['dialplans/users'], {id: '40', name: 'users'});
  assert.deepEqual(p.target['acl-groups/Default'], {id: '70', dn: gid(70), name: 'Default'});
});
