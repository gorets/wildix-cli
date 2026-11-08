import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {MASK} from '../src/cloud/mask.mjs';
import {envOfTest, fakeCloud} from './fake-cloud.mjs';
import {run} from './helpers.mjs';

const SECRET = 'Sign1ngSecretSign1ngSecret1234';
const state = () => ({
  license: 'X_BEES',
  allowed: ['webhook', 'iframe_integration', 'hubspot_backend', 'salesforce_omni'],
  installed: [
    {
      integrationId: 'wh0001',
      service: 'webhook',
      status: 'enabled',
      data: {
        type: 'webhook',
        url: 'https://hook.example/in?x=1',
        key: '',
        secret: SECRET,
        events: [{value: 'call:completed'}, {value: 'chat:live:missed'}],
        createdBy: 'ann@example.com',
      },
    },
    {
      integrationId: 'hs0001',
      service: 'hubspot_backend',
      data: {
        providerConfigKey: 'hubspot_backend',
        connectionId: 'nango-conn-1',
        hub_domain: 'acme.com',
        user: 'bob@example.com',
        settings: {calls: {isLogCalls: true, minCallLogTime: 5}},
      },
    },
    {
      integrationId: 'om0001',
      service: 'salesforce_omni',
      data: {webhookId: 'wh0002', name: 'Carl', organizationId: 'org9'},
    },
    {
      integrationId: 'wh0002',
      service: 'webhook',
      data: {type: 'webhook', url: 'https://byoc.example/x', key: '', secret: 's2', events: []},
    },
    {
      integrationId: 'ap0001',
      service: 'iframe_integration',
      data: {
        title: 'Orders',
        iframeUrl: 'https://orders.example/app',
        description: 'd',
        templateId: '',
        position: 2,
        accessEmails: ['a@example.com'],
        deniedEmails: [],
        timestamp: 1,
        tabs: {info: {enabled: true, usePbxToken: false, platforms: 'all'}, tab: {enabled: false, icon: 'chart-crm'}},
        usePbxToken: false,
      },
    },
    {
      integrationId: 'ap0002',
      service: 'iframe_integration',
      data: {title: 'Orders', iframeUrl: 'https://o2.example', position: 1},
    },
  ],
  logs: Array.from({length: 45}, (_, n) => ({
    integrationId: 'hs0001',
    eventType: n ? 'wda_sync_requested' : 'warning',
    createdAt: `2026-11-0${1 + (n % 7)}T10:00:00Z`,
    email: 'ann@example.com',
  })),
  hub: {
    company: {
      companyId: 'it_x',
      customerId: 'cust-1',
      active: true,
      isTrial: false,
      sendCallSummary: false,
      postalCode: '75001',
      city: 'Paris',
      countryCode: 'FR',
      timezone: 'Europe/Paris',
    },
    users: [
      {
        extension: '101',
        firstName: 'Ann',
        lastName: 'A',
        email: 'ann@example.com',
        pbxSerial: 'S1',
        active: true,
        isAdmin: false,
      },
      {
        extension: '102',
        firstName: 'Bob',
        lastName: 'B',
        email: 'bob@example.com',
        pbxSerial: 'S1',
        active: false,
        isAdmin: true,
      },
    ],
  },
});

// The WIM integrations service: the console API (answers wrapped in {success, result}), traces, the hub.
function fakeIntegrations(s) {
  return (method, u, {body}) => {
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);
    const ok = (result) => ({body: {success: true, result}});
    if (p === '/console/integrations' && method === 'GET')
      return ok({
        installed: s.installed,
        allowed: s.allowed,
        license: s.license,
        webhook: {events: []},
        featureRequests: {},
      });
    if (p === '/console/integrations' && method === 'POST') {
      if (body.service === 'iframe_integration' && body.data.currentIntegrationId) return ok({swapped: true});
      if (body.service === 'iframe_integration' && !body.data.isNew)
        return ok({...s.installed.find((i) => i.integrationId === body.data.integrationId), data: body.data});
      const made = {integrationId: `new00${s.installed.length}`, service: body.service, data: body.data};
      s.installed.push(made);
      return ok(made);
    }
    if (p === '/console/integrations' && method === 'PATCH') {
      const i = s.installed.find((x) => x.integrationId === body.integrationId);
      return ok({...i, ...(body.status ? {status: body.status} : {}), data: {...i.data, ...body.data}});
    }
    if (p === '/console/integrations' && method === 'DELETE') {
      s.installed = s.installed.filter((i) => i.integrationId !== q.integrationId);
      return {body: {success: true}};
    }
    if (p === '/console/integration-logs') {
      const off = Number(q.offset);
      return ok({logs: s.logs.filter((l) => l.integrationId === q.integrationId).slice(off, off + 30)});
    }
    if (p === '/v2/traces/completed')
      return {
        body: {
          count: 1,
          traces: [{id: 'tr1', status: 'complete', start: 1794119283270, duration: 948, params: {name: 'logged'}}],
        },
      };
    if (p === '/v2/traces/tr1')
      return {
        body: {
          trace: {
            id: 'tr1',
            status: 'complete',
            start: 1794119283270,
            segments: [
              {id: 's1', name: 'root', status: 'complete', input: {json: {phone: '+3912345'}}, result: {text: 'ok'}},
              {id: 's2', parentId: 's1', name: 'child', status: 'complete', duration: 3},
            ],
          },
        },
      };
    if (p === '/v2/traces/hs0001/stats')
      return {body: {statistics: [{date: '2026-11-08T00:00:00.000Z', complete: 3, error: 1}]}};
    if (p === '/v2/integrations-hub/manage/company') {
      if (method === 'GET')
        return s.hub.company ? {body: s.hub.company} : {status: 404, body: {message: 'Company not found'}};
      if (method === 'DELETE') return {body: {message: 'deleted'}};
      return {body: {...s.hub.company, ...body}};
    }
    if (p === '/v2/integrations-hub/manage/users' && method === 'GET') {
      const page = q.start === 'p2' ? s.hub.users.slice(1) : s.hub.users.slice(0, 1);
      return {body: {users: page, nextPage: q.start === 'p2' ? undefined : 'p2'}};
    }
    if (p === '/v2/integrations-hub/manage/users' && method === 'POST')
      return {body: {...body, redCactusUserId: 'rc-1'}};
    const m = p.match(/^\/v2\/integrations-hub\/manage\/users\/(\d+)$/);
    if (m) {
      const user = s.hub.users.find((x) => x.extension === m[1]);
      if (!user) return {status: 404, body: {message: 'User not found'}};
      if (method === 'GET') return {body: user};
      if (method === 'PUT') return {body: {...user, ...body}};
      if (method === 'DELETE') return {body: {message: 'deleted'}};
    }
    return {status: 404, body: {message: `no route ${method} ${p}`}};
  };
}

const setup = (s = state()) => {
  const f = fakeCloud(fakeIntegrations(s));
  const wx = (argv, opts = {}) => run(argv, {env: envOfTest(), fetch: f.fetch, ...opts});
  const writes = () => f.cloudCalls().filter((c) => c.method !== 'GET');
  return {f, s, wx, writes};
};
const json = (r) => {
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('list: on the WIM host with the CPA token; secrets masked, people only with --full', async () => {
  const {wx, f} = setup();
  const r = json(await wx(['integration', 'list']));
  assert.equal(f.cloudCalls()[0].url, 'https://wim-stage.wildix.com/console/integrations');
  const wh = r.integrations.find((i) => i.integrationId === 'wh0001');
  assert.equal(wh.data.secret, MASK);
  assert.equal(wh.data.key, '');
  assert.equal(wh.data.createdBy, undefined);
  const hs = r.integrations.find((i) => i.integrationId === 'hs0001');
  assert.equal(hs.data.connectionId, MASK);
  assert.equal(hs.data.user, undefined);
  assert.equal(r.integrations.find((i) => i.integrationId === 'om0001').data.name, undefined);
  assert.equal(r.license, 'X_BEES');
  assert.ok(!JSON.stringify(r).includes(SECRET));

  const full = json(await wx(['integration', 'list', '--full', '--show-secrets', '--service', 'webhook']));
  assert.equal(full.integrations.length, 2);
  assert.equal(full.integrations[0].data.secret, SECRET);
  assert.equal(full.integrations[0].data.createdBy, 'ann@example.com');
});

test('list text: one line each, no secret; an unknown service is refused', async () => {
  const {wx} = setup();
  const r = await wx(['integration', 'list'], {output: 'text'});
  assert.match(r.stdout, /^wh0001 {2}webhook · enabled · webhook https:\/\/hook\.example\/in$/m);
  assert.match(r.stdout, /^hs0001 {2}hubspot_backend · enabled · acme\.com$/m);
  assert.ok(!r.stdout.includes(SECRET));
  assert.equal((await wx(['integration', 'list', '--service', 'nope'])).code, 64);
});

test('get by id or by label; a label several share asks for the id', async () => {
  const {wx} = setup();
  assert.equal(json(await wx(['integration', 'get', 'acme.com'])).integrationId, 'hs0001');
  const r = await wx(['integration', 'get', 'Orders']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /ids ap0001, ap0002/);
  const t = await wx(['integration', 'get', 'wh0001'], {output: 'text'});
  assert.match(t.stdout, /"secret": "\*{8}"/);
});

test('logs: one page of 30, --all follows the offset, e-mails only with --full', async () => {
  const {wx, f} = setup();
  const one = json(await wx(['integration', 'logs', 'hs0001']));
  assert.equal(one.logs.length, 30);
  assert.equal(one.logs[0].email, undefined);
  const all = json(await wx(['integration', 'logs', 'hs0001', '--all', '--full']));
  assert.equal(all.logs.length, 45);
  assert.equal(all.logs[0].email, 'ann@example.com');
  const offsets = f
    .cloudCalls()
    .filter((c) => c.path === '/console/integration-logs')
    .map((c) => c.query.offset);
  assert.deepEqual(offsets, ['0', '0', '30']);
});

test('enable, disable (--yes), delete (--yes, --force for Omni only)', async () => {
  const {wx, writes} = setup();
  assert.equal(json(await wx(['integration', 'enable', 'hs0001'])).status, 'enabled');
  assert.equal((await wx(['integration', 'disable', 'hs0001'])).code, 64);
  json(await wx(['integration', 'disable', 'hs0001', '--yes']));
  assert.deepEqual(
    writes().map((c) => c.body),
    [
      {integrationId: 'hs0001', status: 'enabled'},
      {integrationId: 'hs0001', status: 'disabled'},
    ],
  );
  assert.equal((await wx(['integration', 'delete', 'hs0001'])).code, 64);
  assert.equal((await wx(['integration', 'delete', 'hs0001', '--yes', '--force'])).code, 64);
  json(await wx(['integration', 'delete', 'om0001', '--yes', '--force']));
  const del = writes().filter((c) => c.method === 'DELETE');
  assert.deepEqual(
    del.map((c) => c.query),
    [{integrationId: 'om0001', force: 'true'}],
  );
});

test('the webhook of Salesforce Omni is not changed, disabled or removed', async () => {
  const {wx, writes} = setup();
  for (const argv of [
    ['integration', 'disable', 'wh0002', '--yes'],
    ['integration', 'delete', 'wh0002', '--yes'],
    ['integration', 'webhook', 'update', 'wh0002', '--url', 'https://x.example'],
  ]) {
    const r = await wx(argv);
    assert.equal(r.code, 64, argv.join(' '));
    assert.match(r.stderr, /webhook of salesforce_omni om0001/);
  }
  assert.equal(writes().length, 0);
});

test('settings: shown; replaced from a file with --yes; a masked file is refused', async () => {
  const {wx, writes} = setup();
  assert.deepEqual(json(await wx(['integration', 'settings', 'hs0001'])), {
    calls: {isLogCalls: true, minCallLogTime: 5},
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-'));
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify({calls: {isLogCalls: false}}));
  assert.equal((await wx(['integration', 'settings', 'hs0001', '--from', file])).code, 64);
  json(await wx(['integration', 'settings', 'hs0001', '--from', file, '--yes']));
  assert.deepEqual(writes()[0].body, {integrationId: 'hs0001', data: {settings: {calls: {isLogCalls: false}}}});
  fs.writeFileSync(file, JSON.stringify({calls: {token: MASK}}));
  const r = await wx(['integration', 'settings', 'hs0001', '--from', file, '--yes']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /masked/);
  assert.equal((await wx(['integration', 'settings', 'ap0002'])).code, 64);
});

test('traces, one trace (payloads only with --full), stats', async () => {
  const {wx, f} = setup();
  const r = json(await wx(['integration', 'traces', 'hs0001', '--status', 'error', '--limit', '5']));
  assert.equal(r.count, 1);
  assert.deepEqual(f.cloudCalls().at(-1).query, {integration: 'hs0001', limit: '5', offset: '0', status: 'error'});
  assert.equal((await wx(['integration', 'traces', 'hs0001', '--limit', '101'])).code, 64);

  const t = json(await wx(['integration', 'trace', 'tr1']));
  assert.equal(t.segments[0].input, undefined);
  assert.equal(t.segments[0].result, undefined);
  assert.equal(json(await wx(['integration', 'trace', 'tr1', '--full'])).segments[0].result.text, 'ok');
  const text = await wx(['integration', 'trace', 'tr1'], {output: 'text'});
  assert.match(text.stdout, /^ {2}root · complete\n {4}child · complete · 3 ms$/m);

  const st = await wx(['integration', 'stats', 'hs0001'], {output: 'text'});
  assert.match(st.stdout, /^2026-11-08 {2}3 complete · 0 with errors · 1 failed$/m);
});

test('webhook create: an HTTP webhook, a fresh secret printed once', async () => {
  const {wx, writes} = setup();
  const r = json(
    await wx([
      'integration',
      'webhook',
      'create',
      '--url',
      'https://in.example/h',
      '--event',
      'call:completed',
      '--event',
      'call:completed',
      '--event',
      'presence:user',
    ]),
  );
  const body = writes()[0].body;
  assert.equal(body.service, 'webhook');
  assert.deepEqual(
    {...body.data, secret: 'x'},
    {
      type: 'webhook',
      url: 'https://in.example/h',
      key: '',
      secret: 'x',
      events: [{value: 'call:completed'}, {value: 'presence:user'}],
    },
  );
  assert.match(body.data.secret, /^[A-Za-z0-9]{30}$/);
  assert.equal(r.secret, body.data.secret);
  assert.equal(r.data.secret, MASK);
  for (const bad of [
    ['--url', 'https://x.example'],
    ['--event', 'call:completed'],
    ['--url', 'ftp://x', '--event', 'call:completed'],
    ['--url', 'https://x.example', '--event', 'call:start'],
  ])
    assert.equal((await wx(['integration', 'webhook', 'create', ...bad])).code, 64, bad.join(' '));
});

test('webhook update: only what changes is sent; events added and removed; rotation needs --yes', async () => {
  const {wx, writes} = setup();
  json(
    await wx([
      'integration',
      'webhook',
      'update',
      'wh0001',
      '--add-event',
      'presence:user',
      '--remove-event',
      'chat:live:missed',
    ]),
  );
  assert.deepEqual(writes()[0].body, {
    integrationId: 'wh0001',
    data: {events: [{value: 'call:completed'}, {value: 'presence:user'}]},
  });
  json(await wx(['integration', 'webhook', 'update', 'wh0001', '--url', 'https://new.example']));
  assert.deepEqual(writes()[1].body, {integrationId: 'wh0001', data: {url: 'https://new.example'}});
  assert.equal((await wx(['integration', 'webhook', 'update', 'wh0001', '--rotate-secret'])).code, 64);
  const rot = json(await wx(['integration', 'webhook', 'update', 'wh0001', '--rotate-secret', '--yes']));
  assert.match(rot.secret, /^[A-Za-z0-9]{30}$/);
  assert.deepEqual(writes()[2].body, {integrationId: 'wh0001', data: {secret: rot.secret}});
  assert.equal(
    (
      await wx([
        'integration',
        'webhook',
        'update',
        'wh0001',
        '--remove-event',
        'call:completed',
        '--remove-event',
        'chat:live:missed',
      ])
    ).code,
    64,
  );
  assert.equal((await wx(['integration', 'webhook', 'update', 'hs0001', '--url', 'https://x.example'])).code, 64);
  assert.equal((await wx(['integration', 'webhook', 'update', 'wh0001'])).code, 64);
  assert.equal(writes().length, 3);
});

test('app create, update (the whole app sent back with the changes), swap', async () => {
  const {wx, writes} = setup();
  json(
    await wx([
      'integration',
      'app',
      'create',
      '--title',
      'CRM',
      '--url',
      'https://crm.example',
      '--view',
      'tab',
      '--pbx-token',
      'on',
    ]),
  );
  const c = writes()[0].body;
  assert.equal(c.service, 'iframe_integration');
  assert.equal(c.data.isNew, true);
  assert.equal(c.data.iframeUrl, 'https://crm.example');
  assert.deepEqual(
    [c.data.tabs.info.enabled, c.data.tabs.tab.enabled, c.data.tabs.info.usePbxToken, c.data.tabs.tab.usePbxToken],
    [false, true, true, true],
  );

  json(await wx(['integration', 'app', 'update', 'ap0001', '--title', 'Orders 2', '--deny', 'z@example.com']));
  const u = writes()[1].body.data;
  assert.equal(u.integrationId, 'ap0001');
  assert.equal(u.isNew, false);
  assert.equal(u.title, 'Orders 2');
  assert.deepEqual(u.accessEmails, ['a@example.com']);
  assert.deepEqual(u.deniedEmails, ['z@example.com']);
  assert.equal(u.iframeUrl, 'https://orders.example/app');
  assert.equal(u.tabs.tab.enabled, false);
  assert.equal(u.timestamp, undefined);
  assert.equal((await wx(['integration', 'app', 'update', 'hs0001', '--title', 'x'])).code, 64);

  json(await wx(['integration', 'app', 'swap', 'ap0001', 'ap0002']));
  assert.deepEqual(writes()[2].body.data, {currentIntegrationId: 'ap0001', targetIntegrationId: 'ap0002'});
  const list = await wx(['integration', 'app', 'list'], {output: 'text'});
  assert.match(list.stdout, /^1\. Orders \(ap0002\)[^\n]*\n2\. Orders \(ap0001\) · info · orders\.example$/m);
});

test('hub company: get, set (merged; putting it in needs the fields and --yes), delete --yes', async () => {
  const {wx, writes, s} = setup();
  assert.equal(json(await wx(['integration', 'hub', 'company'])).customerId, 'cust-1');
  json(await wx(['integration', 'hub', 'company-set', '--call-summary', 'on']));
  assert.deepEqual(writes()[0], {
    ...writes()[0],
    method: 'PUT',
    body: {
      postalCode: '75001',
      city: 'Paris',
      countryCode: 'FR',
      timezone: 'Europe/Paris',
      active: true,
      sendCallSummary: true,
    },
  });
  assert.equal((await wx(['integration', 'hub', 'company-delete'])).code, 64);
  s.hub.company = null;
  const none = await wx(['integration', 'hub', 'company']);
  assert.equal(none.code, 64);
  assert.match(none.stderr, /company-set/);
  assert.equal((await wx(['integration', 'hub', 'company-set', '--city', 'Rome'])).code, 64);
  const set = [
    'integration',
    'hub',
    'company-set',
    '--postal-code',
    '00100',
    '--city',
    'Rome',
    '--country',
    'it',
    '--timezone',
    'Europe/Rome',
  ];
  assert.equal((await wx(set)).code, 64);
  json(await wx([...set, '--yes']));
  const company = writes().find((c) => c.path === '/v2/integrations-hub/manage/company' && c.method === 'POST');
  assert.equal(company.body.countryCode, 'IT');
});

test('hub users: paged list, create with a piped password and --yes, update merged, delete --yes', async () => {
  const {wx, writes} = setup();
  assert.deepEqual(
    json(await wx(['integration', 'hub', 'user-list'])).users.map((u) => u.extension),
    ['101', '102'],
  );
  const create = [
    'integration',
    'hub',
    'user-create',
    '103',
    '--first-name',
    'Cy',
    '--last-name',
    'C',
    '--email',
    'cy@example.com',
    '--pbx-serial',
    'S1',
  ];
  assert.equal((await wx(create)).code, 64);
  const r = json(await wx([...create, '--password', '--welcome', '--yes'], {stdin: 'Long-password1\nrest'}));
  assert.equal(r.redCactusUserId, 'rc-1');
  const post = writes()[0];
  assert.deepEqual(post.query, {sendWelcomeEmail: 'true'});
  assert.deepEqual(post.body, {
    firstName: 'Cy',
    lastName: 'C',
    email: 'cy@example.com',
    extension: '103',
    pbxSerial: 'S1',
    active: true,
    password: 'Long-password1',
  });
  assert.equal((await wx([...create, '--password', '--yes'], {stdin: 'Sh0rt!\n'})).code, 64);
  const weak = await wx([...create, '--password', '--yes'], {stdin: 'longpassword1\n'});
  assert.equal(weak.code, 64);
  assert.match(weak.stderr, /needs an uppercase letter, a symbol/);

  json(await wx(['integration', 'hub', 'user-update', '102', '--active', 'on']));
  const put = writes().at(-1);
  assert.equal(put.path, '/v2/integrations-hub/manage/users/102');
  assert.deepEqual(put.body, {
    firstName: 'Bob',
    lastName: 'B',
    email: 'bob@example.com',
    pbxSerial: 'S1',
    active: true,
    isAdmin: true,
  });

  assert.equal((await wx(['integration', 'hub', 'user-delete', '101'])).code, 64);
  const before = writes().length;
  assert.equal((await wx(['integration', 'hub', 'user-delete', '101', '999', '--yes'])).code, 1);
  assert.equal(writes().length, before);
  json(await wx(['integration', 'hub', 'user-delete', '101', '--yes']));
  assert.equal(writes().at(-1).method, 'DELETE');
});

test('wx-admin cloud does not offer the integrations (no OpenAPI)', async () => {
  const {wx} = setup();
  const r = await wx(['cloud'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^integrations\b/m);
  assert.equal((await wx(['cloud', 'integrations'])).code, 64);
});

const HUB_HOOK = 'https://wim-stage.wildix.com/v2/integrations-hub/events/wildix';

test('hub: company-set makes the webhook of the hub when missing, once; company-delete removes it', async () => {
  const {wx, writes, s} = setup();
  const r = json(await wx(['integration', 'hub', 'company-set', '--city', 'Lyon']));
  assert.equal(r.webhook.created, true);
  const post = writes().find((c) => c.path === '/console/integrations' && c.method === 'POST');
  assert.equal(post.body.service, 'webhook');
  assert.equal(post.body.data.url, HUB_HOOK);
  assert.match(post.body.data.secret, /^[A-Za-z0-9]{30}$/);
  assert.deepEqual(
    post.body.data.events.map((e) => e.value),
    [
      'call:live:progress',
      'call:live:completed',
      'call:live:interrupted',
      'service:call:live:progress',
      'service:call:live:completed',
      'call:summary:completed',
    ],
  );
  assert.ok(!JSON.stringify(r).includes(post.body.data.secret));
  const again = json(await wx(['integration', 'hub', 'company-set', '--city', 'Nice']));
  assert.deepEqual(again.webhook, {integrationId: r.webhook.integrationId, created: false});
  assert.equal(writes().filter((c) => c.path === '/console/integrations' && c.method === 'POST').length, 1);

  const del = json(await wx(['integration', 'hub', 'company-delete', '--yes']));
  assert.equal(del.webhookRemoved, r.webhook.integrationId);
  assert.ok(!s.installed.some((i) => i.data?.url === HUB_HOOK));
});

test('the webhook of the hub is not changed, disabled or removed by hand', async () => {
  const st = state();
  st.installed.push({
    integrationId: 'hub001',
    service: 'webhook',
    data: {type: 'webhook', url: HUB_HOOK, key: '', secret: 'x', events: []},
  });
  const {wx, writes} = setup(st);
  for (const argv of [
    ['integration', 'disable', 'hub001', '--yes'],
    ['integration', 'delete', 'hub001', '--yes'],
    ['integration', 'webhook', 'update', 'hub001', '--add-event', 'presence:user'],
  ]) {
    const r = await wx(argv);
    assert.equal(r.code, 64, argv.join(' '));
    assert.match(r.stderr, /webhook of the integrations hub/);
  }
  assert.equal(writes().length, 0);
});
