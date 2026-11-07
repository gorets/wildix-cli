import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

// A PBX with dialplans in memory: GET/POST/PUT/DELETE /PBX/Dialplans, answers wrapped as the PBX does. A PUT or POST
// whose apps miss a parameter in `required` is refused with 400, as a real PBX does.
function fakePbx(dialplans = [], required = {}) {
  const store = new Map(dialplans.map((d) => [d.id, structuredClone(d)]));
  let next = Math.max(10, ...store.keys()) + 1;
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), {status});
  const result = (r) => reply(200, {type: 'result', result: r});
  const missing = (numbers = []) =>
    numbers.flatMap((r) =>
      r.apps.flatMap((a) =>
        (required[a.name] ?? [])
          .filter((k) => !(k in (a.params ?? {})))
          .map((k) => `Not found parameter ${k} in ${r.number}/${a.name}`),
      ),
    );
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path: u.pathname, body});
    const m = u.pathname.match(/^\/api\/v1\/PBX\/Dialplans\/(?:([\d,]+)\/)?$/);
    if (!m) return reply(404, {type: 'error', reason: '404 Not Found'});
    if (init.method === 'GET' && !m[1])
      return result({records: [...store.values()].map(({id, name, description}) => ({id, name, description}))});
    if (init.method === 'GET')
      return store.has(Number(m[1]))
        ? result(store.get(Number(m[1])))
        : reply(404, {type: 'error', reason: 'Not found'});
    if (init.method === 'POST' || init.method === 'PUT') {
      const errors = missing(body.numbers);
      if (errors.length) return reply(400, {type: 'error', reason: 'Bad request', errors});
      const id = init.method === 'POST' ? next++ : Number(m[1]);
      const d = {...(store.get(id) ?? {id, name: body.name}), ...body, id};
      store.set(id, d);
      return result(d);
    }
    if (init.method === 'DELETE') {
      for (const id of m[1].split(',')) store.delete(Number(id));
      return result(null);
    }
    return reply(405, {});
  };
  return {fetch, calls, store};
}

const USERS = {
  id: 1,
  name: 'users',
  description: 'Internal',
  includedDialplans: [{dialplanId: -4}],
  numbers: [{number: '100', apps: [{name: 'Answer', params: []}], comment: ''}],
};
const wx = (pbx, argv, options = {}) => run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, ...options});

test('dialplan list, get by name, rules as text', async () => {
  const pbx = fakePbx([USERS]);
  assert.deepEqual(JSON.parse((await wx(pbx, ['dialplan', 'list'])).stdout), {
    records: [{id: 1, name: 'users', description: 'Internal'}],
  });
  const got = await wx(pbx, ['dialplan', 'get', 'users']);
  assert.equal(JSON.parse(got.stdout).includedDialplans[0].dialplanId, -4);
  const text = await wx(pbx, ['dialplan', 'rules', 'Users', '--no-color'], {output: 'text'});
  assert.equal(text.stdout, '  1  100  Answer\n');
  assert.equal((await wx(pbx, ['dialplan', 'get', 'nope'])).code, 64);
});

test('rule-add: --app specs, known parameters filled empty, existing [] params kept as {}, --position, --replace', async () => {
  const pbx = fakePbx([USERS], {DialPhone: ['number', 'timeout', 'options', 'msgForOperator']});
  let r = await wx(pbx, [
    'dialplan',
    'rule-add',
    'users',
    '201',
    '--app',
    'DialPhone number=201 timeout=20',
    '--app',
    '{"name": "Set", "params": {"key": "a", "value": "b c"}}',
    '--comment',
    'c',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const put = pbx.calls.find((c) => c.method === 'PUT').body;
  assert.deepEqual(put.numbers[0], {number: '100', apps: [{name: 'Answer', params: {}}], comment: ''});
  assert.deepEqual(put.numbers[1], {
    number: '201',
    apps: [
      {name: 'DialPhone', params: {number: '201', timeout: '20', options: '', msgForOperator: ''}},
      {name: 'Set', params: {key: 'a', value: 'b c'}},
    ],
    comment: 'c',
  });
  assert.deepEqual(put.includedDialplans, [{dialplanId: -4}]);
  r = await wx(pbx, ['dialplan', 'rule-add', 'users', '050', '--app', 'Answer', '--position', '1']);
  assert.deepEqual(
    pbx.store.get(1).numbers.map((n) => n.number),
    ['050', '100', '201'],
  );
  assert.equal((await wx(pbx, ['dialplan', 'rule-add', 'users', '100', '--app', 'Hangup'])).code, 64);
  assert.equal((await wx(pbx, ['dialplan', 'rule-add', 'users', '100', '--app', 'Hangup', '--replace'])).code, 0);
  assert.deepEqual(
    pbx.store
      .get(1)
      .numbers.find((n) => n.number === '100')
      .apps.map((a) => a.name),
    ['Hangup'],
  );
  assert.equal((await wx(pbx, ['dialplan', 'rule-add', 'users', '9', '--app', 'X a'])).code, 64);
  assert.equal((await wx(pbx, ['dialplan', 'rule-add', 'users', '9'])).code, 64);
});

test('a parameter the PBX names as missing is added empty and the write tried again', async () => {
  const pbx = fakePbx([USERS], {Playback: ['filename', 'noAnswer', 'later']});
  const r = await wx(pbx, ['dialplan', 'rule-add', 'users', '7', '--app', 'Playback filename=hello']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Added the empty parameter later to Playback in 7/);
  assert.deepEqual(pbx.store.get(1).numbers[1].apps[0].params, {filename: 'hello', noAnswer: '', later: ''});
});

test('rule-remove and delete need --yes; delete takes names and ids', async () => {
  const pbx = fakePbx([USERS, {id: 2, name: 'tmp', description: '', numbers: [], includedDialplans: []}]);
  assert.equal((await wx(pbx, ['dialplan', 'rule-remove', 'users', '100'])).code, 64);
  assert.equal((await wx(pbx, ['dialplan', 'rule-remove', 'users', '100', '--yes'])).code, 0);
  assert.deepEqual(pbx.store.get(1).numbers, []);
  assert.equal((await wx(pbx, ['dialplan', 'delete', 'tmp'])).code, 64);
  assert.equal(pbx.store.size, 2);
  const r = await wx(pbx, ['dialplan', 'delete', 'tmp', '1', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.calls.at(-1).path, '/api/v1/PBX/Dialplans/2,1/');
  assert.equal(pbx.store.size, 0);
});

test('export to a new file, import under another name or --replace', async () => {
  const pbx = fakePbx([USERS]);
  const dir = tempConfigDir();
  const file = path.join(dir, 'users.json');
  assert.equal((await wx(pbx, ['dialplan', 'export', 'users', '--to', file])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    name: 'users',
    description: 'Internal',
    numbers: USERS.numbers,
    includedDialplans: USERS.includedDialplans,
  });
  assert.equal((await wx(pbx, ['dialplan', 'export', 'users', '--to', file])).code, 64);
  assert.equal((await wx(pbx, ['dialplan', 'export', 'users', '--to', path.join(dir, '.hidden.json')])).code, 64);
  assert.equal((await wx(pbx, ['dialplan', 'import', '--from', file])).code, 64);
  const copy = await wx(pbx, ['dialplan', 'import', '--from', file, '--as', 'users2']);
  assert.equal(copy.code, 0, copy.stderr);
  assert.equal(pbx.calls.at(-1).method, 'POST');
  assert.equal((await wx(pbx, ['dialplan', 'import', '--from', file, '--replace'])).code, 64); // needs --yes
  assert.equal((await wx(pbx, ['dialplan', 'import', '--from', file, '--replace', '--yes'])).code, 0);
  assert.equal(pbx.calls.at(-1).method, 'PUT');
  const piped = await wx(pbx, ['dialplan', 'import', '--from', '-', '--as', 'users3'], {
    stdin: fs.readFileSync(file, 'utf8'),
  });
  assert.equal(piped.code, 0, piped.stderr);
});

test('create and update', async () => {
  const pbx = fakePbx([USERS]);
  assert.equal((await wx(pbx, ['dialplan', 'create', 'bad name'])).code, 64);
  const c = await wx(pbx, ['dialplan', 'create', 'night', '--description', 'after hours']);
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(pbx.calls.at(-1).body, {
    name: 'night',
    description: 'after hours',
    numbers: [],
    includedDialplans: [],
  });
  assert.equal((await wx(pbx, ['dialplan', 'update', 'night'])).code, 64);
  assert.equal((await wx(pbx, ['dialplan', 'update', 'night', '--description', 'changed'])).code, 0);
  assert.equal(pbx.calls.at(-1).body.description, 'changed');
  assert.ok(!('name' in pbx.calls.at(-1).body));
});

test('apps: the list of the API offline; --used reads the dialplans', async () => {
  const offline = await run(['dialplan', 'apps'], {env: {WILDIX_CONFIG_DIR: tempConfigDir()}, output: 'text'});
  assert.equal(offline.code, 0);
  assert.match(offline.stdout, /^DialPhone$/m);
  const pbx = fakePbx([USERS]);
  const used = JSON.parse((await wx(pbx, ['dialplan', 'apps', '--used'])).stdout);
  assert.deepEqual(
    used.apps.map((a) => [a.name, a.uses]),
    [['Answer', 1]],
  );
});
