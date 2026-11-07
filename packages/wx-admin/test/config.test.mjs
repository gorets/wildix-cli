import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {compare, differences} from '../src/commands/config.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

// A PBX whose GETs answer from a map of paths (as the PBX wraps them); unknown paths answer 403.
function fakePbx(state) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({method: init.method, path: u.pathname});
    if (init.method !== 'GET') return new Response('{}', {status: 405});
    const key = u.pathname.replace('/api/v1', '');
    if (!Object.hasOwn(state, key))
      return new Response(JSON.stringify({type: 'error', reason: 'Access error'}), {status: 403});
    return new Response(JSON.stringify({type: 'result', result: state[key]}), {status: 200});
  };
  return {fetch, calls};
}

const STATE = {
  '/PBX/Dialplans/': {
    records: [
      {id: 1, name: 'users'},
      {id: 7, name: 'night'},
    ],
  },
  '/PBX/Dialplans/1/': {
    id: 1,
    name: 'users',
    description: '',
    numbers: [{number: '100', apps: [{name: 'Answer', params: {}}]}],
    includedDialplans: [{dialplanId: 7}, {dialplanId: -4}],
  },
  '/PBX/Dialplans/7/': {id: 7, name: 'night', description: 'after hours', numbers: [], includedDialplans: []},
  '/Trunks/Sip/': {
    records: [
      {
        id: 3,
        title: 'main',
        name: '+3912345',
        status: 'registered',
        settingsPbx: {secret: 'pw', host: 'sip.example.com'},
        register: 'u:pw@host',
      },
    ],
  },
  '/Dialplan/CallGroups/': {records: [{id: 5, title: 'support', members: ['101@internalcalls'], settings: {}}]},
};

test('backup: one file per object, ids and status left out, secrets masked, included dialplans by name, never into a used folder', async () => {
  const pbx = fakePbx(STATE);
  const dir = path.join(tempConfigDir(), 'bk');
  const r = await run(['config', 'backup', '--to', dir, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /timetables: not read/);
  assert.ok(pbx.calls.every((c) => c.method === 'GET'));
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'dialplans', 'users.json'), 'utf8'));
  assert.deepEqual(users.includedDialplans, [{dialplan: 'night'}, {dialplanId: -4}]);
  assert.ok(!('id' in users));
  const trunk = JSON.parse(fs.readFileSync(path.join(dir, 'trunks-sip', 'main.json'), 'utf8'));
  assert.equal(trunk.name, '+3912345');
  assert.equal(trunk.settingsPbx.secret, '********');
  assert.equal(trunk.register, '********');
  assert.ok(!('status' in trunk));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.objects['trunks-sip']['main.json'], 'main');
  assert.equal(
    (await run(['config', 'backup', '--to', dir, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch})).code,
    64,
  );
  assert.equal(
    (
      await run(['config', 'backup', '--to', path.join(tempConfigDir(), '.hidden'), '--pbx', 'demo'], {
        env: env(),
        fetch: pbx.fetch,
      })
    ).code,
    64,
  );
});

test('diff: the same backup is no difference; a changed, added and removed object are named with their paths', async () => {
  const dir = path.join(tempConfigDir(), 'bk');
  await run(['config', 'backup', '--to', dir, '--pbx', 'demo', '--only', 'dialplans,queues'], {
    env: env(),
    fetch: fakePbx(STATE).fetch,
  });
  let r = await run(['config', 'diff', dir, '--pbx', 'demo', '--only', 'dialplans,queues'], {
    env: env(),
    fetch: fakePbx(STATE).fetch,
  });
  assert.equal(JSON.parse(r.stdout).same, true);
  const changed = structuredClone(STATE);
  changed['/PBX/Dialplans/7/'].description = 'night shift';
  changed['/Dialplan/CallGroups/'].records.push({id: 6, title: 'sales', members: [], settings: {}});
  changed['/PBX/Dialplans/'].records = changed['/PBX/Dialplans/'].records.filter((d) => d.name !== 'users');
  r = await run(['config', 'diff', dir, '--pbx', 'demo', '--only', 'dialplans,queues', '--no-color'], {
    env: env(),
    fetch: fakePbx(changed).fetch,
    output: 'text',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\+ queues\/sales$/m);
  assert.match(r.stdout, /^- dialplans\/users$/m);
  assert.match(r.stdout, /^~ dialplans\/night\n {4}description: "after hours" → "night shift"$/m);
});

test('diff with a side that could not read a kind: not compared, never "all added"; nothing compared is said so', async () => {
  const dir = path.join(tempConfigDir(), 'bk');
  await run(['config', 'backup', '--to', dir, '--pbx', 'demo', '--only', 'queues'], {
    env: env(),
    fetch: fakePbx(STATE).fetch,
  });
  const r = await run(['config', 'diff', dir, '--pbx', 'demo', '--only', 'queues', '--no-color'], {
    env: env(),
    fetch: fakePbx({}).fetch,
    output: 'text',
  });
  assert.match(r.stdout, /nothing to compare/);
  assert.match(r.stdout, /not compared \(not read on one side\): queues/);
  assert.equal((await run(['config', 'diff', '--pbx', 'demo'], {env: env(), fetch: fakePbx(STATE).fetch})).code, 64);
  assert.equal(
    (await run(['config', 'diff', tempConfigDir(), '--pbx', 'demo'], {env: env(), fetch: fakePbx(STATE).fetch})).code,
    64,
  );
});

test('differences and compare', () => {
  assert.deepEqual(differences({a: 1, b: [1, 2]}, {a: 1, b: [1, 3], c: true}), [
    {path: 'b[1]', from: 2, to: 3},
    {path: 'c', from: undefined, to: true},
  ]);
  assert.deepEqual(compare({k: {x: {v: 1}}}, {k: {x: {v: 1}}, j: {}}).skipped, ['j']);
});
