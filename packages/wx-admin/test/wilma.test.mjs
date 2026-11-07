import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {MASK} from '../src/cloud/mask.mjs';
import {envOfTest, fakeCloud} from './fake-cloud.mjs';
import {fakeWilma, withLinks} from './fake-wilma.mjs';
import {run} from './helpers.mjs';

const agent = (id, name, extra = {}) => ({
  id,
  name,
  status: 'active',
  revision: 3,
  latestVersion: 2,
  channels: {voice: {}},
  engine: {ai: {model: 'default', instructions: 'be kind', skills: [], capabilities: [{hangup: {}}]}},
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-02T10:00:00Z',
  ...extra,
});

const base = () => ({
  agents: [agent('a_0000000001', 'Reception'), agent('a_0000000002', 'Sales', {latestVersion: undefined})],
  skills: [
    {id: 'sk0000000001', name: 'pricing', description: 'd', content: 'c', revision: 1, files: [], tools: []},
    {id: 'sk0000000002', name: 'twin', description: 'd', content: 'c', revision: 0},
    {id: 'sk0000000003', name: 'twin', description: 'd', content: 'c', revision: 0},
  ],
  tools: [{id: 'tl0000000001', name: 'call_webhook', category: 'general', handler: {connector: {}}, revision: 5}],
  connectors: [
    {
      id: 'cn0000000001',
      name: 'HubSpot',
      definition: {key: 'hubspot', version: '1'},
      configuration: {},
      authorization: {shared: {connection: {id: 'Cx000001'}}},
      grant: {all: {}},
      description: 'crm',
      revision: 2,
    },
  ],
  secrets: [{id: 'Sc000001', name: 'crm_key', description: 'CRM', status: 'active', attributes: {env: 'prod'}}],
  connections: [
    {id: 'Cx000001', name: 'Hubspot', type: 'shared', provider: 'hubspot_backend', status: 'active'},
    {
      id: 'Cx000002',
      name: null,
      type: 'user',
      provider: 'hubspot_backend',
      status: 'active',
      actor: {id: 'u1', name: 'Anna Rossi', email: 'anna@example.com', extension: '201'},
    },
  ],
  definitions: [
    {
      ref: {key: 'hubspot', version: '1'},
      metadata: {title: 'HubSpot', category: 'CRM'},
      authorization: {modes: ['user', 'shared'], provider: 'hubspot'},
    },
    {ref: {key: 'hubspot', version: '2'}, metadata: {title: 'HubSpot', category: 'CRM'}},
    {ref: {key: 'oldcrm', version: '1'}, metadata: {title: 'Old CRM'}, deprecated: true},
  ],
});

function setup(state = base()) {
  const f = fakeCloud(withLinks(state, fakeWilma(state)));
  const wx = (argv, opts = {}) => run(argv, {env: envOfTest(), fetch: f.fetch, ...opts});
  return {
    state,
    f,
    wx,
    calls: () => f.cloudCalls().filter((c) => c.host.includes('wilma') || c.host.includes('example')),
  };
}
const json = (r) => {
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wilma-'));

test('lists follow the cursor across pages, and never send company', async () => {
  const s = base();
  s.agents = Array.from({length: 230}, (_, i) => agent(`a_${String(i).padStart(10, '0')}`, `A${i}`));
  const {wx, calls} = setup(s);
  const r = json(await wx(['wilma', 'agent', 'list', '--channel', 'voice']));
  assert.equal(r.agents.length, 230);
  const lists = calls().filter((c) => c.path === '/v2/agents/agents');
  assert.deepEqual(
    lists.map((c) => c.query.cursor),
    [undefined, '100', '200'],
  );
  assert.equal(lists[0].query.channel, 'voice');
  assert.ok(calls().every((c) => !('company' in c.query)));
});

test('a name several objects share asks for the id, and changes nothing', async () => {
  const {wx, calls} = setup();
  const r = await wx(['wilma', 'skill', 'update', 'twin', '--name', 'x']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Several skills are named twin \(ids sk0000000002, sk0000000003\)/);
  assert.ok(calls().every((c) => c.method === 'GET'));
});

test('agent get shows the deployment and the URI; --version reads the published version', async () => {
  const s = base();
  s.deployments = {a_0000000001: [{version: 2, percentage: 100}]};
  s.versions = {
    a_0000000001: [
      {
        agentId: 'a_0000000001',
        version: 2,
        changelog: 'two',
        definition: {name: 'Reception', engine: {ai: {}}},
        publishedAt: '2026-11-03T10:00:00Z',
      },
    ],
  };
  const {wx} = setup(s);
  const t = await wx(['wilma', 'agent', 'get', 'Reception'], {output: 'text'});
  assert.match(t.stdout, /Deployment +v2 100%/);
  assert.match(t.stdout, /URI +wilma:\/\/agents\/a_0000000001/);
  const v = json(await wx(['wilma', 'agent', 'get', 'reception', '--version', '2']));
  assert.equal(v.changelog, 'two');
});

test('update merges a flag into the unmasked object and sends the revision read', async () => {
  const s = base();
  s.tools[0].handler = {
    mcp: {serverUrl: 'https://mcp', authorization: {customHeaders: {Authorization: 'Bearer real'}}},
  };
  const {wx, calls} = setup(s);
  json(await wx(['wilma', 'tool', 'update', 'call_webhook', '--category', 'crm']));
  const put = calls().find((c) => c.method === 'PUT');
  assert.equal(put.path, '/v2/tools/items/tl0000000001');
  assert.equal(put.body.category, 'crm');
  assert.equal(put.body.revision, 5);
  assert.equal(put.body.handler.mcp.authorization.customHeaders.Authorization, 'Bearer real');
  assert.deepEqual(Object.keys(put.body).sort(), ['category', 'handler', 'name', 'revision']);
});

test('update --instructions changes the AI engine only; another engine is refused', async () => {
  const s = base();
  s.agents[1].engine = {webhook: {url: 'https://hook'}};
  const {wx, calls} = setup(s);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'i.md'), 'new rules');
  json(await wx(['wilma', 'agent', 'update', 'Reception', '--instructions', path.join(dir, 'i.md')]));
  const put = calls().find((c) => c.method === 'PUT');
  assert.equal(put.body.engine.ai.instructions, 'new rules');
  assert.equal(put.body.engine.ai.model, 'default');
  const r = await wx(['wilma', 'agent', 'update', 'Sales', '--instructions', '-'], {stdin: 'x'});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /engine is webhook/);
});

test('export writes the create fields and the revision; it never overwrites a file', async () => {
  const {wx} = setup();
  const dir = tmp();
  const file = path.join(dir, 'a.json');
  json(await wx(['wilma', 'agent', 'export', 'Reception', '--to', file]));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['channels', 'engine', 'name', 'revision']);
  assert.equal(data.revision, 3);
  const again = await wx(['wilma', 'agent', 'export', 'Reception', '--to', file]);
  assert.equal(again.code, 64);
  assert.match(again.stderr, /exists/);
});

test('export masks secrets; a masked file is refused by create and update; --show-secrets writes 0600', async () => {
  const s = base();
  s.tools[0].handler = {mcp: {authorization: {customHeaders: {Authorization: 'Bearer real'}}}};
  const {wx, calls} = setup(s);
  const dir = tmp();
  json(await wx(['wilma', 'tool', 'export', 'call_webhook', '--to', path.join(dir, 't.json')]));
  const masked = JSON.parse(fs.readFileSync(path.join(dir, 't.json'), 'utf8'));
  assert.equal(masked.handler.mcp.authorization.customHeaders.Authorization, MASK);
  for (const argv of [
    ['wilma', 'tool', 'create', '--from', path.join(dir, 't.json')],
    ['wilma', 'tool', 'update', 'call_webhook', '--from', path.join(dir, 't.json')],
  ]) {
    const r = await wx(argv);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /masked values/);
  }
  assert.ok(calls().every((c) => c.method === 'GET'));
  json(await wx(['wilma', 'tool', 'export', 'call_webhook', '--to', path.join(dir, 's.json'), '--show-secrets']));
  assert.equal(fs.statSync(path.join(dir, 's.json')).mode & 0o777, 0o600);
});

test('update --from refuses a file exported before the last change', async () => {
  const {wx, calls} = setup();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({name: 'Reception', revision: 1}));
  const r = await wx(['wilma', 'agent', 'update', 'Reception', '--from', path.join(dir, 'a.json')]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /changed since .* \(revision 1, now 3\)/);
  assert.ok(calls().every((c) => c.method === 'GET'));
});

test('create sends only the fields create takes', async () => {
  const {wx, calls} = setup();
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'a.json'),
    JSON.stringify({name: 'New', channels: {chat: {}}, engine: {ai: {}}, id: 'x', revision: 9, companyId: 'c'}),
  );
  const r = json(await wx(['wilma', 'agent', 'create', '--from', path.join(dir, 'a.json')]));
  assert.equal(r.name, 'New');
  const post = calls().find((c) => c.method === 'POST');
  assert.deepEqual(post.body, {name: 'New', channels: {chat: {}}, engine: {ai: {}}});
});

test('diff: latest version against the draft by default; publish and restore send the revision', async () => {
  const s = base();
  s.changes = [{path: '/engine/ai/model', before: 'a', after: 'b'}];
  s.versions = {a_0000000001: [{version: 2, definition: {name: 'Reception'}}]};
  const {wx, calls} = setup(s);
  const d = await wx(['wilma', 'agent', 'diff', 'Reception'], {output: 'text'});
  assert.match(d.stdout, /v2 → draft\n\/engine\/ai\/model: a → b/);
  const cmp = calls().find((c) => c.path.endsWith('/compare-versions'));
  assert.deepEqual(cmp.query, {from: '2', toDraft: 'true'});
  const none = await wx(['wilma', 'agent', 'diff', 'Sales']);
  assert.match(none.stderr, /no published version/);
  json(await wx(['wilma', 'agent', 'publish', 'Reception', '--changelog', 'faster', '--name', 'fast']));
  const pub = calls().find((c) => c.method === 'POST' && c.path.endsWith('/versions'));
  assert.deepEqual(pub.body, {changelog: 'faster', name: 'fast', revision: 3});
  assert.equal((await wx(['wilma', 'agent', 'restore', 'Reception', '2'])).code, 64);
  json(await wx(['wilma', 'agent', 'restore', 'Reception', '2', '--yes']));
  const rest = calls().find((c) => c.path.endsWith('/versions/2/draft'));
  assert.equal(rest.body.revision, 3);
});

test('delete needs --yes, and --force when agents use it', async () => {
  const s = base();
  s.references = {
    'wilma://skills/sk0000000001': [
      {label: 'Reception', uri: 'wilma://agents/a_0000000001'},
      {label: 'Reception (Draft)', uri: 'wilma://agents/a_0000000001?draft'},
    ],
  };
  const {wx, calls} = setup(s);
  assert.equal((await wx(['wilma', 'skill', 'delete', 'pricing'])).code, 64);
  const used = await wx(['wilma', 'skill', 'delete', 'pricing', '--yes']);
  assert.equal(used.code, 64);
  assert.match(used.stderr, /used by Reception: give --force/);
  assert.ok(calls().every((c) => c.method === 'GET'));
  json(await wx(['wilma', 'skill', 'delete', 'pricing', '--yes', '--force']));
  assert.equal(calls().filter((c) => c.method === 'DELETE')[0].path, '/v2/skills/items/sk0000000001');
});

test('deploy: one version takes 100 %, several need percents adding up to 100, --reset', async () => {
  const {wx, calls, state} = setup();
  assert.equal((await wx(['wilma', 'agent', 'deploy', 'Reception', '2'])).code, 64); // no --yes
  json(await wx(['wilma', 'agent', 'deploy', 'Reception', '2', '--yes']));
  assert.deepEqual(state.deployments.a_0000000001, [{version: 2, percentage: 100}]);
  json(await wx(['wilma', 'agent', 'deploy', 'Reception', '1=80', '2=20', '--yes']));
  assert.deepEqual(state.deployments.a_0000000001, [
    {version: 1, percentage: 80},
    {version: 2, percentage: 20},
  ]);
  for (const bad of [['1=80', '2=30'], ['1', '2'], ['1=50', '1=50'], ['x']]) {
    const r = await wx(['wilma', 'agent', 'deploy', 'Reception', ...bad, '--yes']);
    assert.equal(r.code, 64, bad.join(' '));
  }
  json(await wx(['wilma', 'agent', 'deploy', 'Reception', '--reset', '--yes']));
  assert.ok(calls().some((c) => c.path.endsWith('/deployment/reset')));
});

test('agent keys: the new secret is printed once, unmasked; a key is deleted by name', async () => {
  const {wx, calls} = setup();
  const r = json(await wx(['wilma', 'agent', 'key-create', 'Reception', '--name', 'ci', '--expires', '2027-01-01']));
  assert.equal(r.secret, 'wak_n.the-full-secret');
  assert.deepEqual(calls().find((c) => c.method === 'POST').body, {name: 'ci', expiresAt: '2027-01-01'});
  const t = await wx(['wilma', 'agent', 'keys', 'Reception'], {output: 'text'});
  assert.match(t.stdout, /^ci \(\w+\) · wak_n…/);
  assert.equal((await wx(['wilma', 'agent', 'key-create', 'Reception', '--expires', 'soon'])).code, 64);
  json(await wx(['wilma', 'agent', 'key-delete', 'Reception', 'ci', '--yes']));
  assert.match(calls().find((c) => c.method === 'DELETE').path, /^\/v2\/agents\/agents\/a_0000000001\/keys\/\w+$/);
});

test('skill export writes skill.json and its files; create from the folder uploads them without the token', async () => {
  const s = base();
  s.skills[0].files = [{id: 'fl0000000001', path: 'references/a.md', name: 'a.md', size: 5}];
  s.files = {fl0000000001: {url: 'https://download.example/fl0000000001', bytes: 'hello'}};
  const {wx, calls, state} = setup(s);
  const dir = path.join(tmp(), 'pricing');
  json(await wx(['wilma', 'skill', 'export', 'pricing', '--to', dir]));
  assert.equal(fs.readFileSync(path.join(dir, 'references/a.md'), 'utf8'), 'hello');
  const def = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'));
  assert.deepEqual(def.files, [{path: 'references/a.md', name: 'a.md', size: 5}]);
  const made = json(await wx(['wilma', 'skill', 'create', '--from', dir]));
  assert.equal(made.uploaded, 1);
  assert.equal(state.uploads.length, 1);
  assert.equal(String(state.uploads[0].body), 'hello');
  assert.equal(state.uploads[0].headers.authorization, undefined);
  const post = calls().find((c) => c.method === 'POST' && c.path === '/v2/skills');
  assert.equal(post.body.files.length, 1);
  assert.equal(post.body.files[0].path, 'references/a.md');
  assert.match(post.body.files[0].id, /^n/);
  assert.equal(post.body.revision, undefined);
});

test('a skill folder whose files leave the folder is refused before any upload', async () => {
  const {wx, calls} = setup();
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'skill.json'),
    JSON.stringify({name: 'x', description: 'd', content: 'c', files: [{path: '../etc/passwd'}]}),
  );
  const r = await wx(['wilma', 'skill', 'create', '--from', dir]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Not a path of a skill file/);
  assert.ok(calls().every((c) => c.method === 'GET'));
  fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify({name: 'x', files: [{path: 'a.md'}]}));
  const j = await wx(['wilma', 'skill', 'create', '--from', path.join(dir, 'one.json')]);
  assert.match(j.stderr, /files without an id/);
});

test('connectors: list names the shared connection; catalog hides deprecated definitions', async () => {
  const {wx} = setup();
  const l = await wx(['wilma', 'connector', 'list'], {output: 'text'});
  assert.equal(
    l.stdout.trim(),
    'HubSpot (cn0000000001) · hubspot@1 · grant all · shared connection Hubspot (Cx000001)',
  );
  const c = json(await wx(['wilma', 'connector', 'catalog']));
  assert.deepEqual(
    c.definitions.map((d) => `${d.ref.key}@${d.ref.version}`),
    ['hubspot@1', 'hubspot@2'],
  );
  assert.equal(json(await wx(['wilma', 'connector', 'catalog', '--all'])).definitions.length, 3);
  const d = json(await wx(['wilma', 'connector', 'definition', 'hubspot']));
  assert.equal(d.ref.version, '2');
});

test('a connector an agent uses is not deleted without --force', async () => {
  const s = base();
  s.agents[0].engine.ai.capabilities.push({connector: {id: 'cn0000000001'}});
  const {wx} = setup(s);
  const r = await wx(['wilma', 'connector', 'delete', 'HubSpot', '--yes']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /used by Reception/);
  assert.equal(json(await wx(['wilma', 'connector', 'delete', 'HubSpot', '--yes', '--force'])).deleted.length, 1);
});

test('secrets: the value is read from stdin, never an option; rotate; update keeps attributes', async () => {
  const {wx, calls, state} = setup();
  const bad = await wx(['wilma', 'secret', 'create', 'bad name'], {stdin: 'v\n'});
  assert.equal(bad.code, 64);
  const r = json(
    await wx(['wilma', 'secret', 'create', 'api_key', '--attribute', 'env=prod'], {stdin: 's3cr3t\nrest'}),
  );
  assert.equal(r.name, 'api_key');
  const post = calls().find((c) => c.method === 'POST');
  assert.deepEqual(post.body, {name: 'api_key', value: 's3cr3t', attributes: {env: 'prod'}});
  assert.equal(JSON.stringify(r).includes('s3cr3t'), false);
  assert.equal((await wx(['wilma', 'secret', 'create', 'empty'], {stdin: ''})).code, 64);
  json(await wx(['wilma', 'secret', 'rotate', 'crm_key'], {stdin: 'n3w'}));
  assert.equal(state.values.Sc000001, 'n3w');
  json(await wx(['wilma', 'secret', 'update', 'crm_key', '--description', 'new']));
  const put = calls().find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, {name: 'crm_key', description: 'new', attributes: {env: 'prod'}});
});

test('connections: the owner of a user connection only with --full', async () => {
  const {wx} = setup();
  const plain = json(await wx(['wilma', 'connection', 'list']));
  assert.deepEqual(plain.connections[1].actor, {id: 'u1'});
  const full = json(await wx(['wilma', 'connection', 'list', '--full']));
  assert.equal(full.connections[1].actor.email, 'anna@example.com');
  const t = await wx(['wilma', 'connection', 'list', '--full'], {output: 'text'});
  assert.match(t.stdout, /of Anna Rossi/);
  assert.doesNotMatch(t.stdout, /anna@example.com/);
  const v = json(await wx(['wilma', 'connection', 'verify', 'Hubspot']));
  assert.equal(v.working, true);
});

test('audit, trace and usage map the options to the query', async () => {
  const s = base();
  s.events = Array.from({length: 120}, (_, i) => ({eventId: `e${i}`, action: 'updated', resource: 'wilma://agents/a'}));
  s.traces = [
    {
      traceId: 't1',
      service: 'voice',
      status: 'complete',
      startTime: '2026-11-05T10:00:00Z',
      endTime: '2026-11-05T10:00:03Z',
      attributes: {'agent.name': 'Reception'},
    },
  ];
  s.spans = {
    t1: [
      {
        spanId: 's1',
        kind: 'model',
        status: 'complete',
        startTime: '2026-11-05T10:00:01Z',
        endTime: '2026-11-05T10:00:02Z',
      },
    ],
  };
  s.usage = {rows: [{dimensions: {channel: 'voice'}, metrics: {sessions: 3}}], total: {metrics: {sessions: 3}}};
  const {wx, calls} = setup(s);
  const a = json(
    await wx(['wilma', 'audit', 'list', '--prefix', 'wilma://agents/', '--since', '2026-11-01', '--limit', '110']),
  );
  assert.equal(a.events.length, 110);
  const q = calls().find((c) => c.path === '/v2/audit/events').query;
  assert.deepEqual(q, {uriPrefix: 'wilma://agents/', from: '2026-11-01', limit: '100'});
  assert.equal((await wx(['wilma', 'audit', 'list', '--uri', 'agents/x'])).code, 64);
  assert.equal((await wx(['wilma', 'audit', 'list', '--since', 'yesterday'])).code, 64);
  const t = await wx(['wilma', 'trace', 'list', '--service', 'voice', '--filter', 'channel=voice'], {output: 'text'});
  assert.match(t.stdout, /voice · complete · 3\.0s · Reception · t1/);
  assert.equal(calls().find((c) => c.path === '/v2/traces').query.filter, 'channel=voice');
  const g = await wx(['wilma', 'trace', 'get', 't1'], {output: 'text'});
  assert.match(g.stdout, /\+1\.0s · model · complete · 1\.0s · s1/);
  const u = await wx(['wilma', 'usage', '--group-by', 'channel', '--group-by', 'agent.id', '--interval', 'day'], {
    output: 'text',
  });
  assert.match(u.stdout, /channel=voice: sessions 3\ntotal: sessions 3/);
  const uq = calls().find((c) => c.path === '/v2/traces/usage');
  assert.match(uq.url, /groupBy=channel&groupBy=agent.id/);
  assert.equal(uq.query.interval, 'day');
});
