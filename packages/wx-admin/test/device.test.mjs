import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups, normalizeMac} from '../src/commands/device.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

// A PBX that answers "METHOD /path" from a table (a value, or a function of the body), wrapped as the PBX does.
function fakePbx(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path: p, search: u.search, body});
    const key = `${init.method} ${p}`;
    if (!(key in routes)) return new Response(JSON.stringify({type: 'error', reason: '404 Not Found'}), {status: 404});
    const r = typeof routes[key] === 'function' ? routes[key](body) : routes[key];
    return new Response(JSON.stringify({type: 'result', result: r}), {status: 200});
  };
  return {fetch, calls};
}

const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry: {groups}, ...options});
const text = (pbx, argv, options = {}) => wx(pbx, [...argv, '--no-color'], {output: 'text', ...options});

const PHONE = {
  id: 1,
  mac: '9c7514028f24',
  model: 'WP600ACG',
  description: 'Reception',
  firmware: '2.8.93',
  user: '201',
  address: '10.0.0.20',
  token: 'device-secret',
  multipleUsers: [],
  isOnline: true,
};
const BASE = {
  id: 2,
  mac: '9c7514330001',
  model: 'W-AIR Base',
  description: '',
  firmware: '1.0',
  user: '',
  address: '10.0.0.21',
  token: '',
  multipleUsers: ['301', '302'],
  isOnline: false,
};

test('a MAC with or without separators; anything else refused', () => {
  assert.equal(normalizeMac('9C:75:14:02:8F:24'), '9c7514028f24');
  assert.equal(normalizeMac('9c-75-14-02-8f-24'), '9c7514028f24');
  for (const bad of ['9c75140', '9c7514028f2g', '../x', '']) assert.throws(() => normalizeMac(bad), bad);
});

test('list: one line per device, the token never as text, in JSON only with --show-secrets; paging', async () => {
  const pbx = fakePbx({'GET /Devices/': {records: [PHONE, BASE]}});
  const t = await text(pbx, ['device', 'list']);
  assert.equal(
    t.stdout,
    '9c7514028f24  WP600ACG    201      online   10.0.0.20  2.8.93  Reception\n9c7514330001  W-AIR Base  301,302  offline  10.0.0.21  1.0\n',
  );
  assert.ok(!t.stdout.includes('device-secret'));
  const j = JSON.parse((await wx(pbx, ['device', 'list'])).stdout);
  assert.equal(j.records[0].token, undefined);
  assert.equal(j.records[0].tokenSet, true);
  assert.equal(j.records[1].tokenSet, false);
  assert.equal(
    JSON.parse((await wx(pbx, ['device', 'list', '--show-secrets'])).stdout).records[0].token,
    'device-secret',
  );
  await wx(pbx, ['device', 'list', '--count', '10', '--start', '20']);
  assert.equal(pbx.calls.at(-1).search, '?count=10&start=20');
  assert.equal((await wx(pbx, ['device', 'list', '--count', 'x'])).code, 64);
});

test('add: MACs normalized into {macs}', async () => {
  const pbx = fakePbx({
    'POST /Devices/': (b) => ({
      records: b.macs.map((mac) => ({mac, value: {mac, model: 'WP490', vendor: 'Wildix', url: ''}})),
    }),
  });
  const r = await text(pbx, ['device', 'add', '9C:75:14:02:8F:24', '9c7514028f25']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.calls[0].body, {macs: ['9c7514028f24', '9c7514028f25']});
  assert.equal(r.stdout, 'Added:\n  9c7514028f24  Wildix  WP490\n  9c7514028f25  Wildix  WP490\n');
  assert.equal((await wx(pbx, ['device', 'add', 'nope'])).code, 64);
});

test('update: only what is given, nested settings, --from merged under the options, never a token', async () => {
  const pbx = fakePbx({'PUT /Devices/9c7514028f24/': 'Success'});
  assert.equal((await wx(pbx, ['device', 'update', '9c7514028f24'])).code, 64);
  assert.equal((await wx(pbx, ['device', 'update', '9c7514028f24', '--user', '2 01'])).code, 64);
  let r = await text(pbx, [
    'device',
    'update',
    '9C:75:14:02:8F:24',
    '--description',
    'Hall',
    '--user',
    '202',
    '--dns',
    '1.1.1.1,8.8.8.8',
    '--ntp',
    'pool.ntp.org',
    '--timezone',
    'Europe/Rome',
    '--syslog',
    '10.0.0.9',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.calls[0].path, '/Devices/9c7514028f24/');
  assert.deepEqual(pbx.calls[0].body, {
    description: 'Hall',
    user: '202',
    settings: {
      dns: {primary: '1.1.1.1', secondary: '8.8.8.8'},
      ntp: {server: 'pool.ntp.org', timezone: 'Europe/Rome'},
      syslogServer: '10.0.0.9',
    },
  });
  assert.equal(r.stdout, 'Updated the device 9c7514028f24: description, user, settings\n');
  r = await wx(pbx, ['device', 'update', '9c7514028f24', '--from', '-', '--users', '301,302'], {
    stdin: JSON.stringify({token: 'x', settings: {useDst: true, dns: {secondary: '9.9.9.9'}}}),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.calls[1].body, {
    settings: {useDst: true, dns: {secondary: '9.9.9.9'}},
    multipleUsers: ['301', '302'],
  });
});

test('delete, disconnect and reset-token need --yes', async () => {
  const pbx = fakePbx({
    'DELETE /Devices/9c7514028f24/': 'Success',
    'DELETE /Devices/9c7514028f24/connect/': 'Success',
    'POST /Device/ResetToken/': 'Success',
  });
  assert.equal((await wx(pbx, ['device', 'delete', '9c7514028f24'])).code, 64);
  assert.equal((await wx(pbx, ['device', 'disconnect', '9c7514028f24'])).code, 64);
  assert.equal((await wx(pbx, ['device', 'reset-token', '123456'])).code, 64);
  assert.equal((await wx(pbx, ['device', 'reset-token', 'abc', '--yes'])).code, 64);
  assert.equal(pbx.calls.length, 0);
  assert.equal(
    (await text(pbx, ['device', 'delete', '9C:75:14:02:8F:24', '--yes'])).stdout,
    'Deleted the device 9c7514028f24\n',
  );
  assert.equal(
    (await text(pbx, ['device', 'disconnect', '9c7514028f24', '--yes'])).stdout,
    'Closed the remote access to 9c7514028f24\n',
  );
  assert.equal(
    (await text(pbx, ['device', 'reset-token', '123456', '--yes'])).stdout,
    'The token of the device was reset: provision it again\n',
  );
  assert.deepEqual(
    pbx.calls.map((c) => [c.method, c.path, c.body]),
    [
      ['DELETE', '/Devices/9c7514028f24/', undefined],
      ['DELETE', '/Devices/9c7514028f24/connect/', undefined],
      ['POST', '/Device/ResetToken/', {pin: '123456'}],
    ],
  );
});

test('scan, verify (address and port in the query), connect', async () => {
  const pbx = fakePbx({
    'POST /Devices/scan/': {records: [{address: '10.0.0.20', port: '80'}]},
    'GET /Devices/verify/': {allow: true, mac: '9c7514028f24', model: 'WP600ACG', address: '10.0.0.20', port: 80},
    'POST /Devices/9c7514028f24/connect/': {
      dump: '1',
      host: '10.0.0.20',
      name: 'x',
      opt: 'https://demo.wildixin.com/dev/9c7514028f24',
      port: '443',
      ssl: true,
    },
  });
  assert.equal((await text(pbx, ['device', 'scan', '10.0.0.1-254'])).stdout, '10.0.0.20:80\n');
  assert.deepEqual(pbx.calls[0].body, {range: '10.0.0.1-254'});
  assert.equal((await wx(pbx, ['device', 'scan', '10.0.0.1; rm'])).code, 64);
  assert.equal(
    (await text(pbx, ['device', 'verify', '10.0.0.20'])).stdout,
    '10.0.0.20:80  9c7514028f24  WP600ACG  can be provisioned\n',
  );
  assert.equal(pbx.calls.at(-1).search, '?address=10.0.0.20&port=80');
  await wx(pbx, ['device', 'verify', '10.0.0.20', '--port', '8080']);
  assert.equal(pbx.calls.at(-1).search, '?address=10.0.0.20&port=8080');
  assert.equal((await wx(pbx, ['device', 'verify', '10.0.0.20', '--port', '0'])).code, 64);
  const c = await text(pbx, ['device', 'connect', '9c7514028f24']);
  assert.equal(
    c.stdout,
    'Connected to 9c7514028f24 (10.0.0.20:443, TLS): https://demo.wildixin.com/dev/9c7514028f24 — close it with wx-admin device disconnect 9c7514028f24 --yes\n',
  );
});

test('a 403 names the scope devices', async () => {
  const fetch = async () => new Response(JSON.stringify({type: 'error', reason: 'Forbidden'}), {status: 403});
  const r = await run(['device', 'delete', '9c7514028f24', '--yes', '--pbx', 'demo'], {
    env: env(),
    fetch,
    registry: {groups},
  });
  assert.match(r.stderr, /devices:\*/);
});
