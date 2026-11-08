import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyPlan} from '../src/transfer/apply.mjs';
import {readKinds, TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {applyMap} from '../src/transfer/map.mjs';
import {makePlan} from '../src/transfer/plan.mjs';
import {keyOf, splitKey, toPortable} from '../src/transfer/refs.mjs';
import {fakeCompany} from './fake-company.mjs';

const KINDS = ['kite-widgets', 'kite-channels'];
const LOOKUPS = ['xbees-services', 'xbees-bots'];
const svc = (id, title, host) => ({
  id,
  uri: `${id}@${host}:443`,
  title,
  settings: {},
  extensions: [],
  pbx: {domain: host, port: 443},
});
const TIME = {timeFrame: {timeZone: 'Europe/Rome', day: 'WEEKDAYS', startMinute: 540, endMinute: 1080}};

const widget = (id, extra = {}) => ({
  id,
  company: 'it_x',
  name: 'Site chat',
  target: {service: {id: 1, uri: '1@a.wildixin.com:443'}},
  appearance: {text: {title: 'Hi'}},
  routes: [
    {
      id: 'r001',
      rules: [TIME],
      target: {agent: {email: 'Ann@x.example'}},
      actions: [
        {id: 'act001', conditions: [{replyTimeout: {timeout: 60}}], task: {sendMessage: {botId: 'bot-x', text: 'hi'}}},
      ],
    },
  ],
  actions: [
    {id: 'act002', task: {addMembers: {emails: ['Ann@x.example']}}},
    {id: 'act003', task: {notifyMessage: {botId: 'bot-x', userId: 'u-ann', text: 'look'}}},
  ],
  anonymousSessionsEnabled: true,
  createdAt: '2026-11-01T10:00:00Z',
  ...extra,
});

const company = ({x = {}, y = {}, pbxA = {}, pbxB = {}} = {}) =>
  fakeCompany({
    pbxs: {a: {company: 'it_x', pbx: pbxA}, b: {company: 'it_y', pbx: pbxB}},
    clouds: {
      it_x: {
        kite: {services: [svc(1, 'Sales', 'a.wildixin.com')], bots: [{id: 'bot-x', name: 'Helper'}], ...x},
        stream: {users: [{id: 'u-ann', email: 'Ann@x.example'}]},
      },
      it_y: {
        kite: {services: [svc(7, 'Vendite', 'b.wildixin.com')], bots: [{id: 'bot-y', name: 'Helper'}], ...y},
        stream: {users: [{id: 'u-ann-y', email: 'ann@x.example'}]},
      },
    },
  });

const usersOf = (snapshot) => {
  const hook = (name) =>
    Object.entries(snapshot).flatMap(([k, l]) =>
      (Array.isArray(l) ? l : []).flatMap((o) => TRANSFER_KINDS[k][name]?.(o.data) ?? []),
    );
  return {ids: hook('userIds'), emails: hook('userEmails')};
};

async function exportOf(f, kinds = KINDS) {
  const clients = await f.clients('a');
  const snap = await readKinds(clients, [...kinds, ...LOOKUPS]);
  Object.assign(snap, await readKinds(clients, ['xbees-users'], {userQuery: usersOf(snap)}));
  return toPortable(snap, {serial: f.serial('a'), host: f.host('a'), company: 'it_x'});
}

async function transfer(f, {map, kinds = KINDS} = {}) {
  let source = await exportOf(f, kinds);
  if (map) source = applyMap(source, map);
  const clients = await f.clients('b');
  const emails = Object.values(source.needs ?? {})
    .flat()
    .filter((k) => k.startsWith('xbees-users/'))
    .map((k) => splitKey(k).name);
  const target = await readKinds(clients, [...kinds, ...LOOKUPS, 'xbees-users'], {userQuery: {emails}});
  const plan = makePlan(source, target, {serial: f.serial('b'), host: f.host('b')});
  const mark = f.calls.length;
  const results = await applyPlan(clients, plan, new Set(plan.items.map((i) => i.key)));
  const calls = f.calls
    .slice(mark)
    .filter((c) => c.company === 'it_y' && c.method !== 'GET')
    .map((c) => [c.service, c.method, c.path, c.body]);
  return {source, plan, results, calls};
}

test('widget target service mapped with --map', async () => {
  const f = company({x: {widgets: [widget('wgt00001')]}});
  const {source, plan, results, calls} = await transfer(f);
  const data = source.kinds['kite-widgets'][0].data;
  assert.deepEqual(data.target, {service: {$ref: 'xbees-services/Sales', as: 'object'}});
  assert.deepEqual(data.routes[0].target, {agent: {email: {$ref: 'xbees-users/ann@x.example', as: 'name'}}});
  assert.deepEqual(data.routes[0].actions[0].task.sendMessage.botId, {$ref: 'xbees-bots/Helper', as: 'id'});
  assert.deepEqual(data.actions[0].task.addMembers.emails, [{$ref: 'xbees-users/ann@x.example', as: 'name'}]);
  assert.deepEqual(data.actions[1].task.notifyMessage.userId, {$ref: 'xbees-users/ann@x.example', as: 'id'});
  assert.equal(data.createdAt, undefined);
  assert.deepEqual(source.bound, []);
  assert.deepEqual(TRANSFER_KINDS['kite-widgets'].userIds(widget('w')), ['u-ann']);
  assert.deepEqual(TRANSFER_KINDS['kite-widgets'].userEmails(widget('w')), ['ann@x.example']);

  // Without a map the service is not on the target.
  assert.deepEqual(
    plan.items.map((i) => [i.state, i.reason]),
    [['blocked', 'needs xbees-services/Sales: not on b.wildixin.com (map it with --map)']],
  );
  assert.deepEqual(results, []);
  assert.deepEqual(calls, []);

  const g = company({x: {widgets: [widget('wgt00001')]}});
  const mapped = await transfer(g, {map: {'xbees-services': {Sales: 'Vendite'}}});
  assert.deepEqual(
    mapped.results.map((r) => [r.key, r.action, r.id]),
    [['kite-widgets/Site chat', 'create', 'wgt-new1']],
  );
  const body = {
    name: 'Site chat',
    target: {service: {id: 7, uri: '7@b.wildixin.com:443'}},
    appearance: {text: {title: 'Hi'}},
    routes: [
      {
        id: 'r001',
        rules: [TIME],
        target: {agent: {email: 'ann@x.example'}},
        actions: [
          {
            id: 'act001',
            conditions: [{replyTimeout: {timeout: 60}}],
            task: {sendMessage: {botId: 'bot-y', text: 'hi'}},
          },
        ],
      },
    ],
    actions: [
      {id: 'act002', task: {addMembers: {emails: ['ann@x.example']}}},
      {id: 'act003', task: {notifyMessage: {botId: 'bot-y', userId: 'u-ann-y', text: 'look'}}},
    ],
    anonymousSessionsEnabled: true,
  };
  assert.deepEqual(mapped.calls, [['kite', 'POST', '/v2/kite/widgets', body]]);

  // On the target already: the widget is replaced whole.
  const h = company({
    x: {widgets: [widget('wgt00001')]},
    y: {widgets: [{id: 'wgt00009', company: 'it_y', name: 'Site chat', target: {bot: {id: 'bot-y'}}}]},
  });
  const over = await transfer(h, {map: {'xbees-services': {Sales: 'Vendite'}}});
  assert.deepEqual(
    over.results.map((r) => [r.action, r.id]),
    [['overwrite', 'wgt00009']],
  );
  assert.deepEqual(over.calls, [['kite', 'PUT', '/v2/kite/widgets/wgt00009', body]]);
});

test('widget skipped while x-bees has not synced the new call group', async () => {
  const support = widget('wgt00001', {
    target: {service: {id: 15, uri: '15@a.wildixin.com:443'}},
    routes: [],
    actions: [],
  });
  const queue = {id: '15', title: 'Support', members: [], settings: {}};
  const f = company({
    x: {services: [svc(15, 'Support', 'a.wildixin.com')], widgets: [support]},
    y: {services: []},
    pbxA: {'/Dialplan/CallGroups/': [queue]},
    pbxB: {'/Dialplan/CallGroups/': []},
  });
  // The widget points at service 15, the call group Support of the source.
  f.calls.length = 0;
  const kinds = ['queues', 'kite-widgets'];
  const {source, plan, results, calls} = await transfer(f, {kinds});
  assert.deepEqual(source.kinds['kite-widgets'][0].data.target, {
    service: {$ref: 'xbees-services/Support', as: 'object'},
  });
  const it = plan.items.find((i) => i.kind === 'kite-widgets');
  assert.equal(it.state, 'new');
  assert.deepEqual(it.needs, ['xbees-services/Support', 'queues/Support']);
  assert.deepEqual(
    results.map((r) => [r.key, r.action, r.because, r.syncWait]),
    [
      ['queues/Support', 'create', undefined, undefined],
      ['kite-widgets/Site chat', 'skip', 'x-bees has not synced Support yet: re-run in a few minutes', true],
    ],
  );
  assert.deepEqual(
    calls.map(([service, method]) => [service, method]),
    [['pbx', 'POST']],
  );

  // Without the call group in the export the service is simply missing.
  const g = company({
    x: {services: [svc(15, 'Support', 'a.wildixin.com')], widgets: [support]},
    y: {services: []},
  });
  const alone = await transfer(g);
  assert.deepEqual(
    alone.plan.items.map((i) => [i.state, i.reason]),
    [['blocked', 'needs xbees-services/Support: not on b.wildixin.com (map it with --map)']],
  );

  // A call group the same on the target is not written in this run: no sync to wait for, the service is missing.
  const h = company({
    x: {services: [svc(15, 'Support', 'a.wildixin.com')], widgets: [support]},
    y: {services: []},
    pbxA: {'/Dialplan/CallGroups/': [queue]},
    pbxB: {'/Dialplan/CallGroups/': [{...queue, id: '25'}]},
  });
  const same = await transfer(h, {kinds});
  assert.deepEqual(
    same.plan.items.map((i) => [i.key, i.state, i.reason]),
    [
      ['queues/Support', 'same', undefined],
      ['kite-widgets/Site chat', 'blocked', 'needs xbees-services/Support: not on b.wildixin.com (map it with --map)'],
    ],
  );
});

test('channel number missing is blocked with a map hint', async () => {
  const config = {
    serviceNumber: '+3902',
    companyId: 'it_x',
    serviceUri: '1@a.wildixin.com:443',
    target: {service: {id: 1, uri: '1@a.wildixin.com:443'}},
    routes: [{id: 'r001', rules: [TIME], target: {bot: {id: 'bot-x'}}}],
    createdAt: '2026-11-01T10:00:00Z',
  };
  const x = {
    sms: {numbers: [{number: '+3902'}, {number: '+3903'}], configs: [config]},
    messenger: {
      senders: [{senderId: '1234', name: 'Page'}],
      configs: [{senderId: '1234', serviceUri: '1@a.wildixin.com:443', target: {agent: {email: 'ann@x.example'}}}],
    },
  };
  const y = {sms: {numbers: [{number: '+4402'}]}, messenger: {senders: [{senderId: '1234', name: 'Page'}]}};
  const f = company({x, y});
  const {source, plan, results, calls} = await transfer(f);
  assert.deepEqual(source.kinds['kite-channels'], [
    {
      name: 'sms:+3902',
      data: {
        serviceUri: {$ref: 'xbees-services/Sales', as: 'object'},
        target: {service: {$ref: 'xbees-services/Sales', as: 'object'}},
        routes: [{id: 'r001', rules: [TIME], target: {bot: {id: {$ref: 'xbees-bots/Helper', as: 'id'}}}}],
      },
    },
    {name: 'sms:+3903', data: {}},
    {
      name: 'messenger:1234',
      data: {
        serviceUri: {$ref: 'xbees-services/Sales', as: 'object'},
        target: {agent: {email: {$ref: 'xbees-users/ann@x.example', as: 'name'}}},
      },
    },
  ]);
  assert.deepEqual(source.bound, [
    {
      kind: 'kite-channels',
      name: 'sms:+3903',
      path: 'target',
      found: 'unconfigured',
      text: 'not configured on the source: nothing to carry',
    },
  ]);
  assert.deepEqual(
    plan.items.map((i) => [i.name, i.state, i.reason, i.missing]),
    [
      [
        'sms:+3902',
        'blocked',
        'sms:+3902 is not a number or sender of b.wildixin.com: map it with --map',
        {kind: 'kite-channels', name: 'sms:+3902'},
      ],
      ['sms:+3903', 'blocked', 'not configured on the source: nothing to carry', undefined],
      [
        'messenger:1234',
        'blocked',
        'needs xbees-services/Sales: not on b.wildixin.com (map it with --map)',
        {kind: 'xbees-services', name: 'Sales'},
      ],
    ],
  );
  assert.deepEqual(results, []);
  assert.deepEqual(calls, []);

  // Mapped: the configurations are put on the target's number and sender.
  const g = company({x, y});
  const map = {'xbees-services': {Sales: 'Vendite'}, 'kite-channels': {'sms:+3902': 'sms:+4402'}};
  const mapped = await transfer(g, {map});
  assert.deepEqual(
    mapped.plan.items.map((i) => [i.name, i.state]),
    [
      ['sms:+4402', 'differs'],
      ['sms:+3903', 'blocked'],
      ['messenger:1234', 'differs'],
    ],
  );
  assert.deepEqual(
    mapped.results.map((r) => [r.key, r.action, r.id]),
    [
      [keyOf('kite-channels', 'sms:+4402'), 'overwrite', 'sms:+4402'],
      [keyOf('kite-channels', 'messenger:1234'), 'overwrite', 'messenger:1234'],
    ],
  );
  const service = {id: 7, uri: '7@b.wildixin.com:443'};
  assert.deepEqual(mapped.calls, [
    [
      'kite',
      'PUT',
      '/v2/kite/sms/configurations/%2B4402',
      {
        serviceUri: service.uri,
        target: {service},
        routes: [{id: 'r001', rules: [TIME], target: {bot: {id: 'bot-y'}}}],
      },
    ],
    [
      'kite',
      'PUT',
      '/v2/kite/messaging/messenger/senders/1234/configuration',
      {serviceUri: service.uri, target: {agent: {email: 'ann@x.example'}}},
    ],
  ]);
});

test('kite kinds: groups, labels, order', () => {
  assert.deepEqual(
    KINDS.map((k) => [TRANSFER_KINDS[k].group, TRANSFER_KINDS[k].label, TRANSFER_KINDS[k].service]),
    [
      ['kite', 'Kite widget', 'kite'],
      ['kite', 'Kite channel', 'kite'],
    ],
  );
  assert.equal(TRANSFER_KINDS['kite-widgets'].nameField, 'name');
  assert.equal(TRANSFER_KINDS['kite-channels'].nameField, undefined);
  assert.equal(TRANSFER_KINDS['xbees-services'].syncedFrom, 'queues');
  const names = Object.keys(TRANSFER_KINDS);
  const cloud = names.slice(names.indexOf('wilma-secrets'));
  assert.deepEqual(cloud, [
    'wilma-secrets',
    'wilma-connections',
    'kb-sources',
    'kb-bases',
    'wilma-connectors',
    'wilma-tools',
    'wilma-skills',
    'wilma-agents',
    'integration-webhooks',
    'integration-apps',
    'integration-crm',
    'kite-widgets',
    'kite-channels',
    'xbees-services',
    'xbees-users',
    'xbees-bots',
  ]);
});
