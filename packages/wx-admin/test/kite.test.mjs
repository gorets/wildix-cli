import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {MASK} from '../src/cloud/mask.mjs';
import {envOfTest, fakeCloud} from './fake-cloud.mjs';
import {run} from './helpers.mjs';

const svc = (id, title, extra = {}) => ({
  id,
  uri: `${id}@pbx.example:443`,
  title,
  settings: {},
  extensions: ['101'],
  pbx: {domain: 'pbx.example', port: 443},
  ...extra,
});
const state = () => ({
  services: [svc(1, 'Support'), svc(2, 'Sales', {settings: {messagingNumber: '+3902000'}}), svc(3, 'Sales')],
  bots: [{id: 'bot-1', name: 'Helper'}],
  widgets: [
    {
      id: 'aaaa1111',
      company: 'it_x',
      name: 'Site',
      target: {service: {id: 1, uri: '1@pbx.example:443'}},
      routes: [{id: 'r001', rules: [], target: {bot: {id: 'bot-1'}}}],
      appearance: {text: {title: 'Hi'}},
      anonymousSessionsEnabled: true,
      createdAt: '2026-11-01T10:00:00Z',
    },
    {
      id: 'bbbb2222',
      company: 'it_x',
      name: 'Shop',
      target: {agent: {email: 'ann@example.com'}},
      createdAt: '2026-11-02T10:00:00Z',
    },
  ],
  sms: {
    numbers: [{number: '+3901000', service: svc(1, 'Support')}, {number: '+3902000'}],
    configs: [
      {
        serviceNumber: '+3901000',
        companyId: 'it_x',
        serviceUri: '1@pbx.example:443',
        target: {service: {id: 1, uri: '1@pbx.example:443'}},
        routes: [{id: 'wh01', rules: [{timeFrame: {day: 'WEEKDAYS'}}], target: {agent: {email: 'ann@example.com'}}}],
        actions: [],
      },
    ],
  },
  whatsapp: {
    numbers: [{number: '+3903000'}],
    configs: [],
    templates: [{name: 'hello', language: 'en', status: 'APPROVED'}],
  },
  messenger: {senders: [{senderId: '123456', name: 'Acme page', url: ''}], configs: []},
});

function fakeKite(s) {
  return (method, u, {body}) => {
    const p = u.pathname;
    let m;
    if (p === '/v2/kite/services') return {body: {services: s.services}};
    if (p === '/v2/users/bots') return {body: {bots: s.bots}};
    if (p === '/v2/kite/widgets' && method === 'GET') return {body: {widgets: s.widgets}};
    if (p === '/v2/kite/widgets' && method === 'POST')
      return {body: {widget: {id: 'cccc3333', company: 'it_x', ...body}}};
    if ((m = p.match(/^\/v2\/kite\/widgets\/([^/]+)$/))) {
      const w = s.widgets.find((x) => x.id === m[1]);
      if (!w) return {status: 404, body: {message: 'Widget not found'}};
      if (method === 'GET') return {body: {widget: w}};
      if (method === 'PUT') return {body: {widget: {id: w.id, company: w.company, ...body}}};
      if (method === 'DELETE') return {body: {}};
    }
    if ((m = p.match(/^\/v2\/kite\/(sms|whatsapp)\/numbers$/))) return {body: {numbers: s[m[1]].numbers}};
    if ((m = p.match(/^\/v2\/kite\/(sms|whatsapp)\/configurations$/))) return {body: {configurations: s[m[1]].configs}};
    if ((m = p.match(/^\/v2\/kite\/whatsapp\/templates\/(.+)$/))) return {body: {templates: s.whatsapp.templates}};
    if ((m = p.match(/^\/v2\/kite\/(sms|whatsapp)\/configurations\/(.+)$/))) {
      const n = decodeURIComponent(m[2]);
      const c = s[m[1]].configs.find((x) => x.serviceNumber === n);
      if (method === 'GET') return c ? {body: {configuration: c}} : {status: 404, body: {message: 'not found'}};
      if (method === 'PUT') return {body: {configuration: {serviceNumber: n, ...body}}};
    }
    if ((m = p.match(/^\/v2\/kite\/messaging\/(\w+)\/senders$/))) return {body: {senders: s[m[1]].senders}};
    if ((m = p.match(/^\/v2\/kite\/messaging\/(\w+)\/senders\/([^/]+)\/configuration$/))) {
      const c = s[m[1]].configs.find((x) => x.senderId === m[2]);
      if (method === 'GET') return c ? {body: {configuration: c}} : {status: 404, body: {message: 'not found'}};
      if (method === 'PUT') return {body: {configuration: {senderId: m[2], ...body}}};
    }
    return {status: 404, body: {message: `no route ${method} ${p}`}};
  };
}

const setup = (s = state()) => {
  const f = fakeCloud(fakeKite(s));
  const wx = (argv, opts = {}) => run(argv, {env: envOfTest(), fetch: f.fetch, ...opts});
  const writes = () => f.cloudCalls().filter((c) => c.method !== 'GET');
  return {f, s, wx, writes};
};
const json = (r) => {
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kite-'));

test('services and widgets: on the x-bees host with the CPA token; targets named', async () => {
  const {wx, f} = setup();
  const s = await wx(['kite', 'services', '--search', 'sal'], {output: 'text'});
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /^2 {2}Sales · 2@pbx\.example:443 · 1 extension · messaging \+3902000$/m);
  assert.equal(f.cloudCalls()[0].url, 'https://api-stage.x-bees.com/v2/kite/services');
  const l = await wx(['kite', 'widget', 'list'], {output: 'text'});
  assert.match(l.stdout, /^Site \(aaaa1111\) · service Support · anonymous allowed · 1 routes · updated /m);
  assert.match(l.stdout, /^Shop \(bbbb2222\) · agent ann@example\.com · signed-in guests/m);
});

test('widget get and export by name; export to a new file only', async () => {
  const {wx} = setup();
  const g = json(await wx(['kite', 'widget', 'get', 'Site']));
  assert.equal(g.id, 'aaaa1111');
  const e = json(await wx(['kite', 'widget', 'export', 'Site']));
  assert.deepEqual(Object.keys(e), ['id', 'name', 'target', 'appearance', 'routes', 'anonymousSessionsEnabled']);
  const file = path.join(tmp(), 'w.json');
  json(await wx(['kite', 'widget', 'export', 'Site', '--to', file]));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'Site');
  assert.equal((await wx(['kite', 'widget', 'export', 'Site', '--to', file])).code, 64);
});

test('widget create: a target by kind (a service by title, a bot by name, an agent by e-mail) or from an export', async () => {
  const {wx, writes} = setup();
  json(await wx(['kite', 'widget', 'create', '--name', 'New', '--target', 'bot:Helper', '--anonymous', 'only']));
  assert.deepEqual(writes()[0].body, {
    name: 'New',
    target: {bot: {id: 'bot-1'}},
    anonymousSessionsEnabled: true,
    anonymousSessionsOnly: true,
  });
  json(await wx(['kite', 'widget', 'create', '--name', 'N2', '--target', 'service:Support']));
  assert.deepEqual(writes()[1].body.target, {service: {id: 1, uri: '1@pbx.example:443'}});
  for (const bad of ['service:Sales', 'agent:nobody', 'robot:x', 'service:']) {
    const r = await wx(['kite', 'widget', 'create', '--name', 'X', '--target', bad]);
    assert.equal(r.code, 64, bad);
  }
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'w.json'),
    JSON.stringify({id: 'aaaa1111', company: 'it_x', name: 'Copy', target: {agent: {email: 'a@b.co'}}, createdAt: 'x'}),
  );
  json(await wx(['kite', 'widget', 'create', '--from', path.join(dir, 'w.json')]));
  assert.deepEqual(writes().at(-1).body, {name: 'Copy', target: {agent: {email: 'a@b.co'}}});
  assert.equal((await wx(['kite', 'widget', 'create', '--name', 'X'])).code, 64);
});

test('widget update: what it has is sent back with the changes; an export of another widget is refused', async () => {
  const {wx, writes} = setup();
  json(await wx(['kite', 'widget', 'update', 'Site', '--name', 'Site 2', '--anonymous', 'off']));
  const put = writes()[0];
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/v2/kite/widgets/aaaa1111');
  assert.deepEqual(put.body, {
    name: 'Site 2',
    target: {service: {id: 1, uri: '1@pbx.example:443'}},
    appearance: {text: {title: 'Hi'}},
    routes: [{id: 'r001', rules: [], target: {bot: {id: 'bot-1'}}}],
    anonymousSessionsEnabled: false,
    anonymousSessionsOnly: false,
  });
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'other.json'),
    JSON.stringify({id: 'bbbb2222', name: 'Shop', target: {agent: {email: 'a@b.co'}}}),
  );
  const r = await wx(['kite', 'widget', 'update', 'Site', '--from', path.join(dir, 'other.json')]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /export of the widget bbbb2222/);
  fs.writeFileSync(
    path.join(dir, 'masked.json'),
    JSON.stringify({id: 'aaaa1111', name: 'Site', target: {agent: {email: MASK}}}),
  );
  assert.equal((await wx(['kite', 'widget', 'update', 'Site', '--from', path.join(dir, 'masked.json')])).code, 64);
  assert.equal((await wx(['kite', 'widget', 'update', 'Site'])).code, 64);
  assert.equal(writes().length, 1);
});

test('widget delete needs --yes and finds every widget first', async () => {
  const {wx, writes} = setup();
  assert.equal((await wx(['kite', 'widget', 'delete', 'Site'])).code, 64);
  assert.equal((await wx(['kite', 'widget', 'delete', 'Site', 'Nope', '--yes'])).code, 64);
  assert.equal(writes().length, 0);
  assert.deepEqual(
    json(await wx(['kite', 'widget', 'delete', 'Site', 'bbbb2222', '--yes'])).deleted.map((w) => w.id),
    ['aaaa1111', 'bbbb2222'],
  );
});

test('sms list joins the numbers with their configuration', async () => {
  const {wx} = setup();
  const r = await wx(['kite', 'sms', 'list'], {output: 'text'});
  assert.match(r.stdout, /^\+3901000 · service Support · → service Support · 1 routes$/m);
  assert.match(r.stdout, /^\+3902000 · no linked service · not configured$/m);
  const g = await wx(['kite', 'sms', 'get', '+3902000']);
  assert.equal(g.code, 64);
  assert.match(g.stderr, /not configured/);
});

test('sms set: the default target changes, the work-hours routes stay; a new number takes its own service', async () => {
  const {wx, writes} = setup();
  json(await wx(['kite', 'sms', 'set', '+3901000', '--target', 'agent:bob@example.com']));
  const put = writes()[0];
  assert.equal(put.path, '/v2/kite/sms/configurations/%2B3901000');
  assert.deepEqual(put.body.target, {agent: {email: 'bob@example.com'}});
  assert.equal(put.body.serviceUri, '1@pbx.example:443');
  assert.equal(put.body.routes.length, 1);
  json(await wx(['kite', 'sms', 'set', '+3902000', '--target', 'bot:bot-1']));
  assert.deepEqual(writes()[1].body, {target: {bot: {id: 'bot-1'}}, serviceUri: '2@pbx.example:443'});
  json(await wx(['kite', 'sms', 'set', '+3901000', '--service', '3']));
  assert.equal(writes()[2].body.serviceUri, '3@pbx.example:443');
});

test('sms set --from replaces everything and needs --yes; it is given alone', async () => {
  const {wx, writes} = setup();
  const dir = tmp();
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      serviceNumber: '+3901000',
      companyId: 'it_x',
      serviceUri: '1@pbx.example:443',
      target: {service: {id: 1, uri: '1@pbx.example:443'}},
    }),
  );
  assert.equal((await wx(['kite', 'sms', 'set', '+3901000', '--from', file])).code, 64);
  assert.equal(
    (await wx(['kite', 'sms', 'set', '+3901000', '--from', file, '--target', 'bot:bot-1', '--yes'])).code,
    64,
  );
  json(await wx(['kite', 'sms', 'set', '+3901000', '--from', file, '--yes']));
  assert.deepEqual(writes()[0].body, {
    serviceUri: '1@pbx.example:443',
    target: {service: {id: 1, uri: '1@pbx.example:443'}},
  });
  assert.equal(writes().length, 1);
});

test('whatsapp: templates of a number of the company only; messenger senders by id', async () => {
  const {wx, writes, f} = setup();
  assert.deepEqual(
    json(await wx(['kite', 'whatsapp', 'templates', '+3903000'])).templates.map((t) => t.name),
    ['hello'],
  );
  const bad = await wx(['kite', 'whatsapp', 'templates', '+3999']);
  assert.equal(bad.code, 64);
  assert.ok(!f.cloudCalls().some((c) => c.path.includes('/templates/+3999')));
  const l = await wx(['kite', 'messenger', 'list'], {output: 'text'});
  assert.match(l.stdout, /^123456 \(Acme page\) · no linked service · not configured$/m);
  assert.equal((await wx(['kite', 'messenger', 'set', '123456', '--target', 'service:Support'])).code, 0);
  assert.deepEqual(writes()[0], {
    ...writes()[0],
    path: '/v2/kite/messaging/messenger/senders/123456/configuration',
    body: {target: {service: {id: 1, uri: '1@pbx.example:443'}}, serviceUri: '1@pbx.example:443'},
  });
  const none = await wx(['kite', 'messenger', 'set', '123456', '--target', 'agent:a@b.co']);
  assert.equal(none.code, 64);
  assert.match(none.stderr, /--service SERVICE/);
});

test('wx-admin cloud does not offer kite (no OpenAPI)', async () => {
  const {wx} = setup();
  assert.doesNotMatch((await wx(['cloud'], {output: 'text'})).stdout, /^kite\b/m);
});
