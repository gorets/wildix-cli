import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {groups, scopeGroups} from '../src/commands/key.mjs';
import {savedAccess, saveAccess} from '../src/pbx.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const PERSONAL = 'personal-token-secret';
const ID_TOKEN = 'id-token-secret';
const VALUE = `wsk-v1-${'k'.repeat(93)}`;
const ID1 = 'e3S-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID2 = 'Zx9-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = Date.UTC(2026, 10, 8, 12);
const meta = (over = {}) => ({
  id: ID1,
  companyId: 'it_x',
  name: 'Reporting',
  scopes: ['company:read'],
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
  expiresAt: '2026-11-09T10:00:00.000Z',
  ...over,
});

// The auth service and the PBX in one fake: "METHOD host/path" → value or function(body, n, init).
function fake({api = {}, access} = {}) {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  saveAccess(
    access ?? {
      host: 'demo.wildixin.com',
      port: 443,
      auth: 'password',
      mode: 'basic',
      username: 'admin',
      password: 'pw',
      serial: '1234',
    },
    env,
  );
  const calls = [];
  const routes = {
    'GET demo.wildixin.com/api/v1/personal/token/': {type: 'result', result: {token: PERSONAL}},
    'POST auth-stage.wildix.com/api/v2/OpenId/service': {type: 'result', result: {id_token: ID_TOKEN}},
    ...Object.fromEntries(Object.entries(api).map(([k, v]) => [k.replace(' /', ' auth-stage.wildix.com/api/v3/'), v])),
  };
  const fetch = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.host}${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({key, body});
    const r = routes[key];
    if (r === undefined) return new Response('{"message":"no route"}', {status: 404});
    const out = typeof r === 'function' ? r(body, calls.filter((c) => c.key === key).length) : r;
    return out instanceof Response ? out : new Response(JSON.stringify(out), {status: 200});
  };
  const v3 = () => calls.filter((c) => c.key.includes('/api/v3/'));
  const wx = (argv, options = {}) =>
    run([...argv, '--pbx', 'demo.wildixin.com', '--env', 'stage'], {
      env,
      fetch,
      registry: {groups},
      now: () => NOW,
      ...options,
    });
  return {env, calls, v3, wx, text: (argv, o = {}) => wx([...argv, '--no-color'], {output: 'text', ...o})};
}

const LIST = {
  'GET /api-keys/': {
    apiKeys: [meta(), meta({id: ID2, name: 'Backup', scopes: ['pbx:read', 'pbx:*'], userExtension: '201'})],
  },
};

// ---- scopes, list, get -----------------------------------------------------------------------------------------

test('scopes lists the catalog; --group narrows it', async () => {
  const scopes = [
    {scope: 'company:read', description: 'Read the company', group: 'Company'},
    {scope: 'pbx:*', description: 'Change the PBX', group: 'PBX', status: 'future'},
  ];
  const f = fake({api: {'GET /scopes': {scopes}}});
  assert.deepEqual(JSON.parse((await f.wx(['key', 'scopes'])).stdout).scopes, scopes);
  const t = await f.text(['key', 'scopes', '--group', 'pbx']);
  assert.match(t.stdout, /pbx:\*/);
  assert.doesNotMatch(t.stdout, /company:read/);
});

test('list shows the metadata of the keys', async () => {
  const f = fake({api: LIST});
  const j = JSON.parse((await f.wx(['key', 'list'])).stdout);
  assert.equal(j.apiKeys.length, 2);
  const t = (await f.text(['key', 'list'])).stdout;
  assert.match(t, /Reporting/);
  assert.match(t, /company:read/);
  assert.match(t, /201/);
});

test('get by a full id asks the service for that key', async () => {
  const f = fake({api: {[`GET /api-keys/${ID1}`]: {apiKey: meta()}}});
  const r = await f.wx(['key', 'get', ID1]);
  assert.equal(JSON.parse(r.stdout).apiKey.id, ID1);
  assert.equal(f.v3().length, 1);
});

test('get by name works through the list and the key itself', async () => {
  const f = fake({api: {...LIST, [`GET /api-keys/${ID2}`]: {apiKey: meta({id: ID2, name: 'Backup'})}}});
  const r = await f.wx(['key', 'get', 'Backup']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).apiKey.name, 'Backup');
});

test('an unknown name is a usage error', async () => {
  const f = fake({api: LIST});
  const r = await f.wx(['key', 'get', 'Nothing']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /No key named Nothing/);
});

// ---- rename, delete --------------------------------------------------------------------------------------------

test('rename sends only the new name', async () => {
  const f = fake({api: {...LIST, [`PUT /api-keys/${ID1}`]: (b) => ({apiKey: meta({name: b.name})})}});
  const r = await f.wx(['key', 'rename', 'Reporting', 'Reporting v2']);
  assert.equal(r.code, 0);
  assert.deepEqual(f.v3().at(-1), {
    key: `PUT auth-stage.wildix.com/api/v3/api-keys/${ID1}`,
    body: {name: 'Reporting v2'},
  });
  assert.equal((await f.wx(['key', 'rename', ID1, 'ab'])).code, 64); // too short: no request
});

test('delete needs --yes and does nothing without it', async () => {
  const f = fake({api: {...LIST, [`DELETE /api-keys/${ID1}`]: {}}});
  const r = await f.wx(['key', 'delete', 'Reporting']);
  assert.equal(r.code, 64);
  assert.equal(f.calls.length, 0);
  const ok = await f.wx(['key', 'delete', 'Reporting', '--yes']);
  assert.equal(ok.code, 0);
  assert.equal(f.v3().at(-1).key, `DELETE auth-stage.wildix.com/api/v3/api-keys/${ID1}`);
});

// ---- create ----------------------------------------------------------------------------------------------------

const CREATE = (over = {}) => ({
  'POST /api-keys/': (b) => ({
    apiKey: {
      ...meta({name: b.name, scopes: b.scopes, expiresAt: b.expiresAt, userExtension: b.userExtension}),
      key: VALUE,
      ...over,
    },
  }),
});

test('create without a destination for the key is refused before any request', async () => {
  const f = fake({api: CREATE()});
  const r = await f.wx(['key', 'create', '--name', 'Reporting', '--scope', 'company:read']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--to FILE, --login or --show-secrets/);
  assert.equal(f.calls.length, 0);
});

test('create --to writes the key to a new 0600 file and never prints it', async () => {
  const f = fake({api: CREATE()});
  const file = path.join(tempConfigDir(), 'key.txt');
  const r = await f.wx([
    'key',
    'create',
    '--name',
    'Reporting',
    '--scope',
    'company:read',
    '--scope',
    'pbx:read',
    '--expires',
    '30d',
    '--user',
    '201',
    '--to',
    file,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), `${VALUE}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!r.stdout.includes(VALUE) && !r.stderr.includes(VALUE));
  const j = JSON.parse(r.stdout);
  assert.equal(j.apiKey.id, ID1);
  assert.equal(fs.realpathSync(j.savedTo), fs.realpathSync(file));
  assert.equal('key' in j.apiKey, false);
  assert.deepEqual(f.v3().at(-1).body, {
    name: 'Reporting',
    scopes: ['company:read', 'pbx:read'],
    expiresAt: new Date(NOW + 30 * 86400_000).toISOString(),
    userExtension: '201',
  });
  for (const t of [PERSONAL, ID_TOKEN]) assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t));
});

test('create --to refuses an existing file before any request', async () => {
  const f = fake({api: CREATE()});
  const file = path.join(tempConfigDir(), 'key.txt');
  fs.writeFileSync(file, 'x');
  const r = await f.wx(['key', 'create', '--name', 'Reporting', '--scope', 'company:read', '--to', file]);
  assert.equal(r.code, 64);
  assert.equal(f.v3().length, 0);
});

test('create --show-secrets prints the key, in text and in JSON', async () => {
  const f = fake({api: CREATE()});
  const j = await f.wx(['key', 'create', '--name', 'Reporting', '--scope', 'company:read', '--show-secrets']);
  assert.equal(JSON.parse(j.stdout).key, VALUE);
  const t = await f.text(['key', 'create', '--name', 'Reporting', '--scope', 'company:read', '--show-secrets']);
  assert.ok(t.stdout.includes(VALUE));
});

test('create --login saves the key as the login of the PBX, but only with --yes over a password login', async () => {
  const f = fake({api: CREATE()});
  const no = await f.wx(['key', 'create', '--name', 'Reporting', '--scope', 'pbx:read', '--login']);
  assert.equal(no.code, 64);
  assert.match(no.stderr, /--yes/);
  assert.equal(f.v3().length, 0);
  const r = await f.wx(['key', 'create', '--name', 'Reporting', '--scope', 'pbx:read', '--login', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(VALUE));
  const a = savedAccess('demo.wildixin.com', f.env);
  assert.equal(a.auth, 'apikey');
  assert.equal(a.key, VALUE);
  assert.equal(a.serial, '1234');
  assert.match(
    (await f.text(['key', 'list'])).stderr + (await f.wx(['key', 'list'])).stderr,
    /Company API Key cannot manage keys/,
  );
});

test('create checks the name, scopes, expiry and user before any request', async () => {
  const f = fake({api: CREATE()});
  const bad = async (args, re) => {
    const r = await f.wx(['key', 'create', '--show-secrets', ...args]);
    assert.equal(r.code, 64, args.join(' '));
    assert.match(r.stderr, re);
  };
  await bad(['--scope', 'a:b'], /--name/);
  await bad(['--name', 'ab', '--scope', 'a:b'], /3 to 100/);
  await bad(['--name', 'Reporting', '--scope', 'nocolon'], /scope/);
  await bad(['--name', 'Reporting', '--scope', 'a:b', '--expires', '30m'], /1 hour/);
  await bad(['--name', 'Reporting', '--scope', 'a:b', '--expires', '2y'], /1 year/);
  await bad(['--name', 'Reporting', '--scope', 'a:b', '--expires', 'soon'], /--expires/);
  await bad(['--name', 'Reporting', '--scope', 'a:b', '--user', 'bob'], /--user/);
  await bad(['--name', 'Reporting'], /--scope/); // no terminal: no picker
  assert.equal(f.calls.length, 0);
});

test('create accepts an ISO date and a bare 1h (moved just past the minimum)', async () => {
  const f = fake({api: CREATE()});
  const a = await f.wx([
    'key',
    'create',
    '--name',
    'Reporting',
    '--scope',
    'a:b',
    '--expires',
    '2026-12-01T00:00:00Z',
    '--show-secrets',
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(f.v3().at(-1).body.expiresAt, '2026-12-01T00:00:00.000Z');
  const b = await f.wx(['key', 'create', '--name', 'Reporting', '--scope', 'a:b', '--expires', '1h', '--show-secrets']);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(Date.parse(f.v3().at(-1).body.expiresAt) > NOW + 3600_000);
});

test('*:* needs --yes and lasts 7 days at most', async () => {
  const f = fake({api: CREATE()});
  const base = ['key', 'create', '--name', 'Dev', '--scope', '*:*', '--show-secrets'];
  assert.equal((await f.wx([...base, '--expires', '3d'])).code, 64);
  assert.equal((await f.wx([...base, '--expires', '30d', '--yes'])).code, 64);
  const ok = await f.wx([...base, '--expires', '3d', '--yes']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /full access/i);
});

test('the picker offers the catalog grouped, with the description and the status', () => {
  const g = scopeGroups([
    {scope: 'company:read', description: 'Read the company', group: 'Company'},
    {scope: 'pbx:read', description: 'Read the PBX', group: 'PBX', status: 'future'},
    {scope: 'pbx:*', description: 'Change the PBX', group: 'PBX'},
  ]);
  assert.deepEqual(
    g.map((x) => [x.id, x.items.map((i) => i.id)]),
    [
      ['Company', ['company:read']],
      ['PBX', ['pbx:read', 'pbx:*']],
    ],
  );
  assert.equal(g[1].items[0].badge, 'future');
  assert.match(g[1].items[0].disabled, /future/); // refused by the service
  assert.equal(g[1].items[1].disabled, undefined);
});

test('a key that cannot be written is deleted again, not lost', async () => {
  const f = fake({api: {...CREATE(), [`DELETE /api-keys/${ID1}`]: {}}});
  const r = await f.wx([
    'key',
    'create',
    '--name',
    'Reporting',
    '--scope',
    'a:b',
    '--to',
    '/nonexistent-folder-xyz/key.txt',
  ]);
  assert.notEqual(r.code, 0);
  assert.deepEqual(
    f.v3().map((c) => c.key.split(' ')[0]),
    ['POST', 'DELETE'],
  );
  assert.match(r.stderr, /deleted again/);
  assert.ok(!r.stderr.includes(VALUE));
});

test('the error of the service reaches the user, without tokens', async () => {
  const f = fake({api: {'POST /api-keys/': new Response('{"message":"expiresAt is too far"}', {status: 400})}});
  const r = await f.wx(['key', 'create', '--name', 'Reporting', '--scope', 'a:b', '--show-secrets']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /expiresAt is too far/);
});
