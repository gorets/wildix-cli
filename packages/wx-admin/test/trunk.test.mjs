import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {MASK, groups} from '../src/commands/trunk.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

const SIP = {
  id: 3,
  title: 'carrier',
  name: 'login1',
  register: 'login1?login1:TOPSECRET:"login1"@sip.example.com:5060',
  settingsPbx: {
    audioCodecs: [
      {key: 'alaw', value: 20, enable: true},
      {key: 'g729', value: 20, enable: false},
    ],
    context: 'main',
    host: 'sip.example.com',
    port: '5060',
    peername: 'login1',
    userName: 'login1',
    secret: 'TOPSECRET',
    transportWildix: 'udp',
    dtmfMode: 'rfc2833',
    forceSrtp: false,
  },
  settingsWms: {enableReg: true, regSecret: 'PROXYSECRET', regUsername: ''},
  status: {
    outgoing: {state: 'on', title: 'Registered sip.example.com'},
    incoming: {state: 'unregistered', title: 'Unregistered'},
  },
};
const PSTN = {
  id: 3,
  name: 'bri0',
  title: 'ISDN',
  ports: 2,
  technology: 'bri',
  address: '10.0.0.5',
  settingsPbx: {username: 'bri0', secret: 'GWSECRET', context: 'main'},
  settingsMgw: {toneZone: 'it'},
  status: {active: true},
};
const FXO = {
  id: 7,
  username: 'fxo1',
  title: 'Analog',
  technology: 'fxo',
  address: '10.0.0.6',
  model: 'W04FXO',
  settingsMgw: {ports: [{port: 1, context: 'main'}]},
  status: {active: false},
};

// A PBX with trunks, trunk groups and price lists in memory, as the API answers (lists only; "Success" for writes).
function fakePbx() {
  const store = {
    Sip: [structuredClone(SIP)],
    Pstn: [structuredClone(PSTN)],
    Fxo: [structuredClone(FXO)],
    Groups: [
      {
        id: 1,
        name: 'out',
        description: 'outgoing',
        rules: [{trunkName: 'login1', remove: 0, prepend: '', maxCalls: 2}],
      },
    ],
    Prices: [
      {
        id: 5,
        name: 'italy',
        items: [
          {
            dialprefix: '39',
            destination: 'Italy',
            rate: '0.03',
            minDuration: 0,
            billingBlock: 60,
            connectCharge: 0,
            startDay: 1,
            stopDay: 7,
            startTime: 0,
            stopTime: 86400,
          },
        ],
      },
    ],
  };
  const calls = [];
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
  const ok = (r = 'Success') => reply(200, {type: 'result', result: r});
  const fetch = async (url, init) => {
    const p = new URL(url).pathname.replace(/^\/api\/v1/, '');
    let body;
    if (init.body instanceof FormData) {
      body = {};
      for (const [k, v] of init.body) body[k] = typeof v === 'string' ? v : {file: v.name, text: await v.text()};
    } else if (init.body) body = JSON.parse(init.body);
    calls.push({method: init.method, path: p, body});
    const exp = p.match(/^\/Trunks\/Prices\/(\d+)\/export$/);
    if (exp)
      return new Response('dialprefix,destination\n39,Italy\n', {
        status: 200,
        headers: {'content-type': 'text/html; charset=UTF-8'},
      });
    const m = p.match(/^\/Trunks\/(Sip|Pstn|Fxo|Groups|Prices)\/(?:(\d+)\/?)?$/);
    if (!m) return reply(404, {type: 'error', reason: 'Not found'});
    const [, kind, id] = m;
    const list = store[kind];
    if (init.method === 'GET') return ok({records: list});
    if (init.method === 'POST' && !id) {
      const rec = {id: 50 + list.length, ...body};
      if (kind === 'Prices') {
        rec.items = [{dialprefix: '1'}];
        delete rec.upload;
        list.push(rec);
        return ok(rec);
      }
      list.push(rec);
      return ok();
    }
    const at = list.findIndex((x) => String(x.id) === id);
    if (at < 0) return reply(404, {type: 'error', reason: 'Not found'});
    if (init.method === 'PUT' || init.method === 'POST') {
      list[at] = {...list[at], ...body, id: list[at].id};
      return ok(kind === 'Prices' ? list[at] : 'Success');
    }
    if (init.method === 'DELETE') {
      list.splice(at, 1);
      return ok();
    }
    return reply(405, {});
  };
  return {fetch, calls, store};
}

const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry: {groups}, ...options});
const writes = (pbx) => pbx.calls.filter((c) => c.method !== 'GET');
const SECRETS = /TOPSECRET|PROXYSECRET|GWSECRET/;

test('trunk list and get: secrets never in text, masked in JSON unless --show-secrets', async () => {
  const pbx = fakePbx();
  const text = await wx(pbx, ['trunk', 'list'], {output: 'text'});
  assert.equal(
    text.stdout,
    [
      'SIP   3  carrier  login1  sip.example.com:5060  main  out Registered sip.example.com, in Unregistered',
      'PSTN  3  ISDN     bri     10.0.0.5              main  active',
      'FXO   7  Analog   fxo     10.0.0.6              main  inactive',
      '',
    ].join('\n'),
  );
  const json = (await wx(pbx, ['trunk', 'list'])).stdout;
  assert.doesNotMatch(json, SECRETS);
  const all = JSON.parse(json);
  assert.deepEqual(Object.keys(all), ['sip', 'pstn', 'fxo']);
  assert.equal(all.sip[0].settingsPbx.secret, MASK);
  assert.equal(all.sip[0].register, MASK);
  assert.equal(all.sip[0].settingsWms.regSecret, MASK);
  assert.equal(all.sip[0].settingsWms.regUsername, '');
  assert.equal(all.pstn[0].settingsPbx.secret, MASK);
  assert.match((await wx(pbx, ['trunk', 'list', '--type', 'sip', '--show-secrets'])).stdout, /TOPSECRET/);
  assert.deepEqual(pbx.calls.at(-1), {method: 'GET', path: '/Trunks/Sip/', body: undefined});
  assert.equal((await wx(pbx, ['trunk', 'list', '--type', 'isdn'])).code, 64);

  const got = await wx(pbx, ['trunk', 'get', 'carrier', '--show-secrets'], {output: 'text'});
  assert.doesNotMatch(got.stdout, SECRETS);
  assert.equal(got.stdout.split('\n')[0], 'carrier (SIP, id 3) · name login1');
  assert.match(got.stdout, /^password set · proxy password set$/m);
  assert.match(got.stdout, /^codecs alaw · dtmf rfc2833/m);
  assert.equal((await wx(pbx, ['trunk', 'get', '3'])).code, 64); // SIP 3 and PSTN 3
  assert.equal(JSON.parse((await wx(pbx, ['trunk', 'get', '3', '--type', 'pstn'])).stdout).kind, 'pstn');
  assert.equal(JSON.parse((await wx(pbx, ['trunk', 'get', 'fxo1'])).stdout).id, 7);
  assert.equal((await wx(pbx, ['trunk', 'get', 'nope'])).code, 64);
});

test('trunk create: every field filled, the password hidden from stdin, never an argument', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['trunk', 'create', 'new'])).code, 64);
  const r = await wx(
    pbx,
    [
      'trunk',
      'create',
      'new carrier',
      '--host',
      'sip.other.com',
      '--user',
      'acc42',
      '--secret',
      '--transport',
      'tls',
      '--port',
      '5061',
      '--context',
      'users',
      '--register',
    ],
    {stdin: 'S3CRET\n'},
  );
  assert.equal(r.code, 0, r.stderr);
  const post = writes(pbx).at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/Trunks/Sip/');
  assert.equal(post.body.title, 'new carrier');
  assert.equal(post.body.name, 'acc42');
  assert.deepEqual(
    [
      post.body.settingsPbx.host,
      post.body.settingsPbx.port,
      post.body.settingsPbx.peername,
      post.body.settingsPbx.userName,
      post.body.settingsPbx.secret,
      post.body.settingsPbx.transportWildix,
      post.body.settingsPbx.context,
    ],
    ['sip.other.com', '5061', 'acc42', 'acc42', 'S3CRET', 'tls', 'users'],
  );
  assert.equal(post.body.settingsWms.enableReg, true);
  assert.equal(post.body.settingsPbx.dtmfMode, 'rfc2833'); // from the template
  assert.equal(post.body.settingsWms.regSecret, '');
  assert.ok(!('id' in post.body));
  assert.doesNotMatch(r.stdout, /S3CRET/);
  assert.equal(JSON.parse(r.stdout).settingsPbx.secret, MASK);
  assert.equal((await wx(pbx, ['trunk', 'create', 'x', '--host', 'h', '--user', 'u', '--transport', 'sctp'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'create', 'x', '--host', 'bad host', '--user', 'u'])).code, 64);

  // From the JSON of get (masked): refused, the password must be given again.
  const dir = tempConfigDir();
  const file = path.join(dir, 't.json');
  fs.writeFileSync(file, (await wx(pbx, ['trunk', 'get', 'carrier'])).stdout);
  assert.equal((await wx(pbx, ['trunk', 'create', 'copy', '--from', file, '--user', 'u2'])).code, 64);
  const copy = await wx(pbx, ['trunk', 'create', 'copy', '--from', file, '--user', 'u2', '--secret'], {stdin: 'pw2'});
  assert.equal(copy.code, 0, copy.stderr);
  assert.equal(writes(pbx).at(-1).body.settingsPbx.host, 'sip.example.com');
  assert.equal(writes(pbx).at(-1).body.settingsPbx.secret, 'pw2');
  assert.equal(writes(pbx).at(-1).body.settingsWms.regSecret, ''); // masked in the file: left empty
  assert.equal(writes(pbx).at(-1).body.register, '');
  assert.equal(writes(pbx).at(-1).body.name, 'u2');
});

test('trunk update: --yes, whole trunk written, masked secrets kept, SIP-only options refused for others', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['trunk', 'update', 'carrier', '--title', 'x'])).code, 64);
  assert.equal(writes(pbx).length, 0);
  // a new host needs its own password: the current one is never sent to another host
  assert.equal((await wx(pbx, ['trunk', 'update', 'carrier', '--host', 'sip2.example.com', '--yes'])).code, 64);
  assert.equal(writes(pbx).length, 0);
  const r = await wx(pbx, ['trunk', 'update', 'carrier', '--title', 'Carrier 1', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  const put = writes(pbx).at(-1);
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/Trunks/Sip/3');
  assert.equal(put.body.title, 'Carrier 1');
  assert.equal(put.body.settingsPbx.host, SIP.settingsPbx.host);
  assert.equal(put.body.settingsPbx.secret, 'TOPSECRET'); // the trunk keeps its password
  assert.equal(put.body.register, SIP.register);
  assert.deepEqual(put.body.settingsPbx.audioCodecs, SIP.settingsPbx.audioCodecs);
  assert.doesNotMatch(r.stdout, SECRETS);

  const dir = tempConfigDir();
  const file = path.join(dir, 't.json');
  const edited = JSON.parse((await wx(pbx, ['trunk', 'get', 'login1'])).stdout);
  edited.settingsPbx.dtmfMode = 'info';
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.equal((await wx(pbx, ['trunk', 'update', 'login1', '--from', file, '--yes'])).code, 0);
  const put2 = writes(pbx).at(-1).body;
  assert.equal(put2.settingsPbx.dtmfMode, 'info');
  assert.equal(put2.settingsPbx.secret, 'TOPSECRET');
  assert.equal(put2.settingsWms.regSecret, 'PROXYSECRET');
  assert.ok(!('kind' in put2));

  const pstn = await wx(pbx, ['trunk', 'update', 'bri0', '--context', 'users', '--yes']);
  assert.equal(pstn.code, 0, pstn.stderr);
  assert.equal(writes(pbx).at(-1).path, '/Trunks/Pstn/3/');
  assert.deepEqual(writes(pbx).at(-1).body.settingsPbx, {username: 'bri0', secret: 'GWSECRET', context: 'users'});
  assert.equal((await wx(pbx, ['trunk', 'update', 'bri0', '--host', 'h', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'update', 'Analog', '--context', 'users', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'update', 'Analog', '--title', 'Analog 2', '--yes'])).code, 0);
  assert.equal(writes(pbx).at(-1).path, '/Trunks/Fxo/7/');
  assert.equal((await wx(pbx, ['trunk', 'update', 'login1', '--yes'])).code, 64);
  const moved = await wx(
    pbx,
    ['trunk', 'update', '3', '--type', 'sip', '--host', 'sip2.example.com', '--secret', '--yes'],
    {stdin: 'NEWSECRET\n'},
  );
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(writes(pbx).at(-1).body.settingsPbx.host, 'sip2.example.com');
  assert.equal(writes(pbx).at(-1).body.settingsPbx.secret, 'NEWSECRET');
  assert.ok(!moved.stdout.includes('NEWSECRET'));
});

test('trunk delete: SIP only, --yes', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['trunk', 'delete', 'carrier'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'delete', 'Analog', '--yes'])).code, 64);
  const r = await wx(pbx, ['trunk', 'delete', 'login1', '--yes'], {output: 'text'});
  assert.equal(r.stdout, 'Deleted SIP trunk carrier (id 3)\n');
  assert.deepEqual(writes(pbx), [{method: 'DELETE', path: '/Trunks/Sip/3', body: undefined}]);
});

test('trunk groups: list, show, create with --trunk specs, update, delete with --yes', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['trunk', 'groups'], {output: 'text'})).stdout, '1  out  login1(max 2)  outgoing\n');
  assert.equal(
    (await wx(pbx, ['trunk', 'groups', 'out'], {output: 'text'})).stdout,
    'out (id 1) — outgoing\n  1  login1(max 2)\n',
  );
  const c = await wx(pbx, [
    'trunk',
    'group-create',
    'backup',
    '--trunk',
    'login1 remove=1 prepend=+39',
    '--trunk',
    'ghost timeout=30',
  ]);
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stderr, /no trunk is named ghost/);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'POST',
    path: '/Trunks/Groups/',
    body: {
      name: 'backup',
      description: '',
      rules: [
        {trunkName: 'login1', remove: 1, prepend: '+39'},
        {trunkName: 'ghost', remove: 0, prepend: '', timeout: 30},
      ],
    },
  });
  assert.equal((await wx(pbx, ['trunk', 'group-create', 'bad-name', '--trunk', 'login1'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'group-create', 'g2'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'group-create', 'g2', '--trunk', 'login1 prepend=abc'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'group-create', 'g2', '--trunk', 'login1 weight=2'])).code, 64);

  assert.equal((await wx(pbx, ['trunk', 'group-update', 'out', '--description', 'main way out'])).code, 0);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'PUT',
    path: '/Trunks/Groups/1',
    body: {
      name: 'out',
      description: 'main way out',
      rules: [{trunkName: 'login1', remove: 0, prepend: '', maxCalls: 2}],
    },
  });
  assert.equal((await wx(pbx, ['trunk', 'group-update', 'out'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'group-update', 'out', '--trunk', 'carrier'])).code, 64); // replaces every route: --yes
  assert.equal((await wx(pbx, ['trunk', 'group-delete', 'out'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'group-delete', 'out', 'backup', '--yes'])).code, 0);
  assert.deepEqual(
    writes(pbx)
      .slice(-2)
      .map((x) => `${x.method} ${x.path}`),
    ['DELETE /Trunks/Groups/1', 'DELETE /Trunks/Groups/51'],
  );
});

test('trunk prices: list, rates, create and update as multipart, delete with --yes, export never overwrites', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['trunk', 'prices'], {output: 'text'})).stdout, '5  italy  1 rates\n');
  assert.match(
    (await wx(pbx, ['trunk', 'prices', 'italy'], {output: 'text'})).stdout,
    /^italy \(id 5\) · 1 rates\n39 +Italy +0\.03 +min 0s +block 60s/,
  );

  const dir = tempConfigDir();
  const csv = path.join(dir, 'rates.csv');
  fs.writeFileSync(csv, 'dialprefix,destination\n1,USA\n');
  assert.equal((await wx(pbx, ['trunk', 'price-create', 'usa'])).code, 64);
  const c = await wx(pbx, ['trunk', 'price-create', 'usa', '--file', csv], {output: 'text'});
  assert.equal(c.stdout, 'Created price list usa (id 51) · 1 rates\n', c.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'POST',
    path: '/Trunks/Prices/',
    body: {name: 'usa', upload: {file: 'rates.csv', text: 'dialprefix,destination\n1,USA\n'}},
  });
  assert.equal((await wx(pbx, ['trunk', 'price-create', 'x', '--file', path.join(dir, 'missing.csv')])).code, 64);
  fs.writeFileSync(path.join(dir, 'secret.csv'), 'x');
  assert.equal((await wx(pbx, ['trunk', 'price-create', 'x', '--file', path.join(dir, 'secret.csv')])).code, 64);

  assert.equal((await wx(pbx, ['trunk', 'price-update', 'italy', '--name', 'italia'])).code, 0);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'POST',
    path: '/Trunks/Prices/5/',
    body: {name: 'italia', method: 'PUT'},
  });
  assert.equal((await wx(pbx, ['trunk', 'price-update', 'italia', '--file', csv])).code, 0);
  assert.deepEqual(writes(pbx).at(-1).body, {
    name: 'italia',
    upload: {file: 'rates.csv', text: 'dialprefix,destination\n1,USA\n'},
    method: 'PUT',
  });
  assert.equal((await wx(pbx, ['trunk', 'price-update', 'italia'])).code, 64);

  assert.equal(
    (await wx(pbx, ['trunk', 'price-export', 'italia'], {output: 'text'})).stdout,
    'dialprefix,destination\n39,Italy\n',
  );
  assert.equal(pbx.calls.at(-1).path, '/Trunks/Prices/5/export');
  const out = path.join(dir, 'out.csv');
  const e = await wx(pbx, ['trunk', 'price-export', '5', '--to', out]);
  assert.equal(e.code, 0, e.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'dialprefix,destination\n39,Italy\n');
  assert.equal((await wx(pbx, ['trunk', 'price-export', '5', '--to', out])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'price-export', '5', '--to', path.join(dir, '.hidden.csv')])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'price-export', '99'])).code, 64); // the PBX would export a header only

  assert.equal((await wx(pbx, ['trunk', 'price-delete', 'italia'])).code, 64);
  assert.equal((await wx(pbx, ['trunk', 'price-delete', 'italia', '--yes'])).code, 0);
  assert.deepEqual(writes(pbx).at(-1), {method: 'DELETE', path: '/Trunks/Prices/5/', body: undefined});
});

test('every trunk command has usage, summary, described options and a text formatter', () => {
  for (const c of Object.values(groups.trunk.commands)) {
    assert.ok(c.usage && c.summary && Array.isArray(c.args) && typeof c.text === 'function', c.usage);
    for (const [name, o] of Object.entries(c.options)) assert.ok(o.description, `${c.usage} --${name}`);
  }
});
