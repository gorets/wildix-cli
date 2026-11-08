import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {CLOUD_KINDS} from '../src/transfer/cloud/index.mjs';
import {writeExport} from '../src/transfer/folder.mjs';
import {readKinds, TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {toPortable} from '../src/transfer/refs.mjs';
import {chooseExport, pickerGroups, selectFrom} from '../src/transfer/selection.mjs';
import {fakeCompany} from './fake-company.mjs';
import {tempConfigDir} from './helpers.mjs';

const LOOKUPS = ['xbees-services', 'xbees-users', 'xbees-bots'];
const svc = (id, title) => ({id, uri: `${id}@pbx.example:443`, title, settings: {}, extensions: ['101']});
const user = (id, email) => ({id, email, displayName: id, bot: false});

const company = () =>
  fakeCompany({
    pbxs: {
      a: {company: 'it_x', pbx: {'/Dialplan/CallGroups/': [{id: '15', title: 'support', members: []}]}},
      b: {company: 'it_y', pbx: {}},
    },
    clouds: {
      it_x: {
        kite: {services: [svc(1, 'Support'), svc(2, 'Sales')], bots: [{id: 'bot-1', name: 'Helper'}]},
        stream: {users: [user('u-ann', 'Ann@x.example'), user('u-bob', 'bob@x.example'), {id: 'u-nomail'}]},
      },
      it_y: {
        kite: {services: [svc(7, 'Vendite')], bots: []},
        stream: {users: [user('u-ann-y', 'ann@x.example')]},
      },
    },
  });

test('lookups read services, users and bots', async () => {
  const f = company();
  const a = await readKinds(await f.clients('a'), LOOKUPS, {
    userQuery: {ids: ['u-bob', 'u-nomail'], emails: ['ann@x.example']},
  });
  assert.deepEqual(a['xbees-services'], [
    {id: '1', name: 'Support', value: {id: 1, uri: '1@pbx.example:443'}, data: {}},
    {id: '2', name: 'Sales', value: {id: 2, uri: '2@pbx.example:443'}, data: {}},
  ]);
  assert.deepEqual(a['xbees-bots'], [{id: 'bot-1', name: 'Helper', data: {}}]);
  // name = the e-mail (in lower case: the directory matches e-mails in any case); a user without one is not named
  assert.deepEqual(a['xbees-users'], [
    {id: 'u-ann', name: 'ann@x.example', data: {}},
    {id: 'u-bob', name: 'bob@x.example', data: {}},
  ]);
  assert.deepEqual(
    f.cloudCalls({company: 'it_x'}).map((c) => [c.service, c.method, `https://${c.host}${c.path}`, c.body]),
    [
      ['kite', 'GET', 'https://api-stage.x-bees.com/v2/kite/services', undefined],
      [
        'stream',
        'POST',
        'https://eu-1.stream-stage.wildix.com/api/v1/users/query',
        {query: {ids: ['u-bob', 'u-nomail'], emails: ['ann@x.example']}},
      ],
      ['kite', 'GET', 'https://api-stage.x-bees.com/v2/users/bots', undefined],
    ],
  );

  // The other PBX reads the cloud of its own company, with its own token; the directory answers the users of every
  // company (Ann of it_x too): only those of it_y are kept.
  const b = await readKinds(await f.clients('b'), LOOKUPS, {userQuery: {emails: ['ANN@x.example']}});
  assert.deepEqual(
    b['xbees-services'].map((s) => s.name),
    ['Vendite'],
  );
  assert.deepEqual(b['xbees-users'], [{id: 'u-ann-y', name: 'ann@x.example', data: {}}]);
  assert.deepEqual(b['xbees-bots'], []);
  assert.equal(f.cloudCalls({company: 'it_y'}).length, 3);
  assert.deepEqual(f.cloudCalls({company: null}), []);
});

test('xbees-users: ids and e-mails asked for, 100 of each per query; nothing without them', async () => {
  const f = company();
  const clients = await f.clients('a');
  const read = (users) => readKinds(clients, ['xbees-users'], {userQuery: users});
  assert.deepEqual((await read(undefined))['xbees-users'], []);
  assert.deepEqual((await read({ids: [], emails: []}))['xbees-users'], []);
  assert.equal(f.cloudCalls({service: 'stream'}).length, 0);

  const ids = ['u-ann', ...Array.from({length: 150}, (_, i) => `x${i}`), 'u-ann'];
  const emails = [...Array.from({length: 120}, (_, i) => `n${i}@x.example`), 'BOB@x.example', 'bob@x.example'];
  const users = (await read({ids, emails}))['xbees-users'];
  assert.deepEqual(
    users.map((u) => u.id),
    ['u-ann', 'u-bob'],
  );
  const queries = f.cloudCalls({service: 'stream'}).map((c) => c.body.query);
  assert.deepEqual(
    queries.map((q) => [q.ids?.length, q.emails?.length]),
    [
      [100, 100],
      [51, 21],
    ],
  );
  assert.equal(queries[0].ids[0], 'u-ann');
  assert.equal(queries[1].emails.at(-1), 'BOB@x.example'); // duplicates (in any case) asked once
});

test('xbees-users: a value that is not an e-mail is not asked for (the directory refuses the whole query)', async () => {
  const f = company();
  const clients = await f.clients('a');
  const users = (
    await readKinds(clients, ['xbees-users'], {
      userQuery: {emails: ['admin', 'bob@x.example', 'a b@x.example', 'ann@x', '']},
    })
  )['xbees-users'];
  assert.deepEqual(
    users.map((u) => u.id),
    ['u-bob'],
  );
  assert.deepEqual(
    f.cloudCalls({service: 'stream'}).map((c) => c.body.query),
    [{emails: ['bob@x.example']}],
  );
  assert.deepEqual((await readKinds(clients, ['xbees-users'], {userQuery: {emails: ['admin']}}))['xbees-users'], []);
  assert.equal(f.cloudCalls({service: 'stream'}).length, 1);
});

test('lookup kinds are cloud, read-only and outside the groups; after the PBX kinds', async () => {
  assert.deepEqual(Object.keys(CLOUD_KINDS).slice(-LOOKUPS.length), LOOKUPS);
  for (const name of LOOKUPS) {
    const k = TRANSFER_KINDS[name];
    assert.equal(k, CLOUD_KINDS[name]);
    assert.equal(k.side, 'cloud');
    assert.equal(k.lookup, true);
    assert.equal(k.group, null);
    assert.equal(typeof k.label, 'string');
    for (const write of ['create', 'update', 'write', 'portable'])
      assert.equal(k[write], undefined, `${name}.${write}`);
  }
  assert.deepEqual(
    LOOKUPS.map((k) => TRANSFER_KINDS[k].service),
    ['kite', 'stream', 'kite'],
  );
  const names = Object.keys(TRANSFER_KINDS);
  assert.deepEqual(names.slice(-LOOKUPS.length), LOOKUPS);
  assert.ok(
    names.slice(0, -LOOKUPS.length).every((k) => TRANSFER_KINDS[k].side === 'pbx' || !TRANSFER_KINDS[k].lookup),
  );
  // Ruling 6: the cloud kinds never import refs.mjs or kinds.mjs (an ESM cycle).
  const dir = new URL('../src/transfer/cloud/', import.meta.url);
  for (const file of fs.readdirSync(dir))
    assert.doesNotMatch(fs.readFileSync(new URL(file, dir), 'utf8'), /from '\.\.\/(refs|kinds)\.mjs'/, file);
});

test('lookup kinds are not in the picker or the folder', async () => {
  const f = company();
  const clients = await f.clients('a');
  const snap = await readKinds(clients, ['queues', ...LOOKUPS], {userQuery: {emails: ['ann@x.example']}});
  assert.equal(snap['xbees-services'].length, 2);
  const portable = toPortable(snap, {serial: f.serial('a'), host: f.host('a'), company: 'it_x'});
  assert.deepEqual(Object.keys(portable.kinds), ['queues']);

  let offered;
  const select = async (opts) => {
    offered = opts.groups;
    return new Set(opts.groups.flatMap((g) => g.items.map((i) => i.id)));
  };
  const picked = await chooseExport(portable, {}, {interactive: true, select});
  assert.deepEqual(
    offered.flatMap((g) => g.items.map((i) => i.id)),
    ['queues/support'],
  );
  assert.deepEqual(
    pickerGroups(portable).map((g) => g.id),
    ['routing'],
  );
  assert.deepEqual([...picked], ['queues/support']);
  const all = await chooseExport(portable, {all: true}, {interactive: false});
  assert.deepEqual([...all], ['queues/support']);

  const dir = path.join(tempConfigDir(), 'exp');
  const out = writeExport({env: f.env, clock: () => 0}, dir, {
    source: {host: f.host('a'), wms: '7', company: 'it_x', env: 'stage'},
    portable: selectFrom(portable, all),
  });
  assert.deepEqual(out.counts, {queues: 1});
  assert.deepEqual(fs.readdirSync(dir).sort(), ['manifest.json', 'queues.jsonl']);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.kinds, {queues: 1});
  assert.doesNotMatch(JSON.stringify(manifest), /xbees|ann@|u-ann|Helper|Sales/);
});

test('fakeCompany: each PBX its own token, each company its own cloud; writes kept and recorded', async () => {
  const x = {wilma: {secrets: [{id: 's1', name: 'key'}]}, integrations: {}, kite: {}, kb: {}};
  const y = {wilma: {}, kite: {}};
  const f = fakeCompany({pbxs: {a: {company: 'it_x'}, b: {company: 'it_y'}}, clouds: {it_x: x, it_y: y}});
  assert.notEqual(f.serial('a'), f.serial('b'));
  const a = await f.clients('a');
  const b = await f.clients('b');
  assert.deepEqual([a.kite.company, b.kite.company], ['it_x', 'it_y']);
  assert.deepEqual(
    f.pbxCalls('a').map((c) => c.path),
    ['/api/v1/PBX/integration/x-bees'],
  );

  assert.deepEqual(
    (await a.wilma.call('GET', '/v2/secrets')).secrets.map((s) => s.id),
    ['s1'],
  );
  assert.deepEqual((await b.wilma.call('GET', '/v2/secrets')).secrets, []);
  await assert.rejects(b.integrations.call('GET', '/console/integrations'), /answered 404: No integrations for it_y/);
  assert.equal((await a.kb.call('GET', '/api/v1/knowledge-bases')).knowledgeBases.length, 0);

  const made = await a.integrations.call('POST', '/console/integrations', {
    json: {service: 'webhook', data: {url: 'https://e.example/in', isNew: true}},
  });
  assert.deepEqual(made.result, {
    integrationId: 'int-new1',
    service: 'webhook',
    status: 'enabled',
    data: {url: 'https://e.example/in'},
  });
  await a.integrations.call('PATCH', '/console/integrations', {
    json: {integrationId: 'int-new1', data: {events: ['e']}},
  });
  assert.deepEqual(x.integrations.installed[0].data, {url: 'https://e.example/in', events: ['e']});

  const w = (await a.kite.call('POST', '/v2/kite/widgets', {json: {name: 'Site'}})).widget;
  await a.kite.call('PUT', `/v2/kite/widgets/${w.id}`, {json: {name: 'Site 2'}});
  await a.kite.call('PUT', '/v2/kite/sms/configurations/%2B3901', {json: {serviceUri: 'u', target: {bot: {id: 'b'}}}});
  assert.deepEqual(x.kite.widgets, [{id: w.id, company: 'it_x', name: 'Site 2'}]);
  assert.deepEqual(x.kite.sms.configs[0].serviceNumber, '+3901');
  await assert.rejects(a.kite.call('GET', '/v2/kite/services?company=it_y'), /400/);

  assert.deepEqual(
    f.writes({company: 'it_x'}).map((c) => [c.service, c.method, c.path]),
    [
      ['integrations', 'POST', '/console/integrations'],
      ['integrations', 'PATCH', '/console/integrations'],
      ['kite', 'POST', '/v2/kite/widgets'],
      ['kite', 'PUT', `/v2/kite/widgets/${w.id}`],
      ['kite', 'PUT', '/v2/kite/sms/configurations/%2B3901'],
    ],
  );
  assert.deepEqual(f.writes({company: 'it_y'}), []);
  const refused = await f.fetch('https://api-stage.wilma.wildix.com/v2/secrets', {
    headers: {authorization: 'Bearer x'},
  });
  assert.equal(refused.status, 401);
});

test('xbees-users: a directory user with no company, or a token naming none, is never one of the company', async () => {
  const answer = {
    users: [
      {id: 'u-1', email: 'one@x.example'},
      {id: 'u-2', email: 'two@x.example', companyId: 'it_x'},
    ],
  };
  const stub = (company) => ({company, call: async () => answer});
  const read = async (company) =>
    (await readKinds({stream: stub(company)}, ['xbees-users'], {userQuery: {emails: ['one@x.example']}}))[
      'xbees-users'
    ];
  assert.deepEqual(
    (await read('it_x')).map((u) => u.id),
    ['u-2'],
  );
  assert.deepEqual(await read(undefined), []);
});
