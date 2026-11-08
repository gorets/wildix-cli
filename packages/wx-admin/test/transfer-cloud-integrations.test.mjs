import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hubWebhookUrl} from '../src/integration/api.mjs';
import {applyPlan} from '../src/transfer/apply.mjs';
import {readKinds, TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {makePlan} from '../src/transfer/plan.mjs';
import {keyOf, splitKey, toPortable} from '../src/transfer/refs.mjs';
import {secretsFrom} from '../src/transfer/run.mjs';
import {chooseExport, parseOnly} from '../src/transfer/selection.mjs';
import {fakeCompany} from './fake-company.mjs';

const KINDS = ['integration-webhooks', 'integration-apps', 'integration-crm'];
const SOURCE_SECRET = 'SrcSigningSecretSrcSigning1234';
const TARGET_SECRET = 'TgtSigningSecretTgtSigning5678';
const URL_1 = 'https://crm.example.com/hook?a=1';
const URL_2 = 'https://crm.example.com/hook?a=1,b=2';

const webhook = (integrationId, url, extra = {}) => ({
  integrationId,
  service: 'webhook',
  status: 'enabled',
  data: {
    type: 'webhook',
    url,
    key: '',
    secret: SOURCE_SECRET,
    events: [{value: 'call:completed'}],
    createdBy: 'ann@x.example',
    ...extra,
  },
});
const hubspot = (integrationId, settings) => ({
  integrationId,
  service: 'hubspot_backend',
  data: {providerConfigKey: 'hubspot_backend', connectionId: 'nango-conn-1', hub_domain: 'acme.com', settings},
});
const app = (integrationId, data) => ({
  integrationId,
  service: 'iframe_integration',
  status: 'enabled',
  data: {
    title: 'Orders',
    iframeUrl: 'https://orders.example/app',
    description: 'd',
    templateId: '',
    position: 2,
    accessEmails: ['Ann@x.example'],
    deniedEmails: [],
    timestamp: 1,
    tabs: {info: {enabled: true, usePbxToken: false, platforms: 'all'}, tab: {enabled: false, icon: 'chart-crm'}},
    usePbxToken: false,
    createdBy: 'ann@x.example',
    ...data,
  },
});

const company = (x, y = {}) =>
  fakeCompany({
    pbxs: {a: {company: 'it_x', pbx: {}}, b: {company: 'it_y', pbx: {}}},
    clouds: {
      it_x: {integrations: x, stream: {users: [{id: 'u-ann', email: 'Ann@x.example'}]}},
      it_y: {integrations: y, stream: {users: [{id: 'u-ann-y', email: 'ann@x.example'}]}},
    },
  });

// The users the source objects name (ids and e-mails, through the kinds' hooks), read with the source lookup.
const usersOf = (snapshot) => ({
  ids: Object.entries(snapshot).flatMap(([k, l]) =>
    (Array.isArray(l) ? l : []).flatMap((o) => TRANSFER_KINDS[k].userIds?.(o.data) ?? []),
  ),
  emails: Object.entries(snapshot).flatMap(([k, l]) =>
    (Array.isArray(l) ? l : []).flatMap((o) => TRANSFER_KINDS[k].userEmails?.(o.data) ?? []),
  ),
});

async function exportOf(f) {
  const clients = await f.clients('a');
  const snap = await readKinds(clients, KINDS);
  Object.assign(snap, await readKinds(clients, ['xbees-users'], {userQuery: usersOf(snap)}));
  return toPortable(snap, {serial: f.serial('a'), host: f.host('a'), company: 'it_x'});
}

async function transfer(f, {secrets = {}, source} = {}) {
  source ??= await exportOf(f);
  const all = await f.clients('b');
  const clients = {integrations: all.integrations, stream: all.stream};
  const emails = Object.values(source.needs ?? {})
    .flat()
    .filter((k) => k.startsWith('xbees-users/'))
    .map((k) => splitKey(k).name);
  const target = await readKinds(clients, [...KINDS, 'xbees-users'], {userQuery: {emails}});
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const events = [];
  const mark = f.calls.length;
  const results = await applyPlan(clients, plan, new Set(plan.items.map((i) => i.key)), {
    secrets,
    onEvent: (r) => events.push(JSON.stringify(r)),
  });
  const calls = f.calls
    .slice(mark)
    .filter((c) => c.company === 'it_y' && c.service === 'integrations')
    .map((c) => [c.method, c.path, ...(c.body === undefined ? [] : [c.body])]);
  return {source, plan, results, events, calls};
}

const absent = (value, ...xs) => {
  for (const x of xs) assert.ok(!JSON.stringify(x).includes(value), `${value} leaked`);
};

test('webhook URL name round-trips through --only and --secrets', async () => {
  const f = company({installed: [webhook('wh1', URL_1), webhook('wh2', URL_2)]});
  const source = await exportOf(f);
  const k1 = keyOf('integration-webhooks', URL_1);
  const k2 = keyOf('integration-webhooks', URL_2);
  assert.deepEqual(splitKey(k1), {kind: 'integration-webhooks', name: URL_1});
  assert.deepEqual(
    source.kinds['integration-webhooks'].map((o) => o.name),
    [URL_1, URL_2],
  );

  // --only splits at the first ":" (the URL keeps its own) and at the commas that are not escaped.
  assert.deepEqual(parseOnly(`integration-webhooks:${URL_1}`), [{kind: 'integration-webhooks', name: URL_1}]);
  const both = `integration-webhooks:${URL_1},integration-webhooks:${URL_2.replace(',', '\\,')}`;
  assert.deepEqual(parseOnly(both), [
    {kind: 'integration-webhooks', name: URL_1},
    {kind: 'integration-webhooks', name: URL_2},
  ]);
  const picked = await chooseExport(source, {only: `integration-webhooks:${URL_2.replace(',', '\\,')}`}, {});
  assert.deepEqual([...picked], [k2]);

  // --secrets: a key holding "/" and ":", flat or by kind.
  const all = await f.clients('b');
  const target = await readKinds({integrations: all.integrations}, KINDS);
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const file = {[k1]: {secret: 'given-1'}, 'integration-webhooks': {[URL_2]: {secret: 'given-2'}}};
  const secrets = secretsFrom(file, plan.items);
  assert.deepEqual(secrets, {[k1]: {secret: 'given-1'}, [k2]: {secret: 'given-2'}});

  const {results, calls} = await transfer(f, {secrets, source});
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.generated]),
    [
      [k1, 'create', undefined],
      [k2, 'create', undefined],
    ],
  );
  assert.deepEqual(results.generatedSecrets, {});
  assert.deepEqual(
    calls.filter(([m]) => m === 'POST').map(([, , body]) => [body.data.url, body.data.secret]),
    [
      [URL_1, 'given-1'],
      [URL_2, 'given-2'],
    ],
  );
});

test('new webhook without secret gets a generated one, printed once, not in the log', async () => {
  const f = company({
    installed: [webhook('wh1', URL_1, {events: [{value: 'call:completed'}, {value: 'chat:completed'}]})],
  });
  const {source, plan, results, events, calls} = await transfer(f);
  const key = keyOf('integration-webhooks', URL_1);
  assert.deepEqual(source.kinds['integration-webhooks'], [
    {
      name: URL_1,
      data: {type: 'webhook', url: URL_1, events: ['call:completed', 'chat:completed'], secret: {$secret: 'secret'}},
    },
  ]);
  assert.deepEqual(TRANSFER_KINDS['integration-webhooks'].secrets, [{path: 'secret', empty: 'generate'}]);
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.id, r.generated]),
    [[key, 'create', 'int-new1', {path: 'secret'}]],
  );
  const generated = results.generatedSecrets[key].secret;
  assert.match(generated, /^[A-Za-z0-9]{30}$/);
  assert.deepEqual(calls, [
    [
      'POST',
      '/console/integrations',
      {
        service: 'webhook',
        data: {
          type: 'webhook',
          url: URL_1,
          key: '',
          secret: generated,
          events: [{value: 'call:completed'}, {value: 'chat:completed'}],
        },
      },
    ],
  ]);
  // Once: in generatedSecrets only, never in the results, the plan, the events of the log or the export.
  absent(generated, results, plan, events);
  absent(SOURCE_SECRET, source, plan, results, events);
});

test('overwrite never sends the secret', async () => {
  const x = {installed: [webhook('wh1', URL_1, {events: [{value: 'call:completed'}, {value: 'chat:completed'}]})]};
  const y = {installed: [webhook('wh-y', URL_1, {secret: TARGET_SECRET})]};
  const f = company(x, y);
  const {plan, results, calls} = await transfer(f);
  assert.deepEqual(
    plan.items.map((i) => [i.state, i.paths]),
    [['differs', ['events[1]']]],
  );
  assert.deepEqual(
    results.map((r) => [r.action, r.id, r.generated]),
    [['overwrite', 'wh-y', undefined]],
  );
  // The target is read again, then only what changes is sent: no secret, none generated.
  assert.deepEqual(calls, [
    ['GET', '/console/integrations'],
    [
      'PATCH',
      '/console/integrations',
      {integrationId: 'wh-y', data: {events: [{value: 'call:completed'}, {value: 'chat:completed'}]}},
    ],
  ]);
  assert.deepEqual(results.generatedSecrets, {});
  absent(TARGET_SECRET, plan, results);
  assert.equal(y.installed[0].data.secret, TARGET_SECRET);

  // A secret given with --secrets is sent with the change.
  const g = company(x, {installed: [webhook('wh-y', URL_1, {secret: TARGET_SECRET})]});
  const given = await transfer(g, {secrets: {[keyOf('integration-webhooks', URL_1)]: {secret: 'new-one'}}});
  assert.deepEqual(given.calls.at(-1), [
    'PATCH',
    '/console/integrations',
    {
      integrationId: 'wh-y',
      data: {events: [{value: 'call:completed'}, {value: 'chat:completed'}], secret: 'new-one'},
    },
  ]);
});

test('owned webhook is not read; an SQS webhook is not carried', async () => {
  const f = company({installed: []});
  const base = (await f.clients('a')).integrations;
  const installed = [
    webhook('wh1', URL_1),
    webhook('wh-omni', 'https://omni.example/in'),
    {integrationId: 'om1', service: 'salesforce_omni', data: {webhookId: 'wh-omni', organizationId: 'org9'}},
    webhook('wh-hub', hubWebhookUrl(base)),
    webhook('wh-sqs', 'https://sqs.eu-west-1.amazonaws.com/1/q', {type: 'sqs', key: 'AKIAKEY', secret: 'sqs-secret'}),
  ];
  const g = company({installed});
  const snap = await readKinds(await g.clients('a'), ['integration-webhooks']);
  assert.deepEqual(
    snap['integration-webhooks'].map((o) => [o.id, o.name]),
    [
      ['wh1', URL_1],
      ['wh-sqs', 'https://sqs.eu-west-1.amazonaws.com/1/q'],
    ],
  );
  const {source, plan, results, calls} = await transfer(g);
  const sqs = 'https://sqs.eu-west-1.amazonaws.com/1/q';
  assert.deepEqual(source.bound, [
    {kind: 'integration-webhooks', name: sqs, path: 'type', found: 'sqs', text: 'SQS webhooks are not carried'},
  ]);
  assert.deepEqual(source.warnings, [
    {kind: 'integration-webhooks', name: sqs, path: 'type', text: 'SQS webhooks are not carried'},
  ]);
  absent('AKIAKEY', source);
  absent('sqs-secret', source);
  assert.deepEqual(
    plan.items.map((i) => [i.name, i.state, i.reason]),
    [
      [URL_1, 'new', undefined],
      [sqs, 'blocked', 'SQS webhooks are not carried'],
    ],
  );
  assert.deepEqual(
    results.map((r) => r.action),
    ['create'],
  );
  assert.deepEqual(
    calls.map(([m, , b]) => [m, b?.data?.url]),
    [['POST', URL_1]],
  );
});

test('crm not installed is blocked', async () => {
  const f = company({installed: [hubspot('hs1', {calls: {isLogCalls: true, minCallLogTime: 5}})]});
  const {source, plan, results, calls} = await transfer(f);
  assert.deepEqual(source.kinds['integration-crm'], [
    {name: 'hubspot_backend', data: {settings: {calls: {isLogCalls: true, minCallLogTime: 5}}}},
  ]);
  absent('nango-conn-1', source);
  assert.deepEqual(
    plan.items.map((i) => [i.key, i.state, i.reason]),
    [
      [
        'integration-crm/hubspot_backend',
        'blocked',
        'not installed on b.wildixin.com: install it in the WIM console, then re-run',
      ],
    ],
  );
  assert.deepEqual(results, []);
  assert.deepEqual(calls, []);
});

test('crm settings updated', async () => {
  const settings = {calls: {isLogCalls: true, minCallLogTime: 5}, chats: {isLogChats: true}};
  const y = {installed: [hubspot('hs-y', {calls: {isLogCalls: false}})]};
  const f = company({installed: [hubspot('hs1', settings)]}, y);
  const {plan, results, calls} = await transfer(f);
  assert.deepEqual(
    plan.items.map((i) => i.state),
    ['differs'],
  );
  assert.deepEqual(
    results.map((r) => [r.action, r.id]),
    [['overwrite', 'hs-y']],
  );
  assert.deepEqual(calls, [['PATCH', '/console/integrations', {integrationId: 'hs-y', data: {settings}}]]);
  assert.equal(y.installed[0].data.hub_domain, 'acme.com'); // the rest of the integration stays
  assert.deepEqual(y.installed[0].data.settings, settings);
});

test('iframe app: e-mails become user refs; created, then overwritten whole', async () => {
  const f = company({installed: [app('ap1')]});
  const {source, results, calls} = await transfer(f);
  const data = source.kinds['integration-apps'][0].data;
  assert.deepEqual(data.accessEmails, [{$ref: 'xbees-users/ann@x.example', as: 'name'}]);
  assert.equal(data.createdBy, undefined);
  assert.equal(data.timestamp, undefined);
  assert.equal(data.position, undefined);
  assert.deepEqual(TRANSFER_KINDS['integration-apps'].userEmails(app('ap1').data), ['ann@x.example']);
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.id]),
    [['integration-apps/Orders', 'create', 'int-new1']],
  );
  const created = {
    title: 'Orders',
    iframeUrl: 'https://orders.example/app',
    description: 'd',
    templateId: '',
    accessEmails: ['ann@x.example'],
    deniedEmails: [],
    tabs: {info: {enabled: true, usePbxToken: false, platforms: 'all'}, tab: {enabled: false, icon: 'chart-crm'}},
    usePbxToken: false,
  };
  assert.deepEqual(calls, [
    ['POST', '/console/integrations', {service: 'iframe_integration', data: {...created, position: 0, isNew: true}}],
  ]);

  // On the target already: what it has is sent back with the changes (its place stays).
  const y = {installed: [app('ap-y', {description: 'old', position: 5, accessEmails: [], createdBy: 'zed@y.example'})]};
  const g = company({installed: [app('ap1')]}, y);
  const over = await transfer(g);
  assert.deepEqual(
    over.results.map((r) => [r.action, r.id]),
    [['overwrite', 'ap-y']],
  );
  assert.deepEqual(over.calls, [
    ['GET', '/console/integrations'],
    [
      'POST',
      '/console/integrations',
      {
        service: 'iframe_integration',
        data: {...created, position: 5, createdBy: 'zed@y.example', isNew: false, integrationId: 'ap-y'},
      },
    ],
  ]);
});

test('iframe app: a user missing on the target blocks it', async () => {
  const f = company({installed: [app('ap1')]}, {installed: []});
  const source = await exportOf(f);
  const all = await f.clients('b');
  // The target directory has no such user.
  const target = await readKinds({integrations: all.integrations}, KINDS);
  target['xbees-users'] = [];
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  assert.deepEqual(
    plan.items.map((i) => [i.state, i.reason]),
    [['blocked', 'needs xbees-users/ann@x.example: not on b.wildixin.com (map it with --map)']],
  );

  // One the source directory does not know either is not a user of the source: dropped, with a warning (never
  // written to the target as it is).
  const g = company({installed: [app('ap1', {deniedEmails: ['bob@x.example']})]});
  const src = await exportOf(g);
  assert.deepEqual(src.unresolved, []);
  assert.deepEqual(src.kinds['integration-apps'][0].data.deniedEmails, []);
  assert.deepEqual(src.kinds['integration-apps'][0].data.accessEmails, [
    {$ref: 'xbees-users/ann@x.example', as: 'name'},
  ]);
  assert.deepEqual(src.warnings, [
    {
      kind: 'integration-apps',
      name: 'Orders',
      path: 'deniedEmails[0]',
      text: 'bob@x.example is not a user or group of the source, dropped',
    },
  ]);
});

test('a refused write names the stage and the status only', async () => {
  const f = company({installed: [webhook('wh1', URL_1)]});
  const all = await f.clients('b');
  const call = all.integrations.call.bind(all.integrations);
  let sent;
  all.integrations.call = async (method, path, o) => {
    if (method !== 'POST') return call(method, path, o);
    sent = o.json.data.secret;
    throw Object.assign(new Error(`bad body ${JSON.stringify(o.json)}`), {status: 422});
  };
  const source = await exportOf(f);
  const target = await readKinds({integrations: all.integrations}, KINDS);
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const results = await applyPlan({integrations: all.integrations}, plan, new Set(plan.items.map((i) => i.key)));
  assert.deepEqual(
    results.map((r) => [r.action, r.stage, r.error]),
    [['failed', 'create', 'create was refused (HTTP 422)']],
  );
  assert.match(sent, /^[A-Za-z0-9]{30}$/);
  absent(sent, results);
});

test('integration kinds: groups, labels, names', () => {
  assert.deepEqual(
    KINDS.map((k) => [TRANSFER_KINDS[k].group, TRANSFER_KINDS[k].label, TRANSFER_KINDS[k].service]),
    [
      ['integrations', 'webhook', 'integrations'],
      ['integrations', 'iframe app', 'integrations'],
      ['integrations', 'CRM settings', 'integrations'],
    ],
  );
  assert.equal(TRANSFER_KINDS['integration-webhooks'].nameField, 'url');
  assert.equal(TRANSFER_KINDS['integration-apps'].nameField, 'title');
});

test('--secrets refuses a value that is the mask: it would replace the secret with ********', () => {
  const items = [
    {key: 'wilma-secrets/eleven', data: {name: 'eleven', value: {$secret: 'value'}}},
    {key: 'trunks-sip/carrier', data: {settingsPbx: {secret: {$secret: 'settingsPbx.secret'}}}},
  ];
  assert.throws(
    () => secretsFrom({'wilma-secrets/eleven': {value: '********'}}, items),
    (e) => e.name === 'UsageError' && /wilma-secrets\/eleven value: \*{8} is the mask/.test(e.message),
  );
  assert.throws(
    () => secretsFrom({'trunks-sip': {carrier: {password: '********'}}}, items),
    (e) => e.name === 'UsageError' && /trunks-sip\/carrier settingsPbx\.secret: \*{8} is the mask/.test(e.message),
  );
  // A value that only holds asterisks among other characters is a value.
  assert.deepEqual(secretsFrom({'wilma-secrets/eleven': {value: 'a********b'}}, items), {
    'wilma-secrets/eleven': {value: 'a********b'},
  });
});

test('iframe app: when the users could not be read on the source it is bound, nothing dropped', () => {
  const src = toPortable(
    {
      'integration-apps': [{id: 'ap1', name: 'Orders', data: {accessEmails: [], deniedEmails: ['bob@x.example']}}],
      'xbees-users': {error: 'HTTP 503'},
    },
    {serial: 'aaaa00000001', host: 'a.wildixin.com'},
  );
  assert.equal(src.warnings, undefined);
  assert.deepEqual(src.kinds['integration-apps'][0].data.deniedEmails, ['bob@x.example']);
  assert.deepEqual(
    src.bound.map(({kind, name, text}) => [kind, name, text]),
    [['integration-apps', 'Orders', 'xbees-users could not be read on the source: access lists cannot be checked']],
  );
});
