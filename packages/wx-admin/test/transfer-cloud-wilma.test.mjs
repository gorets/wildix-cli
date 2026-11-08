import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {test} from 'node:test';
import {applyPlan, policyOf} from '../src/transfer/apply.mjs';
import {readKinds, TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {makePlan} from '../src/transfer/plan.mjs';
import {selectFrom} from '../src/transfer/selection.mjs';
import {keyOf, toPortable} from '../src/transfer/refs.mjs';
import {CHANGELOG, versionedWrite} from '../src/transfer/cloud/versioned.mjs';
import {KINDS as WILMA_API} from '../src/wilma/api.mjs';
import {fakeCompany} from './fake-company.mjs';

const KINDS = ['wilma-secrets', 'wilma-connections'];
const WILMA = 'https://api-stage.wilma.wildix.com';
const SECRET = 's3cret-value-1';

const secret = (id, name, extra = {}) => ({id, name, revision: 3, status: 'active', createdAt: 'x', ...extra});
const conn = (id, name, extra = {}) => ({
  id,
  type: 'shared',
  name,
  provider: 'github',
  status: 'active',
  revision: 1,
  ...extra,
});

const company = (x, y = {}) =>
  fakeCompany({
    pbxs: {a: {company: 'it_x', pbx: {}}, b: {company: 'it_y', pbx: {}}},
    clouds: {it_x: {wilma: x}, it_y: {wilma: y}},
  });

// Source it_x → plan against it_y → apply the chosen keys with the given secrets.
async function transfer(f, {secrets = {}, only} = {}) {
  const source = toPortable(await readKinds(await f.clients('a'), KINDS), {
    serial: f.serial('a'),
    host: f.host('a'),
    company: 'it_x',
  });
  const clients = {wilma: (await f.clients('b')).wilma};
  const target = await readKinds(clients, KINDS);
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const chosen = new Set(plan.items.filter((i) => !only || only.includes(i.key)).map((i) => i.key));
  const results = await applyPlan(clients, plan, chosen, {secrets});
  return {source, plan, results};
}

const writesOf = (f) =>
  f.writes({company: 'it_y', service: 'wilma'}).map((c) => [c.method, `https://${c.host}${c.path}`, c.body]);

test('secret created pending without a value', async () => {
  const f = company({secrets: [secret('s1', 'api_key', {description: 'the key', attributes: {kind: 'api'}})]});
  const {source, results} = await transfer(f);
  assert.deepEqual(source.kinds['wilma-secrets'], [
    {
      name: 'api_key',
      data: {name: 'api_key', description: 'the key', attributes: {kind: 'api'}, value: {$secret: 'value'}},
    },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'create');
  assert.equal(results[0].pending, true);
  assert.deepEqual(writesOf(f), [
    ['POST', `${WILMA}/v2/secrets`, {name: 'api_key', description: 'the key', attributes: {kind: 'api'}}],
  ]);
});

test('secret value from --secrets is sent once and never logged', async () => {
  const f = company({secrets: [secret('s1', 'api_key')]});
  const key = keyOf('wilma-secrets', 'api_key');
  const {plan, results} = await transfer(f, {secrets: {[key]: {value: SECRET}}});
  assert.equal(results[0].action, 'create');
  assert.equal(results[0].pending, undefined);
  assert.deepEqual(writesOf(f), [['POST', `${WILMA}/v2/secrets`, {name: 'api_key', value: SECRET}]]);
  assert.doesNotMatch(JSON.stringify(results), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(f.cloudCalls({company: 'it_x'})), new RegExp(SECRET));
});

test('existing secret metadata differs: PUT without the value, rotate only when a value is given', async () => {
  const x = () => ({
    secrets: [secret('s1', 'api_key', {description: 'new'}), secret('s2', 'other', {description: 'same'})],
  });
  const y = () => ({
    secrets: [secret('t1', 'api_key', {description: 'old'}), secret('t2', 'other', {description: 'same'})],
  });
  const f = company(x(), y());
  const {plan, results} = await transfer(f);
  assert.deepEqual(
    plan.items.map((i) => [i.name, i.state]),
    [
      ['api_key', 'differs'],
      ['other', 'same'],
    ],
  );
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.id, r.pending]),
    [[keyOf('wilma-secrets', 'api_key'), 'overwrite', 't1', undefined]],
  );
  assert.deepEqual(writesOf(f), [['PUT', `${WILMA}/v2/secrets/items/t1`, {name: 'api_key', description: 'new'}]]);

  const f2 = company(x(), y());
  const key = keyOf('wilma-secrets', 'api_key');
  const second = await transfer(f2, {secrets: {[key]: {value: SECRET}}});
  assert.equal(second.results[0].action, 'overwrite');
  assert.deepEqual(writesOf(f2), [
    ['PUT', `${WILMA}/v2/secrets/items/t1`, {name: 'api_key', description: 'new'}],
    ['POST', `${WILMA}/v2/secrets/items/t1/rotate`, {value: SECRET}],
  ]);
  assert.doesNotMatch(JSON.stringify(second.results), new RegExp(SECRET));
});

test('USER connections are not read', async () => {
  const f = company({
    connections: [
      conn('c1', 'github-team', {description: 'team', scopes: ['repo']}),
      {id: 'c2', type: 'user', provider: 'github', status: 'active', actor: {id: 'u1'}},
    ],
  });
  const snap = await readKinds(await f.clients('a'), ['wilma-connections']);
  assert.deepEqual(snap['wilma-connections'], [
    {
      id: 'c1',
      name: 'github-team',
      data: {name: 'github-team', description: 'team', provider: 'github', scopes: ['repo']},
    },
  ]);
  const gets = f.cloudCalls({company: 'it_x', service: 'wilma'});
  assert.equal(gets[0].query.type, 'shared');
});

test('shared connection created without credential, updated by metadata only', async () => {
  const f = company(
    {
      connections: [
        conn('c1', 'github-team', {description: 'team', scopes: ['repo'], connectionConfig: {region: 'eu'}}),
        conn('c2', 'jira', {description: 'new'}),
      ],
    },
    {connections: [conn('t2', 'jira', {description: 'old'})]},
  );
  const {results} = await transfer(f);
  assert.deepEqual(
    results.map((r) => [r.action, r.id === 't2' ? 't2' : 'new']),
    [
      ['create', 'new'],
      ['overwrite', 't2'],
    ],
  );
  assert.deepEqual(writesOf(f), [
    [
      'POST',
      `${WILMA}/v2/secrets/connections`,
      {
        name: 'github-team',
        description: 'team',
        provider: 'github',
        scopes: ['repo'],
        connectionConfig: {region: 'eu'},
      },
    ],
    ['PUT', `${WILMA}/v2/secrets/connections/t2`, {name: 'jira', description: 'new'}],
  ]);
});

test('a connectionConfig with a clientSecret binds the connection (safety net)', async () => {
  const f = company({
    connections: [conn('c1', 'oauth', {connectionConfig: {clientId: 'abc', clientSecret: 'shh-shh-shh'}})],
  });
  const {source, plan, results} = await transfer(f);
  assert.deepEqual(source.bound, [
    {kind: 'wilma-connections', name: 'oauth', path: 'connectionConfig.clientSecret', found: 'secret'},
  ]);
  assert.equal(plan.items[0].state, 'blocked');
  assert.deepEqual(results, []);
  assert.deepEqual(writesOf(f), []);
});

test('a failed rotate is a failed result with its stage and id, and no value in it', async () => {
  const f = company(
    {secrets: [secret('s1', 'api_key', {description: 'new'})]},
    {secrets: [secret('t1', 'api_key', {description: 'old'})]},
  );
  const source = toPortable(await readKinds(await f.clients('a'), KINDS), {
    serial: f.serial('a'),
    host: f.host('a'),
    company: 'it_x',
  });
  const real = (await f.clients('b')).wilma;
  const clients = {
    wilma: {
      call: async (method, path, opts) => {
        if (path.endsWith('/rotate')) throw new Error(`Wilma answered 500 for ${opts.json.value}`);
        return real.call(method, path, opts);
      },
    },
  };
  const plan = makePlan(source, await readKinds(clients, KINDS), {serial: f.serial('b'), host: f.host('b')});
  const key = keyOf('wilma-secrets', 'api_key');
  const results = await applyPlan(clients, plan, new Set([key]), {secrets: {[key]: {value: SECRET}}});
  assert.equal(results[0].action, 'failed');
  assert.equal(results[0].stage, 'rotate');
  assert.equal(results[0].id, 't1');
  assert.doesNotMatch(JSON.stringify(results), new RegExp(SECRET));
  assert.deepEqual(writesOf(f), [['PUT', `${WILMA}/v2/secrets/items/t1`, {name: 'api_key', description: 'new'}]]);
});

test('a failed create or rotate names its stage and HTTP status only: an echo of the value in any form is not kept', async () => {
  // A value whose echo in a JSON or URL-encoded body is not the value as it is.
  const value = 'se cret/v\u00e4"lue';
  const echo = (e) =>
    Object.assign(new Error(`HTTP 500: ${JSON.stringify(e)} ${encodeURIComponent(value)}`), {status: 500});
  const f = company(
    {secrets: [secret('s1', 'fresh'), secret('s2', 'api_key', {description: 'new'})]},
    {secrets: [secret('t1', 'api_key', {description: 'old'})]},
  );
  const source = toPortable(await readKinds(await f.clients('a'), KINDS), {
    serial: f.serial('a'),
    host: f.host('a'),
    company: 'it_x',
  });
  const real = (await f.clients('b')).wilma;
  const clients = {
    wilma: {
      call: async (method, path, opts) => {
        if (method === 'POST') throw echo(opts.json);
        return real.call(method, path, opts);
      },
    },
  };
  const plan = makePlan(source, await readKinds(clients, KINDS), {serial: f.serial('b'), host: f.host('b')});
  const fresh = keyOf('wilma-secrets', 'fresh');
  const existing = keyOf('wilma-secrets', 'api_key');
  const results = await applyPlan(clients, plan, new Set([fresh, existing]), {
    secrets: {[fresh]: {value}, [existing]: {value}},
  });
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.stage, r.id, r.error]),
    [
      [fresh, 'failed', 'create', undefined, 'create was refused (HTTP 500)'],
      [existing, 'failed', 'rotate', 't1', 'rotate was refused (HTTP 500)'],
    ],
  );
  for (const part of ['se cret', 'v\u00e4', 'se%20cret', '%C3%A4'])
    assert.ok(!JSON.stringify(results).includes(part), part);
});

test('a connection that differs only in provider or config is blocked; with more it warns', async () => {
  const f = company(
    {connections: [conn('c1', 'a', {provider: 'gitlab'}), conn('c2', 'b', {provider: 'gitlab', description: 'new'})]},
    {connections: [conn('t1', 'a'), conn('t2', 'b')]},
  );
  const {plan, results} = await transfer(f);
  const [a, b] = plan.items;
  assert.equal(a.state, 'blocked');
  assert.equal(
    a.reason,
    `provider cannot be changed on an existing Wilma connection: remove it on ${f.host('b')} and re-run`,
  );
  assert.equal(b.state, 'differs');
  assert.deepEqual(b.warnings, [
    {type: 'immutable', path: 'provider', text: 'provider is not changed by an overwrite'},
  ]);
  assert.deepEqual(
    results.map((r) => [r.action, r.id]),
    [['overwrite', 't2']],
  );
  assert.deepEqual(writesOf(f), [['PUT', `${WILMA}/v2/secrets/connections/t2`, {name: 'b', description: 'new'}]]);
});

// ---- connectors and tools -------------------------------------------------------------------------------------------

const OBJECT_KINDS = ['wilma-secrets', 'wilma-connections', 'wilma-connectors', 'wilma-tools'];
const HEADER = 'hdr-value-42';
const HEADER_PATH = 'handler.mcp.authorization.customHeaders.X-Api-Key';
const changelog = 'wx-admin config import';

// A tool handler running a connector with a shared connection; an MCP server with a custom header; an MCP tool on it.
const connectorHandler = (connection) => ({
  connector: {
    definition: {key: 'webhook', version: 2},
    configuration: {url: 'https://hooks.example/in'},
    authorization: {shared: {connection: {id: connection}}},
    toolId: 'post',
  },
});
const mcpHandler = (headers = {'X-Api-Key': HEADER}) => ({
  mcp: {serverUrl: 'https://mcp.example/sse', authorization: {customHeaders: headers}, tools: ['search']},
});
const mcpToolHandler = (server) => ({mcpTool: {mcpToolId: server, mcpToolName: 'search'}});
const def = (name, extra = {}) => ({name, category: 'Support', description: 'd', ...extra});

// Tools as Wilma keeps them: the draft on the object, the published definition in its versions. published: the
// definition of the latest version (none: never published); draft: the object (default: the published one).
function toolsState(specs) {
  const tools = [];
  const versions = {};
  for (const {id, published, draft = published, version = 2, revision = 3} of specs) {
    tools.push({
      id,
      companyId: 'it',
      ...draft,
      status: published ? 'active' : 'draft',
      revision,
      ...(published ? {latestVersion: version} : {}),
    });
    if (published) versions[id] = [{toolId: id, version, changelog: 'old', definition: {id, ...published}}];
  }
  return {tools, versions};
}

// Source it_x → plan against it_y → apply; calls: every call to the Wilma of it_y during the apply.
async function transferObjects(f, {secrets = {}, wrap = (c) => c} = {}) {
  const source = toPortable(await readKinds(await f.clients('a'), OBJECT_KINDS), {
    serial: f.serial('a'),
    host: f.host('a'),
    company: 'it_x',
  });
  const clients = {wilma: wrap((await f.clients('b')).wilma)};
  const target = await readKinds(clients, OBJECT_KINDS);
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const mark = f.calls.length;
  const results = await applyPlan(clients, plan, new Set(plan.items.map((i) => i.key)), {secrets});
  const calls = f.calls
    .slice(mark)
    .filter((c) => c.company === 'it_y' && c.service === 'wilma')
    .map((c) => [c.method, `${WILMA}${c.path}`, ...(c.body === undefined ? [] : [c.body])]);
  return {source, plan, results, calls};
}
const portableOf = (source, kind) => Object.fromEntries(source.kinds[kind].map((o) => [o.name, o.data]));
const T = (id) => `${WILMA}/v2/tools/items/${id}`;

test('new tool: create → publish, draft written when different', async () => {
  const github = conn('c1', 'github-team');
  const f = company(
    {
      connections: [github],
      ...toolsState([
        {
          id: 'x1',
          published: def('lookup', {description: 'v2', handler: connectorHandler('c1')}),
          draft: def('lookup', {description: 'next', handler: connectorHandler('c1')}),
        },
        {id: 'x2', published: def('plain', {handler: connectorHandler('c1')})},
        {id: 'x3', draft: def('sketch', {handler: connectorHandler('c1')})},
      ]),
    },
    {connections: [conn('t1', 'github-team')]},
  );
  const snapshot = await readKinds(await f.clients('a'), ['wilma-tools']);
  assert.deepEqual(
    snapshot['wilma-tools'].map((o) => [o.id, o.name, o.version]),
    [
      ['x1', 'lookup', 2],
      ['x2', 'plain', 2],
      ['x3', 'sketch', undefined],
    ],
  );

  const {source, results, calls} = await transferObjects(f);
  const connRef = {$ref: 'wilma-connections/github-team', as: 'id'};
  const portableHandler = {
    connector: {...connectorHandler('c1').connector, authorization: {shared: {connection: {id: connRef}}}},
  };
  assert.deepEqual(portableOf(source, 'wilma-tools'), {
    lookup: {
      ...def('lookup', {description: 'v2', handler: portableHandler}),
      draft: def('lookup', {description: 'next', handler: portableHandler}),
    },
    plain: def('plain', {handler: portableHandler}),
    sketch: {...def('sketch', {handler: portableHandler}), unpublished: true},
  });

  const handler = connectorHandler('t1');
  assert.deepEqual(calls, [
    ['POST', `${WILMA}/v2/tools`, def('lookup', {description: 'v2', handler})],
    ['POST', `${T('n00000000001')}/versions`, {changelog, revision: 0}],
    ['PUT', T('n00000000001'), {...def('lookup', {description: 'next', handler}), revision: 0}],
    ['POST', `${WILMA}/v2/tools`, def('plain', {handler})],
    ['POST', `${T('n00000000002')}/versions`, {changelog, revision: 0}],
    ['POST', `${WILMA}/v2/tools`, def('sketch', {handler})],
  ]);
  assert.equal(CHANGELOG, changelog);
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.id, r.version]),
    [
      ['wilma-tools/lookup', 'create', 'n00000000001', 1],
      ['wilma-tools/plain', 'create', 'n00000000002', 1],
      ['wilma-tools/sketch', 'create', 'n00000000003', undefined],
    ],
  );
});

test('existing tool overwritten: put → publish', async () => {
  const f = company(
    toolsState([
      {id: 'x1', published: def('lookup', {description: 'v2'})},
      {id: 'x2', draft: def('sketch', {description: 'new'})},
    ]),
    toolsState([
      {id: 'T1', published: def('lookup', {description: 'old'}), version: 1, revision: 5},
      {id: 'T2', draft: def('sketch', {description: 'old'}), revision: 2},
    ]),
  );
  const {plan, results, calls} = await transferObjects(f);
  assert.deepEqual(
    plan.items.map((i) => [i.name, i.state]),
    [
      ['lookup', 'differs'],
      ['sketch', 'differs'],
    ],
  );
  assert.deepEqual(calls, [
    ['GET', T('T1')],
    ['PUT', T('T1'), {...def('lookup', {description: 'v2'}), revision: 5}],
    ['POST', `${T('T1')}/versions`, {changelog, revision: 6}],
    ['GET', T('T2')],
    ['PUT', T('T2'), {...def('sketch', {description: 'new'}), revision: 2}],
  ]);
  assert.deepEqual(
    results.map((r) => [r.action, r.id, r.version]),
    [
      ['overwrite', 'T1', 2],
      ['overwrite', 'T2', undefined],
    ],
  );
});

test('409 retried once', async () => {
  const x = () => toolsState([{id: 'x1', published: def('lookup', {description: 'v2'})}]);
  const y = () => toolsState([{id: 'T1', published: def('lookup', {description: 'old'}), version: 1, revision: 5}]);
  // Someone else changes the tool on the target just before each of the first `times` publishes.
  const racing = (state, times) => (real) => ({
    ...real,
    async call(method, path, opts) {
      if (method === 'POST' && path.endsWith('/versions') && times-- > 0) state.tools[0].revision += 1;
      return real.call(method, path, opts);
    },
  });

  const target = y();
  const f = company(x(), target);
  const once = await transferObjects(f, {wrap: racing(target, 1)});
  assert.deepEqual(once.calls, [
    ['GET', T('T1')],
    ['PUT', T('T1'), {...def('lookup', {description: 'v2'}), revision: 5}],
    ['POST', `${T('T1')}/versions`, {changelog, revision: 6}],
    ['GET', T('T1')],
    ['POST', `${T('T1')}/versions`, {changelog, revision: 7}],
  ]);
  assert.deepEqual(
    once.results.map((r) => [r.action, r.id, r.version]),
    [['overwrite', 'T1', 2]],
  );

  const target2 = y();
  const f2 = company(x(), target2);
  const twice = await transferObjects(f2, {wrap: racing(target2, 2)});
  assert.deepEqual(twice.calls.slice(2), [
    ['POST', `${T('T1')}/versions`, {changelog, revision: 6}],
    ['GET', T('T1')],
    ['POST', `${T('T1')}/versions`, {changelog, revision: 7}],
  ]);
  assert.deepEqual(twice.results, [
    {key: 'wilma-tools/lookup', action: 'failed', stage: 'publish', id: 'T1', error: 'publish was refused (HTTP 409)'},
  ]);
});

test('a refused step names its stage and HTTP status, never the answer', async () => {
  const f = company(toolsState([{id: 'x1', published: def('lookup', {handler: mcpHandler()})}]));
  const refusing = (real) => ({
    ...real,
    async call(method, path, opts) {
      if (path.endsWith('/versions')) {
        const e = new Error(`wilma answered 400: bad handler ${JSON.stringify(opts.json)} ${HEADER}`);
        e.status = 400;
        throw e;
      }
      return real.call(method, path, opts);
    },
  });
  const {results} = await transferObjects(f, {
    wrap: refusing,
    secrets: {'wilma-tools/lookup': {[HEADER_PATH]: HEADER}},
  });
  assert.deepEqual(results, [
    {
      key: 'wilma-tools/lookup',
      action: 'failed',
      stage: 'publish',
      id: 'n00000000001',
      error: 'publish was refused (HTTP 400)',
    },
  ]);
});

test('custom header asked, empty skips the tool and its dependents', async () => {
  const f = company(
    toolsState([
      {id: 'x1', published: def('mcp-server', {handler: mcpHandler()})},
      {id: 'x2', published: def('search', {handler: mcpToolHandler('x1')})},
    ]),
  );
  const {source, plan, results, calls} = await transferObjects(f);
  assert.deepEqual(portableOf(source, 'wilma-tools'), {
    'mcp-server': def('mcp-server', {handler: mcpHandler({'X-Api-Key': {$secret: HEADER_PATH}})}),
    search: def('search', {
      handler: {mcpTool: {mcpToolId: {$ref: 'wilma-tools/mcp-server', as: 'id'}, mcpToolName: 'search'}},
    }),
  });
  assert.deepEqual(results, [
    {key: 'wilma-tools/mcp-server', action: 'skip', because: `no secret: ${HEADER_PATH}`},
    {key: 'wilma-tools/search', action: 'skip', because: 'wilma-tools/mcp-server'},
  ]);
  assert.deepEqual(calls, []);
  for (const x of [source, plan, results]) assert.doesNotMatch(JSON.stringify(x), new RegExp(HEADER));
});

test('tool pointing at another tool is written after it', async () => {
  const f = company(
    toolsState([
      {id: 'x2', published: def('search', {handler: mcpToolHandler('x1')})},
      {
        id: 'x1',
        published: def('mcp-server', {handler: mcpHandler()}),
        draft: def('mcp-server', {description: 'next', handler: mcpHandler()}),
      },
    ]),
  );
  const secrets = {'wilma-tools/mcp-server': {[HEADER_PATH]: HEADER}};
  const {source, plan, results, calls} = await transferObjects(f, {secrets});
  // One header in the published definition and the draft: one secret, asked once.
  assert.deepEqual(portableOf(source, 'wilma-tools')['mcp-server'].draft.handler.mcp.authorization.customHeaders, {
    'X-Api-Key': {$secret: HEADER_PATH},
  });
  assert.deepEqual(
    plan.items.map((i) => i.name),
    ['search', 'mcp-server'],
  );
  assert.deepEqual(calls, [
    ['POST', `${WILMA}/v2/tools`, def('mcp-server', {handler: mcpHandler()})],
    ['POST', `${T('n00000000001')}/versions`, {changelog, revision: 0}],
    ['PUT', T('n00000000001'), {...def('mcp-server', {description: 'next', handler: mcpHandler()}), revision: 0}],
    ['POST', `${WILMA}/v2/tools`, def('search', {handler: mcpToolHandler('n00000000001')})],
    ['POST', `${T('n00000000002')}/versions`, {changelog, revision: 0}],
  ]);
  assert.deepEqual(
    results.map((r) => [r.key, r.action]),
    [
      ['wilma-tools/mcp-server', 'create'],
      ['wilma-tools/search', 'create'],
    ],
  );
  for (const x of [plan, results]) assert.doesNotMatch(JSON.stringify(x), new RegExp(HEADER));
});

test('connectors: created and overwritten in place, references to connections and secrets', async () => {
  const connector = (name, extra = {}) => ({
    name,
    description: 'd',
    definition: {key: 'webhook', version: 2},
    configuration: {url: 'https://hooks.example/in'},
    grant: {read: {}},
    ...extra,
  });
  const f = company(
    {
      connections: [conn('c1', 'github-team')],
      secrets: [secret('s1', 'hook_key')],
      connectors: [
        {
          id: 'k1',
          companyId: 'it',
          revision: 1,
          ...connector('hooks', {authorization: {shared: {connection: {id: 'c1'}}}}),
        },
        {
          id: 'k2',
          companyId: 'it',
          revision: 1,
          ...connector('crm', {description: 'new', configuration: {apiKey: {secret: {id: 's1'}, headerName: 'X-Key'}}}),
        },
      ],
    },
    {
      connections: [conn('t1', 'github-team')],
      secrets: [secret('u1', 'hook_key')],
      connectors: [{id: 'K2', companyId: 'it', revision: 4, ...connector('crm', {description: 'old'})}],
    },
  );
  const {source, results, calls} = await transferObjects(f, {secrets: {'wilma-secrets/hook_key': {value: 'v'}}});
  assert.deepEqual(portableOf(source, 'wilma-connectors'), {
    hooks: connector('hooks', {
      authorization: {shared: {connection: {id: {$ref: 'wilma-connections/github-team', as: 'id'}}}},
    }),
    crm: connector('crm', {
      description: 'new',
      configuration: {apiKey: {secret: {id: {$ref: 'wilma-secrets/hook_key', as: 'id'}}, headerName: 'X-Key'}},
    }),
  });
  const C = `${WILMA}/v2/tools/connectors`;
  assert.deepEqual(
    calls.filter(([, url]) => url.startsWith(C)),
    [
      ['POST', C, connector('hooks', {authorization: {shared: {connection: {id: 't1'}}}})],
      ['GET', `${C}/items/K2`],
      [
        'PUT',
        `${C}/items/K2`,
        {
          ...connector('crm', {description: 'new', configuration: {apiKey: {secret: {id: 'u1'}, headerName: 'X-Key'}}}),
          revision: 4,
        },
      ],
    ],
  );
  assert.deepEqual(
    results.filter((r) => r.key.startsWith('wilma-connectors/')).map((r) => [r.key, r.action, r.id, r.version]),
    [
      ['wilma-connectors/hooks', 'create', 'n00000000001', undefined],
      ['wilma-connectors/crm', 'overwrite', 'K2', undefined],
    ],
  );
});

test('a secret held as secretId in a connector configuration (webhook auth) is a reference, in tools and connectors', async () => {
  // The webhook connector's configuration (a Document, validated by the definition's schema) names its auth secret
  // as a plain string: configuration.auth.secretId.
  const webhook = (secretId) => ({
    definition: {key: 'webhook', version: 2},
    configuration: {url: 'https://hooks.example/in', auth: {type: 'bearer', secretId}},
  });
  const f = company(
    {
      secrets: [secret('s1', 'hook_key')],
      connectors: [{id: 'k1', companyId: 'it', revision: 1, name: 'hooks', description: 'd', ...webhook('s1')}],
      ...toolsState([{id: 'x1', published: def('notify', {handler: {connector: {...webhook('s1'), toolId: 'post'}}})}]),
    },
    {secrets: [secret('u1', 'hook_key')]},
  );
  const {source, plan, calls} = await transferObjects(f);
  const ref = {$ref: 'wilma-secrets/hook_key', as: 'id'};
  assert.deepEqual(portableOf(source, 'wilma-tools').notify.handler.connector.configuration.auth, {
    type: 'bearer',
    secretId: ref,
  });
  assert.deepEqual(portableOf(source, 'wilma-connectors').hooks.configuration.auth, {type: 'bearer', secretId: ref});
  assert.ok(!JSON.stringify(source.kinds).includes('"s1"'));
  for (const key of ['wilma-tools/notify', 'wilma-connectors/hooks'])
    assert.ok(
      plan.items.find((i) => i.key === key).needs.includes('wilma-secrets/hook_key'),
      `${key} needs the secret`,
    );
  assert.deepEqual(
    calls.filter(([m, url]) => m === 'POST' && !url.endsWith('/versions')).map(([, url, body]) => [url, body]),
    [
      [`${WILMA}/v2/tools/connectors`, {name: 'hooks', description: 'd', ...webhook('u1')}],
      [`${WILMA}/v2/tools`, def('notify', {handler: {connector: {...webhook('u1'), toolId: 'post'}}})],
    ],
  );
});

test('versioned chain: deploy at 100% only when the option says so', async () => {
  const f = company({}, {});
  const client = (await f.clients('b')).wilma;
  const write = versionedWrite(WILMA_API.agents, {deploy: (data) => data.deploy === true});
  const A = `${WILMA}/v2/agents/agents`;
  const data = {name: 'bot', description: 'x', deploy: true, draft: {name: 'bot', description: 'y'}};
  const mark = f.calls.length;
  const answer = await write(client, {key: 'wilma-agents/bot', name: 'bot', data}, data, {existing: undefined});
  assert.deepEqual(answer, {id: 'n00000000001', version: 1, steps: ['create', 'publish', 'deploy', 'draft']});
  const callsSince = (at) =>
    f.calls.slice(at).map((c) => [c.method, `${WILMA}${c.path}`, ...(c.body === undefined ? [] : [c.body])]);
  assert.deepEqual(callsSince(mark), [
    ['POST', A, {name: 'bot', description: 'x'}],
    ['POST', `${A}/n00000000001/versions`, {changelog, revision: 0}],
    ['PUT', `${A}/n00000000001/deployment`, {deployment: [{version: 1, percentage: 100}]}],
    ['PUT', `${A}/n00000000001`, {name: 'bot', description: 'y', revision: 0}],
  ]);

  const quiet = {name: 'bot2', description: 'x', deploy: false};
  const mark2 = f.calls.length;
  const second = await write(client, {key: 'wilma-agents/bot2', name: 'bot2', data: quiet}, quiet, {
    existing: undefined,
  });
  assert.deepEqual(second.steps, ['create', 'publish']);
  assert.deepEqual(
    callsSince(mark2).map(([m, u]) => [m, u]),
    [
      ['POST', A],
      ['POST', `${A}/n00000000002/versions`],
    ],
  );
});

test('nothing to publish: the target keeps its latest version, the draft is still written', async () => {
  const f = company(
    toolsState([
      {id: 'x1', published: def('lookup', {description: 'v2'}), draft: def('lookup', {description: 'next'})},
    ]),
    toolsState([
      {
        id: 'T1',
        published: def('lookup', {description: 'v2'}),
        draft: def('lookup', {description: 'old'}),
        version: 4,
        revision: 5,
      },
    ]),
  );
  const {plan, results, calls} = await transferObjects(f);
  assert.deepEqual(plan.items[0].paths, ['draft.description']);
  assert.deepEqual(calls, [
    ['GET', T('T1')],
    ['PUT', T('T1'), {...def('lookup', {description: 'v2'}), revision: 5}],
    ['POST', `${T('T1')}/versions`, {changelog, revision: 6}],
    ['PUT', T('T1'), {...def('lookup', {description: 'next'}), revision: 6}],
  ]);
  assert.deepEqual(results, [
    {
      key: 'wilma-tools/lookup',
      action: 'overwrite',
      id: 'T1',
      version: 4,
      steps: ['update', 'nothing to publish', 'draft'],
    },
  ]);
});

// Skills and agents. Versioned objects of any collection, as toolsState makes tools.
function versionedState(coll, idKey, specs) {
  const objects = [];
  const versions = {};
  for (const {id, published, draft = published, version = 2, revision = 3} of specs) {
    objects.push({
      id,
      companyId: 'it',
      ...draft,
      status: published ? 'active' : 'draft',
      revision,
      ...(published ? {latestVersion: version} : {}),
    });
    if (published) versions[id] = [{[idKey]: id, version, changelog: 'old', definition: {id, ...published}}];
  }
  return {[coll]: objects, versions};
}
const merged = (...states) => {
  const out = {versions: {}};
  for (const s of states)
    for (const [k, v] of Object.entries(s))
      if (k === 'versions') Object.assign(out.versions, v);
      else out[k] = Array.isArray(v) ? [...(out[k] ?? []), ...v] : v;
  return out;
};
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const S = (id) => `${WILMA}/v2/skills/items/${id}`;
const A = (id) => `${WILMA}/v2/agents/agents${id ? `/${id}` : ''}`;
const skillDef = (name, extra = {}) => ({name, description: 'd', content: '# Steps', ...extra});
const file = (id, path, extra = {}) => ({id, path, name: path.split('/').at(-1), size: 5, ...extra});
const download = (id, bytes) => ({[id]: {url: `https://download.example/${id}`, bytes: Buffer.from(bytes)}});

// Source it_x → plan against it_y → apply everything, with objects of other kinds (lookups, PBX) added to the
// snapshots as given; calls: every call to the Wilma of it_y during the apply.
async function run(f, kinds, {secrets = {}, wrap = (c) => c, source: more = {}, target: theirs = {}} = {}) {
  const snapshot = {...(await readKinds(await f.clients('a'), kinds)), ...more};
  const source = toPortable(snapshot, {serial: f.serial('a'), host: f.host('a'), company: 'it_x'});
  const b = await f.clients('b');
  const clients = {...b, wilma: wrap(b.wilma)};
  const target = {...(await readKinds(clients, kinds)), ...theirs};
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const mark = f.calls.length;
  const results = await applyPlan(clients, plan, new Set(plan.items.map((i) => i.key)), {secrets});
  const calls = f.calls
    .slice(mark)
    .filter((c) => c.company === 'it_y' && c.service === 'wilma')
    .map((c) => [c.method, `${WILMA}${c.path}`, ...(c.body === undefined ? [] : [c.body])]);
  return {snapshot, source, plan, results, calls};
}

test('skill with a file: exported bytes and sha256, uploaded on import', async () => {
  const bytes = 'hello';
  const f = company(
    merged(toolsState([{id: 'x1', published: def('lookup')}]), {
      ...versionedState('skills', 'skillId', [
        {
          id: 'k1',
          published: skillDef('faq', {
            tools: [{tool: {id: 'x1', description: 'find'}}],
            files: [file('f1', 'refs/a.md', {executable: false})],
          }),
        },
      ]),
      files: download('f1', bytes),
    }),
    toolsState([{id: 'T1', published: def('lookup')}]),
  );
  const {snapshot, source, plan, results, calls} = await run(f, ['wilma-tools', 'wilma-skills']);
  const $file = 'files/wilma-skills/faq/refs/a.md';
  const marker = {$file, sha256: sha(bytes), path: 'refs/a.md', name: 'a.md', executable: false};
  assert.deepEqual(snapshot['wilma-skills'][0].files, {[$file]: Buffer.from(bytes)});
  assert.deepEqual(source.kinds['wilma-skills'], [
    {
      name: 'faq',
      data: skillDef('faq', {
        tools: [{tool: {id: {$ref: 'wilma-tools/lookup', as: 'id'}, description: 'find'}}],
        files: [marker],
      }),
      files: {[$file]: Buffer.from(bytes)},
    },
  ]);
  assert.deepEqual(plan.items.find((i) => i.kind === 'wilma-skills').files, {[$file]: Buffer.from(bytes)});

  assert.deepEqual(calls, [
    ['POST', `${WILMA}/v2/skills/files`, {name: 'a.md', size: 5}],
    [
      'POST',
      `${WILMA}/v2/skills`,
      skillDef('faq', {
        tools: [{tool: {id: 'T1', description: 'find'}}],
        files: [{id: 'n00000000001', path: 'refs/a.md', name: 'a.md', executable: false}],
      }),
    ],
    ['POST', `${S('n00000000002')}/versions`, {changelog, revision: 0}],
  ]);
  assert.deepEqual(
    f.uploads.map((u) => [u.path, Buffer.from(u.body).toString()]),
    [['/n00000000001', bytes]],
  );
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.id, r.version]),
    [['wilma-skills/faq', 'create', 'n00000000002', 1]],
  );
});

test('unchanged skill file is not uploaded again', async () => {
  const f = company(
    {
      ...versionedState('skills', 'skillId', [
        {
          id: 'k1',
          published: skillDef('faq', {
            description: 'new',
            files: [file('f1', 'refs/a.md'), file('f2', 'refs/c.md')],
          }),
        },
      ]),
      files: {...download('f1', 'same'), ...download('f2', 'added')},
    },
    {
      ...versionedState('skills', 'skillId', [
        {
          id: 'K9',
          published: skillDef('faq', {description: 'old', files: [file('g1', 'refs/a.md'), file('g2', 'refs/b.md')]}),
          version: 4,
          revision: 6,
        },
      ]),
      files: {...download('g1', 'same'), ...download('g2', 'gone')},
    },
  );
  const {plan, results, calls} = await run(f, ['wilma-skills']);
  assert.equal(plan.items[0].state, 'differs');
  assert.deepEqual(calls, [
    ['POST', `${WILMA}/v2/skills/files`, {name: 'c.md', size: 5}],
    ['GET', S('K9')],
    [
      'PUT',
      S('K9'),
      {
        ...skillDef('faq', {
          description: 'new',
          files: [
            {id: 'g1', path: 'refs/a.md', name: 'a.md'},
            {id: 'n00000000001', path: 'refs/c.md', name: 'c.md'},
          ],
        }),
        revision: 6,
      },
    ],
    ['POST', `${S('K9')}/versions`, {changelog, revision: 7}],
  ]);
  assert.deepEqual(
    f.uploads.map((u) => Buffer.from(u.body).toString()),
    ['added'],
  );
  assert.deepEqual(
    results.map((r) => [r.action, r.id, r.version]),
    [['overwrite', 'K9', 2]],
  );
});

test('a skill file whose upload is refused fails the skill at stage upload, with the status only', async () => {
  const f = company(
    {
      ...versionedState('skills', 'skillId', [{id: 'k1', published: skillDef('faq', {files: [file('f1', 'a.md')]})}]),
      files: download('f1', 'bytes'),
    },
    versionedState('skills', 'skillId', [{id: 'K9', published: skillDef('faq', {description: 'old'}), revision: 1}]),
  );
  const refusing = (real) => ({
    ...real,
    raw: async (method, url, opts) =>
      method === 'PUT'
        ? new Response('<Error>bucket says no with bytes</Error>', {status: 403})
        : real.raw(method, url, opts),
  });
  const {results, calls} = await run(f, ['wilma-skills'], {wrap: refusing});
  assert.deepEqual(results, [
    {key: 'wilma-skills/faq', action: 'failed', stage: 'upload', id: 'K9', error: 'upload was refused (HTTP 403)'},
  ]);
  assert.deepEqual(calls, [['POST', `${WILMA}/v2/skills/files`, {name: 'a.md', size: 5}]]);
});

test('a skill whose file path leaves its folder is not read', async () => {
  const f = company(
    {
      ...versionedState('skills', 'skillId', [
        {id: 'k1', published: skillDef('faq', {files: [file('f1', 'a/../../x')]})},
      ]),
      files: download('f1', 'bytes'),
    },
    {},
  );
  const snapshot = await readKinds(await f.clients('a'), ['wilma-skills']);
  assert.match(snapshot['wilma-skills'].error, /Not a path of a skill file: a\/\.\.\/\.\.\/x/);
});

test('a draft file that differs from the published one has its own place in the folder', async () => {
  const f = company(
    {
      ...versionedState('skills', 'skillId', [
        {
          id: 'k1',
          published: skillDef('faq', {files: [file('f1', 'a.md'), file('f2', 'b.md')]}),
          draft: skillDef('faq', {files: [file('f1', 'a.md'), file('f3', 'b.md')]}),
        },
      ]),
      files: {...download('f1', 'one'), ...download('f2', 'two'), ...download('f3', 'TWO')},
    },
    {},
  );
  const {source, calls} = await run(f, ['wilma-skills']);
  const [o] = source.kinds['wilma-skills'];
  assert.deepEqual(
    o.data.files.map((m) => m.$file),
    ['files/wilma-skills/faq/a.md', 'files/wilma-skills/faq/b.md'],
  );
  assert.deepEqual(
    o.data.draft.files.map((m) => m.$file),
    ['files/wilma-skills/faq/a.md', 'files/wilma-skills/faq@draft/b.md'],
  );
  assert.deepEqual(
    Object.entries(o.files).map(([k, v]) => [k, v.toString()]),
    [
      ['files/wilma-skills/faq/a.md', 'one'],
      ['files/wilma-skills/faq/b.md', 'two'],
      ['files/wilma-skills/faq@draft/b.md', 'TWO'],
    ],
  );
  // Three uploads: each content once.
  assert.deepEqual(
    calls.filter(([m, u]) => m === 'POST' && u.endsWith('/v2/skills/files')).map((c) => c[2].name),
    ['a.md', 'b.md', 'b.md'],
  );
  assert.deepEqual(calls.at(-1), [
    'PUT',
    S('n00000000004'),
    {
      ...skillDef('faq', {
        files: [
          {id: 'n00000000001', path: 'a.md', name: 'a.md'},
          {id: 'n00000000003', path: 'b.md', name: 'b.md'},
        ],
      }),
      revision: 0,
    },
  ]);
});

test('a skill name used twice on the source or on the target is blocked', async () => {
  const f = company(
    versionedState('skills', 'skillId', [
      {id: 'k1', published: skillDef('faq')},
      {id: 'k2', published: skillDef('faq', {description: 'other'})},
      {id: 'k3', published: skillDef('howto')},
    ]),
    versionedState('skills', 'skillId', [
      {id: 'K1', published: skillDef('howto', {description: 'one'})},
      {id: 'K2', published: skillDef('howto', {description: 'two'})},
    ]),
  );
  const {plan, results} = await run(f, ['wilma-skills']);
  assert.deepEqual(
    plan.items.map((i) => [i.key, i.state, i.reason]),
    [
      ['wilma-skills/faq', 'blocked', 'two objects named faq in the export'],
      ['wilma-skills/faq', 'blocked', 'two objects named faq in the export'],
      ['wilma-skills/howto', 'blocked', 'two objects named howto on b.wildixin.com'],
    ],
  );
  assert.deepEqual(results, []);
});

// Agents.
const agentDef = (name, engine, extra = {}) => ({name, description: 'd', channels: {}, engine, ...extra});
const ai = (extra = {}) => ({ai: {instructions: 'Help', ...extra}});
const agentsState = (specs, deployments = {}) => ({...versionedState('agents', 'agentId', specs), deployments});

test('agent ↔ agent written in two passes, published after', async () => {
  const f = company(
    agentsState([
      {id: 'ag0000000001', published: agentDef('front', ai({capabilities: [{agent: {agentId: 'ag0000000002'}}]}))},
      {
        id: 'ag0000000002',
        published: agentDef('back', ai({capabilities: [{handover: {variant: 'agent', agent: 'ag0000000001'}}]})),
      },
    ]),
  );
  const {source, results, calls} = await run(f, ['wilma-agents']);
  assert.deepEqual(portableOf(source, 'wilma-agents'), {
    front: {
      ...agentDef('front', ai({capabilities: [{agent: {agentId: {$ref: 'wilma-agents/back', as: 'id'}}}]})),
      deploy: false,
    },
    back: {
      ...agentDef(
        'back',
        ai({capabilities: [{handover: {variant: 'agent', agent: {$ref: 'wilma-agents/front', as: 'id'}}}]}),
      ),
      deploy: false,
    },
  });
  const bare = (name) => ({name, description: 'd', channels: {}, engine: {ai: {instructions: 'Help'}}});
  assert.deepEqual(calls, [
    ['POST', A(), bare('front')],
    ['POST', A(), bare('back')],
    ['GET', A('n00000000001')],
    [
      'PUT',
      A('n00000000001'),
      {...agentDef('front', ai({capabilities: [{agent: {agentId: 'n00000000002'}}]})), revision: 0},
    ],
    ['POST', `${A('n00000000001')}/versions`, {changelog, revision: 1}],
    ['GET', A('n00000000002')],
    [
      'PUT',
      A('n00000000002'),
      {
        ...agentDef('back', ai({capabilities: [{handover: {variant: 'agent', agent: 'n00000000001'}}]})),
        revision: 0,
      },
    ],
    ['POST', `${A('n00000000002')}/versions`, {changelog, revision: 1}],
  ]);
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.id, r.version]),
    [
      ['wilma-agents/front', 'create', 'n00000000001', 1],
      ['wilma-agents/back', 'create', 'n00000000002', 1],
    ],
  );
});

test('agent refs to PBX acl group and dialplan resolve on the target PBX', async () => {
  const pbx = (group, dialplan) => ({
    '/PBX/AclGroups/': [{id: group, name: 'Support', inherits: null, rules: [], adminRules: []}],
    '/PBX/Dialplans/': [{id: dialplan, name: 'users', description: '', includedDialplans: [], numbers: []}],
  });
  const published = agentDef(
    'desk',
    ai({capabilities: [{transfer: {variant: 'predefined', context: 'users', extension: '201'}}]}),
    {
      channels: {voice: {backgroundSound: {enabled: true, sound: 'jazz'}}},
      settings: {pbxGroupId: '7'},
      access: {visibility: 'explicit', grants: [{groupId: '7'}, {userId: 'u1'}, {department: 'Sales'}]},
    },
  );
  const f = fakeCompany({
    pbxs: {a: {company: 'it_x', pbx: pbx('7', '3')}, b: {company: 'it_y', pbx: pbx('12', '9')}},
    clouds: {it_x: {wilma: agentsState([{id: 'ag0000000001', published}])}, it_y: {wilma: {}}},
  });
  const {snapshot, source, plan, results, calls} = await run(f, ['acl-groups', 'dialplans', 'wilma-agents'], {
    source: {'xbees-users': [{id: 'u1', name: 'ann@x.example', data: {}}]},
    target: {'xbees-users': [{id: 'u9', name: 'ann@x.example', data: {}}]},
  });
  assert.deepEqual(TRANSFER_KINDS['wilma-agents'].userIds(snapshot['wilma-agents'][0].data), ['u1']);
  const data = portableOf(source, 'wilma-agents').desk;
  assert.deepEqual(data.settings, {pbxGroupId: {$ref: 'acl-groups/Support', as: 'id'}});
  assert.deepEqual(data.access.grants, [
    {groupId: {$ref: 'acl-groups/Support', as: 'id'}},
    {userId: {$ref: 'xbees-users/ann@x.example', as: 'id'}},
    {department: 'Sales'},
  ]);
  assert.deepEqual(data.engine.ai.capabilities, [
    {transfer: {variant: 'predefined', context: {$ref: 'dialplans/users', as: 'name'}, extension: '201'}},
  ]);
  assert.deepEqual(source.soft, {'wilma-agents/desk': ['users/201']});
  assert.deepEqual(source.outside, [
    {
      kind: 'moh',
      name: 'desk',
      path: 'channels.voice.backgroundSound.sound',
      value: 'jazz',
      from: 'wilma-agents/desk',
    },
  ]);
  const item = plan.items.find((i) => i.kind === 'wilma-agents');
  assert.equal(item.state, 'new');
  assert.deepEqual(
    item.warnings.map((w) => [w.type, w.value]),
    [
      ['not-checked', 'jazz'],
      ['not-checked', '201'],
    ],
  );
  const body = {
    ...published,
    settings: {pbxGroupId: '12'},
    access: {visibility: 'explicit', grants: [{groupId: '12'}, {userId: 'u9'}, {department: 'Sales'}]},
  };
  assert.deepEqual(calls.slice(2), [
    ['PUT', A('n00000000001'), {...body, revision: 0}],
    ['POST', `${A('n00000000001')}/versions`, {changelog, revision: 1}],
  ]);
  assert.deepEqual(
    results.map((r) => [r.key, r.action]),
    [
      ['acl-groups/Support', 'same'],
      ['dialplans/users', 'same'],
      ['wilma-agents/desk', 'create'],
    ].filter(([k]) => k.startsWith('wilma')),
  );
});

test('agent references to tools, skills, connectors, knowledge bases, services and secrets; version pins', async () => {
  const voice = (id) => `elevenlabs://v1?model=m&apiKey=secrets:${id}`;
  const concierge = agentDef(
    'concierge',
    ai({
      skills: [{id: 'k1', skillVersion: 3}],
      capabilities: [
        {tool: {id: 'x1', toolVersion: 2}},
        {tool: {id: 'x1', toolVersion: 1}},
        {connector: {id: 'c1'}},
        {kb: {knowledgeBaseId: 'kb1'}},
        {sandbox: {snapshot: {snapshotId: 'snap-1'}}},
        {handover: {variant: 'service', service: 'svc-1'}},
        {delegation: {id: 'ag0000000002', agentVersion: 1}},
      ],
      workflow: {
        entry: 's1',
        steps: [
          {id: 's1', label: 'Look up', handler: {action: {capability: {tool: {id: 'x1'}}}}},
          {id: 's2', label: 'Talk', handler: {conversation: {goal: 'g', capabilities: [{connector: {id: 'c1'}}]}}},
        ],
      },
    }),
    {channels: {voice: {speech: {languages: [{code: 'en-US', voice: voice('S1')}]}}}},
  );
  const connector = (id) => ({id, name: 'crm', definition: {key: 'webhook', version: 1}, revision: 1});
  const f = company(
    merged(
      {secrets: [secret('S1', 'eleven')], connectors: [connector('c1')]},
      toolsState([{id: 'x1', published: def('lookup')}]),
      versionedState('skills', 'skillId', [{id: 'k1', published: skillDef('faq'), version: 3}]),
      agentsState([
        {id: 'ag0000000001', published: concierge},
        {id: 'ag0000000002', published: agentDef('helper', ai()), version: 1},
      ]),
    ),
    merged(
      {secrets: [secret('Z1', 'eleven')], connectors: [connector('C9')]},
      toolsState([{id: 'T1', published: def('lookup'), version: 5}]),
      versionedState('skills', 'skillId', [{id: 'K1', published: skillDef('faq'), version: 7}]),
    ),
  );
  const kb = (id) => ({id, name: 'Docs', data: {name: 'Docs'}});
  const service = (id) => ({id, name: 'Sales', value: {id, uri: `services/${id}`}, data: {}});
  const {source, plan, results, calls} = await run(
    f,
    ['wilma-secrets', 'wilma-connectors', 'wilma-tools', 'wilma-skills', 'wilma-agents'],
    {
      source: {'kb-bases': [kb('kb1')], 'xbees-services': [service('svc-1')]},
      target: {'kb-bases': [kb('KB9')], 'xbees-services': [service('svc-9')]},
    },
  );
  const data = portableOf(source, 'wilma-agents').concierge;
  const ref = (key, as = 'id') => ({$ref: key, as});
  assert.deepEqual(data.engine.ai.skills, [
    {id: ref('wilma-skills/faq'), skillVersion: ref('wilma-skills/faq', 'version')},
  ]);
  assert.deepEqual(data.engine.ai.capabilities, [
    {tool: {id: ref('wilma-tools/lookup'), toolVersion: ref('wilma-tools/lookup', 'version')}},
    {tool: {id: ref('wilma-tools/lookup')}},
    {connector: {id: ref('wilma-connectors/crm')}},
    {kb: {knowledgeBaseId: ref('kb-bases/Docs')}},
    {sandbox: {snapshot: {snapshotId: 'snap-1'}}},
    {handover: {variant: 'service', service: ref('xbees-services/Sales')}},
    {delegation: {id: ref('wilma-agents/helper'), agentVersion: ref('wilma-agents/helper', 'version')}},
  ]);
  assert.deepEqual(data.engine.ai.workflow.steps[0].handler.action.capability.tool.id, ref('wilma-tools/lookup'));
  assert.deepEqual(
    data.engine.ai.workflow.steps[1].handler.conversation.capabilities[0].connector.id,
    ref('wilma-connectors/crm'),
  );
  // $template: the secret reference inside the voice URI.
  assert.deepEqual(data.channels.voice.speech.languages[0].voice, {
    $template: 'elevenlabs://v1?model=m&apiKey=secrets:{0}',
    args: [ref('wilma-secrets/eleven')],
  });
  assert.deepEqual(source.unresolved, [
    {
      kind: 'wilma-agents',
      name: 'concierge',
      path: 'engine.ai.capabilities[4].sandbox.snapshot.snapshotId',
      value: 'snap-1',
    },
  ]);
  assert.deepEqual(
    plan.items.find((i) => i.key === 'wilma-agents/concierge').warnings.map((w) => [w.type, w.path]),
    [
      ['portable', 'engine.ai.capabilities[1].tool.toolVersion'],
      ['unresolved', 'engine.ai.capabilities[4].sandbox.snapshot.snapshotId'],
    ],
  );

  // helper first (concierge delegates to it); the version published in this run is the one pinned.
  const put = calls.find(([m, u]) => m === 'PUT' && u === A('n00000000002'));
  assert.deepEqual(put[2].engine.ai, {
    instructions: 'Help',
    skills: [{id: 'K1', skillVersion: 7}],
    capabilities: [
      {tool: {id: 'T1', toolVersion: 5}},
      {tool: {id: 'T1'}},
      {connector: {id: 'C9'}},
      {kb: {knowledgeBaseId: 'KB9'}},
      {sandbox: {snapshot: {snapshotId: 'snap-1'}}},
      {handover: {variant: 'service', service: 'svc-9'}},
      {delegation: {id: 'n00000000001', agentVersion: 1}},
    ],
    workflow: {
      entry: 's1',
      steps: [
        {id: 's1', label: 'Look up', handler: {action: {capability: {tool: {id: 'T1'}}}}},
        {id: 's2', label: 'Talk', handler: {conversation: {goal: 'g', capabilities: [{connector: {id: 'C9'}}]}}},
      ],
    },
  });
  assert.deepEqual(put[2].channels, {voice: {speech: {languages: [{code: 'en-US', voice: voice('Z1')}]}}});
  assert.deepEqual(
    results.map((r) => [r.key, r.action]),
    [
      ['wilma-agents/helper', 'create'],
      ['wilma-agents/concierge', 'create'],
    ],
  );
});

test('engines: a webhook secret is a reference, an SQS key is asked and skips the agent without it', async () => {
  const KEY = 'AKIA-sqs-key-1';
  const f = company(
    merged(
      {secrets: [secret('S1', 'hook')]},
      agentsState([
        {
          id: 'ag0000000001',
          published: agentDef('hooked', {webhook: {url: 'https://hooks.example/a', secret: {id: 'S1'}}}),
        },
        {
          id: 'ag0000000002',
          published: agentDef('queued', {sqs: {url: 'https://sqs.example/q', key: KEY, secret: {id: 'S1'}}}),
        },
      ]),
    ),
    {secrets: [secret('Z1', 'hook')]},
  );
  const kinds = ['wilma-secrets', 'wilma-agents'];
  const first = await run(f, kinds);
  const data = portableOf(first.source, 'wilma-agents');
  assert.deepEqual(data.hooked.engine.webhook.secret, {id: {$ref: 'wilma-secrets/hook', as: 'id'}});
  assert.deepEqual(data.queued.engine.sqs, {
    url: 'https://sqs.example/q',
    key: {$secret: 'engine.sqs.key'},
    secret: {id: {$ref: 'wilma-secrets/hook', as: 'id'}},
  });
  assert.deepEqual(
    first.results.map((r) => [r.key, r.action, r.because]),
    [
      // Known before anything is written (no placeholder for it): reported first.
      ['wilma-agents/queued', 'skip', 'no secret: engine.sqs.key'],
      ['wilma-agents/hooked', 'create', undefined],
    ],
  );
  const hooked = first.calls.find(([m, u]) => m === 'PUT' && u === A('n00000000001'));
  assert.deepEqual(hooked[2].engine, {webhook: {url: 'https://hooks.example/a', secret: {id: 'Z1'}}});

  const f2 = company(
    agentsState([
      {
        id: 'ag0000000002',
        published: agentDef('queued', {sqs: {url: 'https://sqs.example/q', key: KEY, secret: 'plain-sqs'}}),
      },
    ]),
  );
  const second = await run(f2, kinds, {
    secrets: {'wilma-agents/queued': {'engine.sqs.key': KEY, 'engine.sqs.secret': 'plain-sqs'}},
  });
  assert.deepEqual(portableOf(second.source, 'wilma-agents').queued.engine.sqs.secret, {$secret: 'engine.sqs.secret'});
  const queued = second.calls.find(([m]) => m === 'PUT');
  assert.deepEqual(queued[2].engine, {sqs: {url: 'https://sqs.example/q', key: KEY, secret: 'plain-sqs'}});
  assert.equal(JSON.stringify([second.source, second.plan, second.results]).includes(KEY), false);
});

test('a sandbox env value is asked, never in the export, the plan or the results; the draft asks it once', async () => {
  const ENV = 'env-secret-value-77';
  const sandbox = (description) =>
    agentDef('coder', ai({capabilities: [{sandbox: {inline: {size: 'small', env: [{name: 'API', value: ENV}]}}}]}), {
      description,
    });
  const f = company(agentsState([{id: 'ag0000000001', published: sandbox('v1'), draft: sandbox('next')}]));
  const path = 'engine.ai.capabilities[0].sandbox.inline.env[0].value';
  const {source, plan, results, calls} = await run(f, ['wilma-agents'], {
    secrets: {'wilma-agents/coder': {[path]: ENV}},
  });
  const data = portableOf(source, 'wilma-agents').coder;
  assert.deepEqual(data.engine.ai.capabilities[0].sandbox.inline.env, [{name: 'API', value: {$secret: path}}]);
  assert.deepEqual(data.draft.engine.ai.capabilities[0].sandbox.inline.env, [{name: 'API', value: {$secret: path}}]);
  assert.deepEqual(source.bound, []);
  assert.equal(JSON.stringify([source, plan, results]).includes(ENV), false);
  assert.deepEqual(
    results.map((r) => [r.action, r.id]),
    [['create', 'n00000000001']],
  );
  // Written to the target: in the published definition and in the draft.
  const puts = calls
    .filter(([m]) => m === 'PUT')
    .map((c) => c[2].engine.ai.capabilities[0].sandbox.inline.env[0].value);
  assert.deepEqual(puts, [ENV, ENV]);

  // Without the value: skipped, and nothing made on the target (no placeholder).
  const target = {};
  const f2 = company(agentsState([{id: 'ag0000000001', published: sandbox('v1')}]), target);
  const skipped = await run(f2, ['wilma-agents']);
  assert.deepEqual(skipped.results, [{key: 'wilma-agents/coder', action: 'skip', because: `no secret: ${path}`}]);
  assert.deepEqual(skipped.calls, []);
  assert.deepEqual(target.agents, []);
});

test('agent with default deployment is not deployed', async () => {
  const f = company(agentsState([{id: 'ag0000000001', published: agentDef('bot', ai())}], {ag0000000001: []}));
  const {source, calls} = await run(f, ['wilma-agents']);
  assert.equal(portableOf(source, 'wilma-agents').bot.deploy, false);
  assert.deepEqual(
    calls.map(([m, u]) => [m, u]),
    [
      ['POST', A()],
      ['GET', A('n00000000001')],
      ['PUT', A('n00000000001')],
      ['POST', `${A('n00000000001')}/versions`],
    ],
  );
});

test('agent with deployment is deployed at 100%', async () => {
  const deployed = {
    ag0000000001: [
      {version: 2, percentage: 60},
      {version: 1, percentage: 40},
    ],
  };
  const f = company(
    agentsState([{id: 'ag0000000001', published: agentDef('bot', ai({model: 'default'}))}], deployed),
    agentsState([{id: 'AG9', published: agentDef('bot', ai()), version: 4, revision: 2}]),
  );
  const {source, plan, results, calls} = await run(f, ['wilma-agents']);
  assert.equal(portableOf(source, 'wilma-agents').bot.deploy, true);
  assert.equal(plan.items[0].deploys, true);
  assert.deepEqual(calls, [
    ['GET', A('AG9')],
    ['PUT', A('AG9'), {...agentDef('bot', ai({model: 'default'})), revision: 2}],
    ['POST', `${A('AG9')}/versions`, {changelog, revision: 3}],
    ['PUT', `${A('AG9')}/deployment`, {deployment: [{version: 2, percentage: 100}]}],
  ]);
  assert.deepEqual(
    results.map((r) => [r.action, r.id, r.version]),
    [['overwrite', 'AG9', 2]],
  );
});

test('re-run after publish failure overwrites, does not duplicate', async () => {
  const target = {};
  const f = company(agentsState([{id: 'ag0000000001', published: agentDef('bot', ai())}]), target);
  const failing = (real) => ({
    ...real,
    async call(method, path, opts) {
      if (method === 'POST' && path.endsWith('/versions')) {
        const e = new Error('wilma answered 500: the definition is {"secret": "x"}');
        e.status = 500;
        throw e;
      }
      return real.call(method, path, opts);
    },
  });
  const first = await run(f, ['wilma-agents'], {wrap: failing});
  // Made in the first pass, never published: bare, as apply says of an object it could not finish.
  assert.deepEqual(first.results, [
    {
      key: 'wilma-agents/bot',
      action: 'failed',
      stage: 'publish',
      id: 'n00000000001',
      error: 'publish was refused (HTTP 500)',
      bare: true,
    },
  ]);
  assert.equal(target.agents.length, 1);
  assert.equal(target.agents[0].latestVersion, undefined);

  const second = await run(f, ['wilma-agents']);
  assert.equal(second.plan.items[0].state, 'differs');
  assert.deepEqual(
    second.calls.map(([m, u]) => [m, u]),
    [
      ['GET', A('n00000000001')],
      ['PUT', A('n00000000001')],
      ['POST', `${A('n00000000001')}/versions`],
    ],
  );
  assert.deepEqual(
    second.results.map((r) => [r.action, r.id, r.version]),
    [['overwrite', 'n00000000001', 1]],
  );
  assert.equal(target.agents.length, 1);
  assert.equal(target.agents[0].latestVersion, 1);
});

test('built-in agents are not read', async () => {
  const f = company(
    agentsState([
      {id: 'wilma-system', published: agentDef('Wilma', ai())},
      {id: 'wms-00000000', published: agentDef('WMS', ai())},
      {id: 'ag0000000001', published: agentDef('mine', ai())},
    ]),
  );
  const mark = f.calls.length;
  const snapshot = await readKinds(await f.clients('a'), ['wilma-agents']);
  assert.deepEqual(
    snapshot['wilma-agents'].map((o) => o.name),
    ['mine'],
  );
  assert.deepEqual(
    f.calls
      .slice(mark)
      .filter((c) => c.service === 'wilma')
      .map((c) => [c.method, c.path]),
    [
      ['GET', '/v2/agents/agents'],
      ['GET', '/v2/agents/agents/ag0000000001'],
      ['GET', '/v2/agents/agents/ag0000000001/versions/2'],
      ['GET', '/v2/agents/agents/ag0000000001/deployment'],
    ],
  );
});

test('voice transfer targets (silence timeout, maximum duration) go to a dialplan of the target PBX', async () => {
  const pbx = (...names) => ({
    '/PBX/Dialplans/': names.map((name, i) => ({
      id: String(i + 3),
      name,
      description: '',
      includedDialplans: [],
      numbers: [],
    })),
  });
  const target = (context, extension) => ({transfer: {name: 'desk', context, extension}});
  const voice = {
    silenceTimeout: {seconds: 30, action: target('users', '201')},
    maxDuration: {seconds: 600, action: target('night', '202')},
  };
  const published = agentDef('desk', ai(), {channels: {voice}});
  const draft = agentDef('desk', ai(), {
    description: 'next',
    channels: {voice: {...voice, maxDuration: {seconds: 900, action: target('users', '203')}}},
  });
  const f = fakeCompany({
    pbxs: {a: {company: 'it_x', pbx: pbx('users', 'night')}, b: {company: 'it_y', pbx: pbx('users')}},
    clouds: {it_x: {wilma: agentsState([{id: 'ag0000000001', published, draft}])}, it_y: {wilma: {}}},
  });
  // Only the agent is exported (its dialplans are not): they are looked for on the target PBX.
  const kinds = ['dialplans', 'wilma-agents'];
  const all = toPortable(await readKinds(await f.clients('a'), kinds), {serial: f.serial('a'), host: f.host('a')});
  const source = selectFrom(all, new Set(['wilma-agents/desk']));
  const clients = await f.clients('b');
  const plan = makePlan(source, await readKinds(clients, kinds), {serial: f.serial('b'), host: f.host('b')});
  const mark = f.calls.length;
  const results = await applyPlan(clients, plan, new Set(plan.items.map((i) => i.key)));
  const data = portableOf(source, 'wilma-agents').desk;
  const ref = (name) => ({$ref: `dialplans/${name}`, as: 'name'});
  assert.deepEqual(data.channels.voice.silenceTimeout.action.transfer, {
    name: 'desk',
    context: ref('users'),
    extension: '201',
  });
  assert.deepEqual(data.channels.voice.maxDuration.action.transfer, {
    name: 'desk',
    context: ref('night'),
    extension: '202',
  });
  assert.deepEqual(data.draft.channels.voice.maxDuration.action.transfer, {
    name: 'desk',
    context: ref('users'),
    extension: '203',
  });
  assert.deepEqual(source.needs['wilma-agents/desk'], ['dialplans/users', 'dialplans/night']);
  assert.deepEqual(source.soft['wilma-agents/desk'], ['users/201', 'users/202', 'users/203']);
  // The target PBX has no dialplan night, and the export does not carry it: blocked, nothing written.
  const item = plan.items.find((i) => i.kind === 'wilma-agents');
  assert.equal(item.state, 'blocked');
  assert.equal(item.reason, 'needs dialplans/night: neither in the export nor on b.wildixin.com');
  assert.deepEqual(results, []);
  assert.deepEqual(
    f.writes({company: 'it_y'}).filter((c) => f.calls.indexOf(c) >= mark),
    [],
  );
});

test('a tool URL that names a secret id outside apiKey= is bound (only the TTS shape is a reference)', async () => {
  const handler = (url) => ({connector: {definition: {key: 'webhook', version: 2}, configuration: {url}}});
  const f = company(
    toolsState([
      {id: 'x1', published: def('leaky', {handler: handler('https://hooks.example/in?token=secrets:S1')})},
      {id: 'x2', published: def('clean', {handler: handler('https://hooks.example/in')})},
    ]),
  );
  const {source, plan} = await run(f, ['wilma-tools']);
  assert.deepEqual(source.bound, [
    {kind: 'wilma-tools', name: 'leaky', path: 'handler.connector.configuration.url', found: 'secret'},
  ]);
  assert.deepEqual(
    plan.items.map((i) => [i.name, i.state]),
    [
      ['leaky', 'blocked'],
      ['clean', 'new'],
    ],
  );
});

test('a skill sandbox env value is a declared secret: asked once for the draft, its absence skips the skill', async () => {
  const tools = () => [{sandbox: {inline: {size: 'small', env: [{name: 'API', value: 'skill-env-value-31'}]}}}];
  const source = toPortable(
    {
      'wilma-skills': [
        {
          id: 'k1',
          name: 'faq',
          version: 2,
          data: {
            name: 'faq',
            description: 'd',
            tools: tools(),
            draft: {name: 'faq', description: 'next', tools: tools()},
          },
        },
      ],
    },
    {serial: 'aaaa00000001', host: 'a.wildixin.com'},
  );
  const path = 'tools[0].sandbox.inline.env[0].value';
  const data = source.kinds['wilma-skills'][0].data;
  assert.deepEqual(data.tools[0].sandbox.inline.env[0].value, {$secret: path});
  assert.deepEqual(data.draft.tools[0].sandbox.inline.env[0].value, {$secret: path});
  for (const p of [path, `draft.${path}`]) assert.equal(policyOf(TRANSFER_KINDS['wilma-skills'], p)?.empty, 'skip', p);

  const plan = makePlan(source, {'wilma-skills': []}, {serial: 'bbbb00000002', host: 'b.wildixin.com'});
  const results = await applyPlan({wilma: {}}, plan, new Set(['wilma-skills/faq']));
  assert.deepEqual(results, [{key: 'wilma-skills/faq', action: 'skip', because: `no secret: ${path}`}]);
});

test('an access-list entry that is no user or group of the source is dropped with a warning', () => {
  const access = () => ({
    grants: [{userId: 'u1'}, {userId: 'u-other-company'}, {groupId: '7'}, {groupId: '99'}, {department: 'Sales'}],
  });
  const source = toPortable(
    {
      'acl-groups': [{id: '7', name: 'Support', data: {name: 'Support'}}],
      'xbees-users': [{id: 'u1', name: 'ann@x.example', data: {}}],
      'wilma-agents': [
        {
          id: 'ag1',
          name: 'Support',
          data: {
            name: 'Support',
            access: access(),
            engine: {ai: {capabilities: [{agent: {agentId: 'ag1', access: access()}}]}},
          },
        },
      ],
      'wilma-skills': [
        {
          id: 'k1',
          name: 'faq',
          data: {name: 'faq', access: {editors: [{userId: 'u-gone'}], viewers: [{groupId: '7'}, {groupId: 'g-gone'}]}},
        },
      ],
    },
    {serial: 'aaaa00000001', host: 'a.wildixin.com'},
  );
  const kept = [
    {userId: {$ref: 'xbees-users/ann@x.example', as: 'id'}},
    {groupId: {$ref: 'acl-groups/Support', as: 'id'}},
    {department: 'Sales'},
  ];
  const agent = source.kinds['wilma-agents'][0].data;
  assert.deepEqual(agent.access.grants, kept);
  assert.deepEqual(agent.engine.ai.capabilities[0].agent.access.grants, kept);
  const skill = source.kinds['wilma-skills'][0].data;
  assert.deepEqual(skill.access, {editors: [], viewers: [{groupId: {$ref: 'acl-groups/Support', as: 'id'}}]});
  assert.deepEqual(source.unresolved, []);
  const dropped = (name, path, value) => ({name, path, text: `${value} is not a user or group of the source, dropped`});
  assert.deepEqual(
    source.warnings.map(({kind, ...w}) => w),
    [
      dropped('Support', 'access.grants[1].userId', 'u-other-company'),
      dropped('Support', 'access.grants[3].groupId', '99'),
      dropped('Support', 'engine.ai.capabilities[0].agent.access.grants[1].userId', 'u-other-company'),
      dropped('Support', 'engine.ai.capabilities[0].agent.access.grants[3].groupId', '99'),
      dropped('faq', 'access.editors[0].userId', 'u-gone'),
      dropped('faq', 'access.viewers[1].groupId', 'g-gone'),
    ],
  );
});

test('an access list whose users or groups could not be read on the source binds the object; nothing is dropped', () => {
  const agent = () => ({
    id: 'ag1',
    name: 'Support',
    data: {name: 'Support', access: {grants: [{userId: 'u1'}, {groupId: '7'}, {department: 'Sales'}]}},
  });
  const reason = (kind) => `${kind} could not be read on the source: access lists cannot be checked`;
  const cases = [
    [{'acl-groups': {error: 'HTTP 503'}, 'xbees-users': [{id: 'u1', name: 'ann@x.example', data: {}}]}, 'acl-groups'],
    [{'acl-groups': [{id: '7', name: 'Support', data: {}}], 'xbees-users': {error: 'HTTP 503'}}, 'xbees-users'],
    [{'xbees-users': [{id: 'u1', name: 'ann@x.example', data: {}}]}, 'acl-groups'],
  ];
  for (const [lookups, unread] of cases) {
    const source = toPortable(
      {...lookups, 'wilma-agents': [agent()]},
      {serial: 'aaaa00000001', host: 'a.wildixin.com'},
    );
    assert.equal(source.warnings, undefined, unread);
    assert.equal(source.kinds['wilma-agents'][0].data.access.grants.length, 3, unread);
    assert.deepEqual(
      source.bound.map(({kind, name, text}) => [kind, name, text]),
      [['wilma-agents', 'Support', reason(unread)]],
      unread,
    );
    const plan = makePlan(source, {'wilma-agents': []}, {serial: 'bbbb00000002', host: 'b.wildixin.com'});
    const it = plan.items.find((i) => i.key === 'wilma-agents/Support');
    assert.deepEqual([it.state, it.reason], ['blocked', reason(unread)]);
  }
});
