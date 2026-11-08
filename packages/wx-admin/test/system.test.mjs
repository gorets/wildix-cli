import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups} from '../src/commands/system.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

// A PBX that answers "METHOD /path" from a table (a value, or a function of the body and the call number), wrapped
// as the PBX does; anything else is 404. Every request is recorded.
function fakePbx(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = `${init.method} ${u.pathname.replace(/^\/api\/v1/, '')}`;
    calls.push({method: init.method, path: u.pathname, search: u.search, body, headers: init.headers});
    if (!(key in routes)) return new Response(JSON.stringify({type: 'error', reason: '404 Not Found'}), {status: 404});
    const r = routes[key];
    const result =
      typeof r === 'function'
        ? r(body, calls.filter((c) => `${c.method} ${c.path.replace(/^\/api\/v1/, '')}` === key).length)
        : r;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({type: 'result', result}), {status: 200});
  };
  return {fetch, calls, writes: () => calls.filter((c) => c.method !== 'GET')};
}

const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry: {groups}, ...options});
const text = (pbx, argv, options = {}) => wx(pbx, [...argv, '--no-color'], {output: 'text', ...options});

const LICENSE = {
  limitations: {
    phones: '24',
    trunks: 16,
    calls: '184',
    rooms: '0',
    licenseTypes: {basic: 0, business: 12, premium: 11},
    faxes: {state: true, until: '1797206400'},
    hotel: {state: false, until: '*'},
    serial: 'SER1',
  },
  licenseUsage: {basic: 0, business: 3, premium: 4, essential: 1},
  activated: true,
  domain: 'demo.wildixin.com',
};
const SMTP = {
  account: 'default',
  auth: 'login',
  domain: 'localhost',
  from: 'pbx@example.com',
  host: 'smtp.example.com',
  port: 587,
  user: 'pbx',
  password: 'smtp-secret',
  timeout: 15,
  tls: false,
  tlsStartTls: true,
  isDefaultSettings: false,
};
const PROXY = {
  enable: true,
  host: 'proxy.example.com',
  port: '3128',
  auth_method: 'basic',
  login: 'p',
  password: 'proxy-secret',
};

test('info: version, ping and the license summary; text in two lines', async () => {
  const pbx = fakePbx({'GET /PBX/version/': '7.11.1', 'GET /PBX/ping/': 'Pong', 'GET /PBX/settings/license/': LICENSE});
  const r = JSON.parse((await wx(pbx, ['system', 'info'])).stdout);
  assert.equal(r.version, '7.11.1');
  assert.equal(r.ping, 'Pong');
  assert.deepEqual(r.license.licenses, [
    {type: 'business', used: 3, total: 12},
    {type: 'premium', used: 4, total: 11},
    {type: 'essential', used: 1, total: 0},
  ]);
  assert.deepEqual(
    pbx.calls.map((c) => c.path),
    ['/api/v1/PBX/version/', '/api/v1/PBX/ping/', '/api/v1/PBX/settings/license/'],
  );
  const t = await text(pbx, ['system', 'info']);
  assert.match(
    t.stdout,
    /^demo\.wildixin\.com {2}WMS 7\.11\.1 {2}ping Pong \(\d+ ms\)\nlicense activated · business 3\/12 · premium 4\/11 · essential 1\/0\n$/,
  );
});

test('info: a license the access may not read is a note, not a failure', async () => {
  const pbx = fakePbx({
    'GET /PBX/version/': '7.11.1',
    'GET /PBX/ping/': 'Pong',
    'GET /PBX/settings/license/': new Response(JSON.stringify({type: 'error', reason: 'Forbidden'}), {status: 403}),
  });
  const t = await text(pbx, ['system', 'info']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /license: not readable \(HTTP 403/);
});

test('license as text: limits, types, options with their end', async () => {
  const pbx = fakePbx({'GET /PBX/settings/license/': LICENSE});
  const t = (await text(pbx, ['system', 'license'])).stdout;
  assert.match(t, /^demo\.wildixin\.com · activated · serial SER1$/m);
  assert.match(t, /^limits: 24 phones · 16 trunks · 184 calls · 0 rooms$/m);
  assert.match(t, /^business +3 +12$/m);
  assert.match(t, /^ {2}faxes +on +until 2026-12-1\d$/m);
  assert.match(t, /^ {2}hotel +off$/m);
});

test('settings as text, and settings-set: one feature, --yes, --enable or --disable', async () => {
  const pbx = fakePbx({
    'GET /PBX/settings/': {
      pbxName: 'Wildix PBX',
      host: 'demo.wildixin.com',
      version: '7.11',
      isCloud: true,
      defaultLanguage: 'en',
      license: {activated: true},
      features: [{name: 'mfa', label: 'MFA', enabled: false, available: true}],
    },
    'PUT /PBX/settings/': 'Success',
  });
  const t = (await text(pbx, ['system', 'settings'])).stdout;
  assert.match(t, /^Wildix PBX \(demo\.wildixin\.com\) · WMS 7\.11 · cloud · language en$/m);
  assert.match(t, /^ {2}mfa {2}off {2}MFA$/m);
  assert.equal((await wx(pbx, ['system', 'settings-set', '--feature', 'mfa', '--enable'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'settings-set', '--feature', 'nope', '--enable', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'settings-set', '--feature', 'mfa', '--yes'])).code, 64);
  assert.equal(pbx.writes().length, 0);
  const r = await text(pbx, ['system', 'settings-set', '--feature', 'mfa', '--enable', '--yes']);
  assert.equal(r.stdout, 'mfa turned on\n');
  assert.deepEqual(pbx.writes()[0].body, {features: [{name: 'mfa', enabled: true}]});
});

test('smtp: the password never as text, in JSON only with --show-secrets', async () => {
  const pbx = fakePbx({'GET /PBX/settings/smtp/': SMTP});
  const t = await text(pbx, ['system', 'smtp']);
  assert.ok(!t.stdout.includes('smtp-secret'));
  assert.match(t.stdout, /^server {4}smtp\.example\.com:587 STARTTLS$/m);
  assert.match(t.stdout, /^auth {6}login as pbx \(password set\)$/m);
  const j = JSON.parse((await wx(pbx, ['system', 'smtp'])).stdout);
  assert.equal(j.password, undefined);
  assert.equal(j.passwordSet, true);
  assert.equal(JSON.parse((await wx(pbx, ['system', 'smtp', '--show-secrets'])).stdout).password, 'smtp-secret');
  assert.ok(!(await text(pbx, ['system', 'smtp', '--show-secrets'])).stdout.includes('smtp-secret'));
});

test('smtp-set: --yes, merged with the current settings (password kept), new password from stdin, never echoed', async () => {
  const pbx = fakePbx({'GET /PBX/settings/smtp/': SMTP, 'PUT /PBX/settings/smtp/': (body) => body});
  assert.equal((await wx(pbx, ['system', 'smtp-set', '--host', 'mail.example.com'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'smtp-set', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'smtp-set', '--timeout', '7', '--yes'])).code, 64);
  assert.equal(pbx.writes().length, 0);
  // a new host needs its own password: the current one is never sent to another host
  assert.equal((await wx(pbx, ['system', 'smtp-set', '--host', 'mail.example.com', '--yes'])).code, 64);
  assert.equal(pbx.writes().length, 0);
  let r = await wx(
    pbx,
    [
      'system',
      'smtp-set',
      '--host',
      'mail.example.com',
      '--password',
      '--port',
      '465',
      '--tls',
      'on',
      '--starttls',
      'off',
      '--timeout',
      '20',
      '--yes',
    ],
    {stdin: 'pw-for-new-host\n'},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.writes()[0].body, {
    ...SMTP,
    host: 'mail.example.com',
    port: 465,
    tls: true,
    tlsStartTls: false,
    timeout: 20,
    password: 'pw-for-new-host',
  });
  assert.equal(JSON.parse(r.stdout).password, undefined);
  r = await wx(pbx, ['system', 'smtp-set', '--password', '--yes'], {stdin: 'new-secret\n'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.writes()[1].body.password, 'new-secret');
  assert.ok(!r.stdout.includes('new-secret') && !r.stderr.includes('new-secret'));
});

test('smtp-test: posts the test, reads its status until it is no longer queued', async () => {
  const pbx = fakePbx({
    'GET /PBX/settings/smtp/': SMTP,
    'POST /PBX/settings/smtp/test/': {queued: true, testId: 'default'},
    'GET /PBX/settings/smtp/test/status/default/': (body, n) => ({
      queued: n < 2,
      testId: 'default',
      content: n < 2 ? '' : '250 OK\nsent',
    }),
  });
  assert.equal((await wx(pbx, ['system', 'smtp-test'])).code, 64);
  const r = await text(pbx, ['system', 'smtp-test', '--to', 'me@example.com', '--wait', '0.3']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.writes()[0].body, {
    mailto: 'me@example.com',
    from: 'pbx@example.com',
    body: 'Test e-mail from the PBX demo.wildixin.com (wx-admin)',
  });
  assert.equal(r.stdout, 'Test e-mail to me@example.com from pbx@example.com: done\n  250 OK\n  sent\n');
  const quick = fakePbx({
    'POST /PBX/settings/smtp/test/': {queued: true, testId: 'default'},
    'GET /PBX/settings/smtp/test/status/default/': {queued: true},
  });
  const q = JSON.parse(
    (await wx(quick, ['system', 'smtp-test', '--to', 'me@example.com', '--from', 'a@example.com', '--wait', '0']))
      .stdout,
  );
  assert.equal(q.finished, false);
  assert.ok(!quick.calls.some((c) => c.path.endsWith('/smtp/')), 'no read of the settings when --from is given');
});

test('ntp and ntp-set (merged, --yes)', async () => {
  const pbx = fakePbx({
    'GET /PBX/settings/ntp/': {pntp: 'a.example.com', sntp: 'b.example.com', time: '07/11/2026 13:41:15'},
    'PUT /PBX/settings/ntp/': 'Success',
  });
  assert.equal(
    (await text(pbx, ['system', 'ntp'])).stdout,
    'primary    a.example.com\nsecondary  b.example.com\nPBX time   07/11/2026 13:41:15\n',
  );
  assert.equal((await wx(pbx, ['system', 'ntp-set', '--primary', 'time.example.com'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'ntp-set', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'ntp-set', '--primary', 'bad host', '--yes'])).code, 64);
  const r = await text(pbx, ['system', 'ntp-set', '--primary', 'time.example.com', '--yes']);
  assert.equal(r.stdout, 'NTP servers: time.example.com, b.example.com\n');
  assert.deepEqual(pbx.writes()[0].body, {pntp: 'time.example.com', sntp: 'b.example.com'});
});

test('proxy and proxy-set: password hidden, kept unless --password', async () => {
  const pbx = fakePbx({'GET /PBX/settings/httpProxy/': PROXY, 'PUT /PBX/settings/httpProxy/': (body) => body});
  const t = await text(pbx, ['system', 'proxy']);
  assert.equal(t.stdout, 'HTTP proxy on · proxy.example.com:3128 · auth basic as p (password set)\n');
  assert.equal(JSON.parse((await wx(pbx, ['system', 'proxy'])).stdout).password, undefined);
  assert.equal((await wx(pbx, ['system', 'proxy-set', '--disable'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'proxy-set', '--enable', '--disable', '--yes'])).code, 64);
  const r = await wx(pbx, ['system', 'proxy-set', '--disable', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(pbx.writes()[0].body, {...PROXY, enable: false});
  assert.ok(!r.stdout.includes('proxy-secret'));
  const empty = fakePbx({
    'GET /PBX/settings/httpProxy/': {enable: false, host: '', port: '', auth_method: 'none', login: '', password: ''},
  });
  assert.equal((await wx(empty, ['system', 'proxy-set', '--enable', '--yes'])).code, 64);
});

test('trusted-ip (the path that works: /PBX/settings/trusted-ips/) and trusted-ip-set', async () => {
  const pbx = fakePbx({
    'GET /PBX/settings/trusted-ips/': {rows: ['10.0.0.1']},
    'PUT /PBX/settings/trusted-ips/': (body) => body,
  });
  assert.equal((await text(pbx, ['system', 'trusted-ip'])).stdout, '10.0.0.1\n');
  assert.equal((await wx(pbx, ['system', 'trusted-ip-set', '--add', '10.0.0.2'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'trusted-ip-set', '--add', 'not-an-ip', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'trusted-ip-set', '--remove', '10.9.9.9', '--yes'])).code, 64);
  assert.equal(pbx.writes().length, 0);
  const r = await text(pbx, ['system', 'trusted-ip-set', '--add', '192.168.0.0/24', '--add', '10.0.0.1', '--yes']);
  assert.equal(r.stdout, 'Trusted IPs:\n  10.0.0.1\n  192.168.0.0/24\n');
  assert.deepEqual(pbx.writes()[0].body, {rows: ['10.0.0.1', '192.168.0.0/24']});
  await wx(pbx, ['system', 'trusted-ip-set', '--remove', '10.0.0.1', '--yes']);
  assert.deepEqual(pbx.writes()[1].body, {rows: []});
  await wx(pbx, ['system', 'trusted-ip-set', '--clear', '--add', '1.2.3.4', '--yes']);
  assert.deepEqual(pbx.writes()[2].body, {rows: ['1.2.3.4']});
});

test('ports as a table', async () => {
  const pbx = fakePbx({
    'GET /PBX/Ports/Status/': {
      total: 2,
      records: [
        {transport: 'TCP', protocol: 'HTTP', port: '443', lastcheck: '2026-11-07 13:41:07', status: '1'},
        {transport: 'UDP', protocol: 'SIP', port: '5060', lastcheck: '2026-11-07 13:41:07', status: '0'},
      ],
    },
  });
  assert.equal(
    (await text(pbx, ['system', 'ports'])).stdout,
    'HTTP  TCP  443   open    checked 2026-11-07 13:41:07\nSIP   UDP  5060  closed  checked 2026-11-07 13:41:07\n',
  );
});

test('upgrade status (HTML of the log dropped), upgrade-settings', async () => {
  const pbx = fakePbx({
    'GET /PBX/Upgrade/': {
      isRunning: true,
      completed: false,
      progress: 40,
      log: ['Checking <b>repositories list</b>... Ok.', ''],
    },
    'GET /PBX/Upgrade/Settings/': {
      wmsrelease: {repository: 'rel70', enabled: true, email: '', howly: 'daily'},
      customFirmwareServer: {enabled: false, url: '', checkTls: false},
    },
  });
  assert.equal(
    (await text(pbx, ['system', 'upgrade'])).stdout,
    'upgrade running, 40%\n  Checking repositories list... Ok.\n',
  );
  assert.equal(
    (await text(pbx, ['system', 'upgrade-settings'])).stdout,
    'repository rel70 · automatic upgrade on, daily\ncustom firmware server off\n',
  );
});

test('upgrade-check: starts the check and reads until it is done; --status only reads', async () => {
  const pbx = fakePbx({
    'POST /PBX/Upgrade/Check/': {status: true, pid: [1]},
    'GET /PBX/Upgrade/Check/': (body, n) => ({
      repository: 'rel70',
      newVersion: n < 2 ? '' : '7.12.1',
      newPackages: n >= 2,
      check: {isRunning: n < 2, withoutError: true, fileSystemStatus: true, log: ['<b>ok</b>']},
      upgrade: {isRunning: false},
    }),
  });
  const r = await text(pbx, ['system', 'upgrade-check', '--wait', '0.3']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'repository rel70 · new version 7.12.1\ncheck without errors · file system ok\n  ok\n');
  assert.deepEqual(
    pbx.calls.map((c) => c.method),
    ['POST', 'GET', 'GET'],
  );
  const s = await wx(pbx, ['system', 'upgrade-check', '--status']);
  assert.equal(JSON.parse(s.stdout).newVersion, '7.12.1');
  assert.equal(pbx.calls.at(-1).method, 'GET');
  assert.equal(pbx.writes().length, 1);
});

test('upgrade-start and reboot need --yes', async () => {
  const pbx = fakePbx({'POST /PBX/Upgrade/': {status: true}, 'PUT /PBX/System/Reboot/': 'Done'});
  assert.equal((await wx(pbx, ['system', 'upgrade-start'])).code, 64);
  assert.equal((await wx(pbx, ['system', 'reboot'])).code, 64);
  assert.equal(pbx.calls.length, 0);
  assert.equal(
    (await text(pbx, ['system', 'upgrade-start', '--yes'])).stdout,
    'Upgrade started: follow it with wx-admin system upgrade\n',
  );
  assert.equal((await text(pbx, ['system', 'reboot', '--yes'])).stdout, 'The PBX is rebooting\n');
  assert.deepEqual(
    pbx.calls.map((c) => `${c.method} ${c.path}`),
    ['POST /api/v1/PBX/Upgrade/', 'PUT /api/v1/PBX/System/Reboot/'],
  );
});

test('a 403 names the scope of the command', async () => {
  const pbx = fakePbx({
    'PUT /PBX/System/Reboot/': new Response(JSON.stringify({type: 'error', reason: 'Forbidden'}), {status: 403}),
  });
  const r = await wx(pbx, ['system', 'reboot', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /pbxpower:\*/);
});

const NET = (over = {}) => ({
  ip: '10.0.0.1',
  serial: 'SERA',
  host: 'demo.wildixin.com',
  isServer: true,
  port: 443,
  failOver: '',
  version: '7.11.1',
  isUpdateNeeded: false,
  dn: 'pbxid=SERA,dc=wildix',
  ...over,
});
const NETWORK = {
  records: [
    NET(),
    NET({ip: '10.0.0.2', serial: 'SERB', host: 'b.wildixin.com', isServer: false, failOver: 'demo.wildixin.com'}),
    NET({
      ip: '10.0.0.3',
      serial: 'SERC',
      host: 'c.wildixin.com',
      isServer: false,
      version: '7.10.0',
      isUpdateNeeded: true,
    }),
  ],
};

test('network: reads GET /Network/Pbxes', async () => {
  const pbx = fakePbx({'GET /Network/Pbxes': NETWORK});
  const r = await wx(pbx, ['system', 'network']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    pbx.calls.map((c) => [c.method, c.path, c.body]),
    [['GET', '/api/v1/Network/Pbxes', undefined]],
  );
});

test('network as text: a server, a member with failover, one needing an update; the current PBX marked', async () => {
  const pbx = fakePbx({'GET /Network/Pbxes': NETWORK});
  const t = await text(pbx, ['system', 'network']);
  assert.equal(t.code, 0, t.stderr);
  const lines = t.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^ {2}host +serial +version +role +failover +update needed$/);
  assert.match(lines[1], /^\* demo\.wildixin\.com +SERA +7\.11\.1 +server *$/);
  assert.match(lines[2], /^ {2}b\.wildixin\.com +SERB +7\.11\.1 +member +demo\.wildixin\.com *$/);
  assert.match(lines[3], /^ {2}c\.wildixin\.com +SERC +7\.10\.0 +member +yes$/);
  assert.doesNotMatch(t.stdout, /not in a WMS network/);
  assert.doesNotMatch(t.stdout, /10\.0\.0\./);
});

test('network as text: one PBX is not in a WMS network with others', async () => {
  const pbx = fakePbx({'GET /Network/Pbxes': {records: [NET()]}});
  const t = await text(pbx, ['system', 'network']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^\* demo\.wildixin\.com +SERA +7\.11\.1 +server/m);
  assert.match(t.stdout, /^This PBX is not in a WMS network with other PBXs\.$/m);
});

test('network as JSON: the records as they come, with ip and dn', async () => {
  const pbx = fakePbx({'GET /Network/Pbxes': NETWORK});
  const r = await wx(pbx, ['system', 'network', '--output', 'json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), NETWORK);
});

test('network: a 403 says the WMS network is not available, with the scope it needs, exit 2', async () => {
  const pbx = fakePbx({
    'GET /Network/Pbxes': new Response(JSON.stringify({type: 'error', reason: 'nope'}), {status: 403}),
  });
  const r = await text(pbx, ['system', 'network']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /the WMS network is not available with this access \(403\)/);
  assert.match(r.stderr, /the scope pbx:read/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('network: a 404 says the WMS network is not available, exit 1', async () => {
  const pbx = fakePbx({
    'GET /Network/Pbxes': new Response(JSON.stringify({type: 'error', reason: 'nope'}), {status: 404}),
  });
  const r = await text(pbx, ['system', 'network']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the WMS network is not available with this access \(404\)/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('network: a 401 stays an access error, exit 2', async () => {
  const pbx = fakePbx({
    'GET /Network/Pbxes': new Response(JSON.stringify({type: 'error', reason: 'Unauthorized'}), {status: 401}),
  });
  assert.equal((await text(pbx, ['system', 'network'])).code, 2);
});
