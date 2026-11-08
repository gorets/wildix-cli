import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyPlan} from '../src/transfer/apply.mjs';
import {readKinds} from '../src/transfer/kinds.mjs';
import {makePlan} from '../src/transfer/plan.mjs';
import {keyOf, toPortable} from '../src/transfer/refs.mjs';
import {fakeCompany} from './fake-company.mjs';

const KINDS = ['kb-sources', 'kb-bases'];
const API_KEY = 'atl-token-123';

const company = (x, y = {}) =>
  fakeCompany({
    pbxs: {a: {company: 'it_x', pbx: {}}, b: {company: 'it_y', pbx: {}}},
    clouds: {it_x: {kb: x}, it_y: {kb: y}},
  });
const state = (extra = {}) => ({kbs: [], sources: [], docs: {}, ...extra});
const confluence = (id, name, extra = {}) => ({
  id,
  name,
  type: 'confluence',
  description: 'wiki',
  syncSchedule: 'EVERY_DAY',
  config: {confluence: {baseUrl: 'https://x.atlassian.net', username: 'a@x.example', spaceId: 'ENG', apiKey: API_KEY}},
  ...extra,
});

async function transfer(f, {secrets = {}} = {}) {
  const source = toPortable(await readKinds(await f.clients('a'), KINDS), {
    serial: f.serial('a'),
    host: f.host('a'),
    company: 'it_x',
  });
  const clients = {kb: (await f.clients('b')).kb};
  const target = await readKinds(clients, KINDS);
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const results = await applyPlan(clients, plan, new Set(plan.items.map((i) => i.key)), {secrets});
  return {source, plan, results};
}

const writesOf = (f) => f.writes({company: 'it_y', service: 'kb'}).map((c) => [c.method, c.path, c.body]);
const noKey = (...xs) => {
  for (const x of xs) assert.doesNotMatch(JSON.stringify(x), new RegExp(API_KEY));
};

test('confluence source: create then configure with the given key', async () => {
  const f = company(state({sources: [confluence('d1', 'Wiki')]}));
  const key = keyOf('kb-sources', 'Wiki');
  const {source, plan, results} = await transfer(f, {secrets: {[key]: {'config.confluence.apiKey': API_KEY}}});
  assert.deepEqual(source.kinds['kb-sources'][0].data.config.confluence.apiKey, {$secret: 'config.confluence.apiKey'});
  assert.deepEqual(
    results.map((r) => [r.action, r.unconfigured]),
    [['create', undefined]],
  );
  const config = {
    confluence: {baseUrl: 'https://x.atlassian.net', username: 'a@x.example', spaceId: 'ENG', apiKey: API_KEY},
  };
  assert.deepEqual(writesOf(f), [
    ['POST', '/api/v1/data-sources', {name: 'Wiki', description: 'wiki', type: 'confluence'}],
    ['PUT', '/api/v1/data-sources/ds-new1/configure', {config, syncSchedule: 'EVERY_DAY'}],
  ]);
  noKey(source, plan, results, f.cloudCalls({company: 'it_x'}));
});

test('confluence source without key: created, not configured, base still points at it', async () => {
  const f = company(
    state({
      sources: [confluence('d1', 'Wiki')],
      kbs: [{id: 'k1', name: 'Docs', description: 'all', dataSources: ['d1']}],
    }),
  );
  const {source, results} = await transfer(f);
  assert.deepEqual(source.kinds['kb-bases'][0].data.dataSources, [{$ref: 'kb-sources/Wiki', as: 'id'}]);
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.unconfigured]),
    [
      [keyOf('kb-sources', 'Wiki'), 'create', true],
      [keyOf('kb-bases', 'Docs'), 'create', undefined],
    ],
  );
  assert.deepEqual(writesOf(f), [
    ['POST', '/api/v1/data-sources', {name: 'Wiki', description: 'wiki', type: 'confluence'}],
    ['POST', '/api/v1/knowledge-bases', {name: 'Docs', description: 'all', dataSources: ['ds-new1']}],
  ]);
  noKey(source, results);
});

test('gdrive source is bound', async () => {
  const f = company(
    state({
      sources: [
        {
          id: 'd2',
          name: 'Drive',
          type: 'gdrive',
          description: '',
          config: {gdrive: {nangoConnectionId: 'nango-conn-9', folders: {enabled: ['f1'], disabled: []}}},
        },
      ],
    }),
  );
  const {source, plan, results} = await transfer(f);
  assert.deepEqual(source.bound, [
    {kind: 'kb-sources', name: 'Drive', path: 'config.gdrive.nangoConnectionId', found: 'nango'},
  ]);
  assert.doesNotMatch(JSON.stringify(source), /nango-conn-9/);
  assert.equal(plan.items[0].state, 'blocked');
  assert.equal(plan.items[0].reason, 'bound to a Nango connection of the source (config.gdrive.nangoConnectionId)');
  assert.deepEqual(results, []);
  assert.deepEqual(writesOf(f), []);
});

test('website source configured with its urls; files source created empty with a warning', async () => {
  const f = company(
    state({
      sources: [
        {
          id: 'd3',
          name: 'Site',
          type: 'website',
          description: '',
          syncSchedule: 'EVERY_WEEK',
          config: {website: {urls: ['https://a.example', 'https://b.example'], pages: {enabled: ['/p']}}},
        },
        {id: 'd4', name: 'Docs', type: 'files', description: 'pdfs', config: {files: {}}},
      ],
    }),
  );
  const {source, results} = await transfer(f);
  assert.deepEqual(
    results.map((r) => [r.action, r.unconfigured]),
    [
      ['create', undefined],
      ['create', undefined],
    ],
  );
  assert.deepEqual(writesOf(f), [
    ['POST', '/api/v1/data-sources', {name: 'Site', description: '', type: 'website'}],
    [
      'PUT',
      '/api/v1/data-sources/ds-new1/configure',
      {
        config: {website: {urls: ['https://a.example', 'https://b.example'], pages: {enabled: ['/p']}}},
        syncSchedule: 'EVERY_WEEK',
      },
    ],
    ['POST', '/api/v1/data-sources', {name: 'Docs', description: 'pdfs', type: 'files'}],
    ['PUT', '/api/v1/data-sources/ds-new2/configure', {config: {files: {}}}],
  ]);
  assert.deepEqual(
    source.warnings.map((w) => [w.name, w.text]),
    [['Docs', 'documents are not carried: upload them again']],
  );
});

test('existing source gets configure only; type cannot change', async () => {
  const x = state({
    sources: [
      {id: 'd3', name: 'Site', type: 'website', config: {website: {urls: ['https://new.example']}}},
      {id: 'd5', name: 'Other', type: 'files', config: {files: {}}},
    ],
  });
  const y = state({
    sources: [
      {id: 't3', name: 'Site', type: 'website', config: {website: {urls: ['https://old.example']}}},
      {id: 't5', name: 'Other', type: 'website', config: {files: {}}},
    ],
  });
  const f = company(x, y);
  const {plan, results} = await transfer(f);
  assert.deepEqual(
    plan.items.map((i) => [i.name, i.state]),
    [
      ['Site', 'differs'],
      ['Other', 'blocked'],
    ],
  );
  assert.deepEqual(
    results.map((r) => [r.action, r.id]),
    [['overwrite', 't3']],
  );
  assert.deepEqual(writesOf(f), [
    ['PUT', '/api/v1/data-sources/t3', {name: 'Site', description: ''}],
    ['PUT', '/api/v1/data-sources/t3/configure', {config: {website: {urls: ['https://new.example']}}}],
  ]);
});

test('failed configure is a configure stage that names the source and hides the key', async () => {
  const f = company(state({sources: [confluence('d1', 'Wiki')]}));
  const key = keyOf('kb-sources', 'Wiki');
  const {results} = await transfer(
    {
      ...f,
      clients: async (n) => {
        const c = await f.clients(n);
        const call = c.kb.call.bind(c.kb);
        c.kb.call = async (method, path, o) => {
          if (path.endsWith('/configure'))
            throw Object.assign(new Error(`bad body ${JSON.stringify(o.json)}`), {status: 422});
          return call(method, path, o);
        };
        return c;
      },
      serial: f.serial,
      host: f.host,
    },
    {secrets: {[key]: {'config.confluence.apiKey': API_KEY}}},
  );
  assert.equal(results[0].action, 'failed');
  assert.equal(results[0].stage, 'configure');
  assert.equal(results[0].id, 'ds-new1');
  noKey(results);
});

test('knowledge base update replaces its data sources', async () => {
  const x = state({
    sources: [{id: 'd3', name: 'Site', type: 'website', config: {website: {urls: ['https://a.example']}}}],
    kbs: [{id: 'k1', name: 'Docs', description: 'new', dataSources: ['d3']}],
  });
  const y = state({
    sources: [{id: 't3', name: 'Site', type: 'website', config: {website: {urls: ['https://a.example']}}}],
    kbs: [{id: 'tk1', name: 'Docs', description: 'old', dataSources: []}],
  });
  const f = company(x, y);
  const {results} = await transfer(f);
  assert.deepEqual(
    results.map((r) => [r.key, r.action]),
    [[keyOf('kb-bases', 'Docs'), 'overwrite']],
  );
  assert.deepEqual(writesOf(f), [
    ['PUT', '/api/v1/knowledge-bases/tk1', {name: 'Docs', description: 'new', dataSources: ['t3']}],
  ]);
});

test('description-only difference: PUT with the new description, then configure', async () => {
  const cfg = {website: {urls: ['https://a.example']}};
  const f = company(
    state({sources: [{id: 'd3', name: 'Site', type: 'website', description: 'new', config: cfg}]}),
    state({sources: [{id: 't3', name: 'Site', type: 'website', description: 'old', config: cfg}]}),
  );
  const {results} = await transfer(f);
  assert.deepEqual(
    results.map((r) => [r.action, r.id]),
    [['overwrite', 't3']],
  );
  assert.deepEqual(writesOf(f)[0], ['PUT', '/api/v1/data-sources/t3', {name: 'Site', description: 'new'}]);
});

test('existing confluence source overwritten without a key: not configured, noted, not unconfigured', async () => {
  const f = company(
    state({sources: [confluence('d1', 'Wiki', {description: 'new'})]}),
    state({
      sources: [
        confluence('t1', 'Wiki', {
          description: 'old',
          config: {
            confluence: {baseUrl: 'https://old.atlassian.net', username: 'a@x.example', spaceId: 'ENG', apiKey: 'k'},
          },
        }),
      ],
    }),
  );
  const {results} = await transfer(f);
  assert.equal(results[0].action, 'overwrite');
  assert.equal(results[0].unconfigured, undefined);
  assert.deepEqual(results[0].notes, ['configuration not changed: no API token given']);
  assert.deepEqual(writesOf(f), [['PUT', '/api/v1/data-sources/t1', {name: 'Wiki', description: 'new'}]]);
  noKey(results);
});
