import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {UsageError} from 'wldx-core/errors';
import {makePlan} from '../src/transfer/plan.mjs';
import {applyMap, readMap} from '../src/transfer/map.mjs';

const portable = () => ({
  kinds: {
    'kite-channels': [{name: 'sms:+3902', data: {number: '+3902'}}],
    'acl-groups': [{name: 'staff', data: {name: 'staff', note: 'x'}}],
    queues: [{name: 'q', data: {title: 'q', widget: {service: {$ref: 'xbees-services/Sales', as: 'id'}}}}],
  },
  needs: {'queues/q': ['xbees-services/Sales', 'acl-groups/staff']},
  soft: {'queues/q': ['acl-groups/staff']},
  bound: [{kind: 'acl-groups', name: 'staff', path: 'p', found: 'host'}],
  external: [{kind: 'kite-channels', name: 'sms:+3902', path: 'p', what: 'w'}],
  unresolved: [{kind: 'queues', name: 'q', path: 'p', value: '1', from: 'acl-groups/staff'}],
  outside: [{kind: 'moh', name: 'q', path: 'p', value: 'j', from: 'queues/q'}],
  warnings: [{kind: 'acl-groups', name: 'staff', path: 'p', text: 't'}],
  errors: {},
});
const MAP = {
  'xbees-services': {Sales: 'Vendite'},
  'kite-channels': {'sms:+3902': 'sms:+4402'},
  'acl-groups': {staff: 'crew'},
  queues: {q: 'queue2'},
};

test('map renames refs and objects', () => {
  const src = portable();
  const out = applyMap(src, MAP);
  assert.deepEqual(src, portable(), 'input untouched');
  assert.equal(out.kinds.queues[0].data.widget.service.$ref, 'xbees-services/Vendite');
  assert.equal(out.kinds['kite-channels'][0].name, 'sms:+4402');
  assert.equal(out.kinds['acl-groups'][0].name, 'crew');
  assert.equal(out.kinds['acl-groups'][0].data.name, 'crew');
  assert.equal(out.kinds.queues[0].name, 'queue2');
  assert.equal(out.kinds.queues[0].data.title, 'queue2');
  assert.deepEqual(out.needs, {'queues/queue2': ['xbees-services/Vendite', 'acl-groups/crew']});
  assert.deepEqual(out.soft, {'queues/queue2': ['acl-groups/crew']});
  assert.equal(out.bound[0].name, 'crew');
  assert.equal(out.external[0].name, 'sms:+4402');
  assert.equal(out.unresolved[0].name, 'queue2');
  assert.equal(out.unresolved[0].from, 'acl-groups/crew');
  assert.equal(out.outside[0].from, 'queues/queue2');
  assert.equal(out.outside[0].name, 'queue2');
  assert.equal(out.warnings[0].name, 'crew');
});

test('map key for an absent kind is ignored', () => {
  const out = applyMap(portable(), {'xbees-bots': {a: 'b'}, dialplans: {x: 'y'}});
  assert.deepEqual(out, portable());
});

test('map rename onto an existing name blocks both', () => {
  const src = {
    kinds: {
      'acl-groups': [
        {name: 'a', data: {name: 'a'}},
        {name: 'b', data: {name: 'b'}},
      ],
    },
    needs: {},
    soft: {},
    bound: [],
    external: [],
    unresolved: [],
    outside: [],
    errors: {},
  };
  const out = applyMap(src, {'acl-groups': {a: 'b'}});
  const plan = makePlan(out, {}, {serial: 's', host: 'h'});
  assert.deepEqual(
    plan.items.map((i) => [i.state, i.reason]),
    [
      ['blocked', 'two objects named b in the export'],
      ['blocked', 'two objects named b in the export'],
    ],
  );
});

const ctxOf = (stdin = '') => ({
  stdin: Readable.from([Buffer.from(stdin)]),
  cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'map-')),
  env: {},
});
const usage = (p, re) =>
  assert.rejects(p, (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, re);
    return true;
  });

test('readMap reads a file and stdin', async () => {
  const ctx = ctxOf('{"queues": {"a": "b"}}');
  fs.writeFileSync(path.join(ctx.cwd, 'm.json'), '{"acl-groups": {"a": "b"}}');
  assert.deepEqual(await readMap(ctx, 'm.json'), {'acl-groups': {a: 'b'}});
  assert.deepEqual(await readMap(ctx, '-'), {queues: {a: 'b'}});
  // the Kite channels are a kind of their own
  assert.deepEqual(await readMap(ctxOf('{"kite-channels": {"sms:+3902": "sms:+4402"}}'), '-'), {
    'kite-channels': {'sms:+3902': 'sms:+4402'},
  });
  // the lookup kinds are kinds of their own now
  const lookups =
    '{"xbees-services": {"a": "b"}, "xbees-users": {"a@x.example": "b@x.example"}, "xbees-bots": {"a": "b"}}';
  assert.deepEqual(Object.keys(await readMap(ctxOf(lookups), '-')), ['xbees-services', 'xbees-users', 'xbees-bots']);
});

test('bad map is a usage error', async () => {
  await usage(readMap(ctxOf('{"nope": {}}'), '-'), /^--map stdin: unknown kind nope \(known: .*acl-groups.*\)/);
  await usage(readMap(ctxOf('{"queues": {"a": 1}}'), '-'), /^--map stdin: queues a: the new name must be a string/);
  await usage(readMap(ctxOf('{"queues": "x"}'), '-'), /^--map stdin: queues must be an object/);
  await usage(readMap(ctxOf('not json'), '-'), /^--map stdin is not JSON/);
  const ctx = ctxOf();
  fs.writeFileSync(path.join(ctx.cwd, 'bad.json'), 'not json');
  await usage(readMap(ctx, 'bad.json'), /^--map bad\.json is not JSON/);
  await usage(readMap(ctx, 'missing.json'), /^--map missing\.json: /);
});

test('map renames the draft of a versioned object too', () => {
  const src = {
    kinds: {
      'wilma-tools': [
        {name: 'lookup', data: {name: 'lookup', description: 'v2', draft: {name: 'lookup', description: 'next'}}},
        {name: 'plain', data: {name: 'plain'}},
      ],
    },
  };
  const out = applyMap(src, {'wilma-tools': {lookup: 'find', plain: 'simple'}});
  assert.deepEqual(out.kinds['wilma-tools'], [
    {name: 'find', data: {name: 'find', description: 'v2', draft: {name: 'find', description: 'next'}}},
    {name: 'simple', data: {name: 'simple'}},
  ]);
});

test('an x-bees user is mapped by e-mail in any case, to the e-mail in lower case', () => {
  const src = {
    kinds: {
      'wilma-agents': [
        {name: 'a', data: {name: 'a', access: {grants: [{userId: {$ref: 'xbees-users/ann@x.example', as: 'id'}}]}}},
      ],
    },
    needs: {'wilma-agents/a': ['xbees-users/ann@x.example']},
  };
  const out = applyMap(src, {'xbees-users': {'Ann@X.example': 'Anna@Y.example'}});
  assert.deepEqual(out.kinds['wilma-agents'][0].data.access.grants[0].userId, {
    $ref: 'xbees-users/anna@y.example',
    as: 'id',
  });
  assert.deepEqual(out.needs, {'wilma-agents/a': ['xbees-users/anna@y.example']});
});
