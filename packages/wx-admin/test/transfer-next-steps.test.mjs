import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nextSteps} from '../src/transfer/next-steps.mjs';

const HOST = 'b.wildixin.com';
const RERUN = 'wx-admin config import ./exp --pbx b.wildixin.com';
const it = (key, state, extra = {}) => ({
  key,
  kind: key.split('/')[0],
  name: key.slice(key.indexOf('/') + 1),
  state,
  warnings: [],
  needs: [],
  data: {},
  ...extra,
});
const steps = (items, results = [], welcomeMails = 0) =>
  nextSteps({plan: {host: HOST, items, welcomeMails}, results, host: HOST, rerun: RERUN});
const find = (list, re) => list.find((s) => re.test(s.what));

test('a trunk skipped for its password: set it (blocking)', () => {
  const s = find(
    steps(
      [it('trunks-sip/a', 'new')],
      [{key: 'trunks-sip/a', action: 'skip', because: 'no password: settingsPbx.secret'}],
    ),
    /password/,
  );
  assert.equal(s.blocking, true);
  assert.match(s.what, /Set the password of the trunk a/);
  assert.equal(s.command, `${RERUN} --only trunks-sip:a --overwrite`);
  assert.match(s.wms, /Trunks/);
});

test('trunks created: check they register', () => {
  const s = find(steps([it('trunks-sip/a', 'new')], [{key: 'trunks-sip/a', action: 'create', id: '3'}]), /register/);
  assert.equal(s.blocking, false);
  assert.match(s.command, /trunk list/);
});

test('users created: passwords are the PBX own, welcome e-mails counted', () => {
  const s = find(steps([it('users/101', 'new')], [{key: 'users/101', action: 'create', id: '9'}], 1), /new user/);
  assert.match(s.what, /1 new user/);
  assert.match(s.why, /1 of them got the welcome e-mail/);
  assert.equal(s.blocking, false);
});

test('users blocked for licenses or a taken extension: fix and run the same import again', () => {
  const s = find(
    steps([
      it('users/102', 'blocked', {reason: `no free business license on ${HOST}`}),
      it('users/103', 'blocked', {reason: `extension 103 is Bob on ${HOST}`}),
    ]),
    /licen/,
  );
  assert.equal(s.blocking, true);
  assert.equal(s.objects.length, 2);
  assert.equal(s.command, RERUN);
});

test('a missing sound, music on hold class or phonebook: create it, naming the rules', () => {
  const list = steps([
    it('dialplans/main', 'new', {
      warnings: [
        {type: 'sound', value: 'hello', path: 'numbers[0].apps[1].params.filename', text: 't'},
        {type: 'moh', value: 'jazz', path: 'numbers[0].apps[0].params.mohClass', text: 't'},
        {type: 'phonebook', value: '4', path: 'numbers[1].apps[0].params.phonebookId', text: 't'},
      ],
    }),
  ]);
  const sound = find(list, /sound hello/);
  assert.equal(sound.blocking, true);
  assert.match(sound.command, /sound upload/);
  assert.deepEqual(sound.objects, [{kind: 'dialplans', name: 'main', where: 'numbers[0].apps[1].params.filename'}]);
  assert.ok(find(list, /music on hold class jazz/).blocking);
  assert.ok(find(list, /phonebook 4/).blocking);
});

test('queue members who are not users, external values, unresolved references: checks', () => {
  const list = steps([
    it('queues/support', 'new', {warnings: [{type: 'member', value: '777', text: 't'}]}),
    it('dialplans/main', 'new', {
      warnings: [
        {type: 'external', value: 'voicebot', path: 'p', text: 't'},
        {type: 'unresolved', value: 'ghost', path: 'q', text: 't'},
      ],
    }),
  ]);
  assert.match(find(list, /777/).command, /queue update support/);
  assert.equal(find(list, /777/).blocking, false);
  assert.equal(find(list, /voicebot/).blocking, false);
  assert.equal(find(list, /ghost/).blocking, false);
});

test('a failed object and what was skipped with it: the reason and the same import again', () => {
  const s = find(
    steps(
      [it('queues/q', 'new'), it('dialplans/main', 'new')],
      [
        {key: 'queues/q', action: 'failed', error: 'Already present'},
        {key: 'dialplans/main', action: 'skip', because: 'queues/q'},
      ],
    ),
    /failed/,
  );
  assert.equal(s.blocking, true);
  assert.match(s.why, /Already present/);
  assert.match(s.what, /dialplans\/main/);
  assert.equal(s.command, `${RERUN} --only queues:q,dialplans:main --overwrite`);
});

test('what is never transferred is always listed; ACL changes ask who administers the PBX', () => {
  const list = steps([it('acl-groups/Sales', 'new')], [{key: 'acl-groups/Sales', action: 'create', id: '7'}]);
  assert.match(find(list, /never/).what, /devices/);
  assert.match(find(list, /administer/).command, /acl list/);
});

test('folds repeated objects; blocking steps first', () => {
  const items = Array.from({length: 12}, (_, i) => it(`trunks-sip/t${i}`, 'new'));
  const results = items.map((x) => ({key: x.key, action: 'skip', because: 'no password: settingsPbx.secret'}));
  const list = steps(items, results);
  const s = find(list, /password/);
  assert.match(s.what, /Set the password of 12 trunks: t0, t1, t2, t3, t4 … and 7 more/);
  assert.equal(s.objects.length, 12);
  const firstCheck = list.findIndex((x) => !x.blocking);
  assert.ok(list.slice(firstCheck).every((x) => !x.blocking));
});

test('no secret in any step', () => {
  const list = steps(
    [it('trunks-sip/a', 'new', {data: {settingsPbx: {secret: {$secret: 'settingsPbx.secret'}}}})],
    [{key: 'trunks-sip/a', action: 'skip', because: 'no password: settingsPbx.secret'}],
  );
  assert.ok(!/\$secret/.test(JSON.stringify(list)));
});

test('review 1: objects left bare or skipped are finished by the same import, only them, with --overwrite', () => {
  const list = steps(
    [it('trunks-sip/carrier', 'new'), it('dialplans/main', 'new')],
    [
      {key: 'trunks-sip/carrier', action: 'skip', because: 'no password: settingsPbx.secret'},
      {key: 'dialplans/main', action: 'skip', because: 'trunks-sip/carrier', bare: true},
    ],
  );
  const s = find(list, /password/);
  assert.equal(s.command, `${RERUN} --only trunks-sip:carrier,dialplans:main --overwrite`);
  assert.match(s.what, /dialplans\/main is on b\.wildixin\.com empty/);
});

test('review 3: a skip that is neither a password nor a failure gets a step too', () => {
  const s = find(
    steps([it('trunk-groups/out', 'new')], [{key: 'trunk-groups/out', action: 'skip', because: 'trunks-sip/carrier'}]),
    /skipped/,
  );
  assert.equal(s.blocking, true);
  assert.match(s.why, /trunks-sip\/carrier/);
});

test('review 2: names and paths in commands are quoted for a shell; commas in names are escaped for --only', () => {
  const list = nextSteps({
    plan: {host: HOST, items: [it('queues/a b;$(x)', 'new'), it('queues/x,y', 'new')], welcomeMails: 0},
    results: [
      {key: 'queues/a b;$(x)', action: 'failed', error: 'e'},
      {key: 'queues/x,y', action: 'failed', error: 'e'},
    ],
    host: HOST,
    rerun: "wx-admin config import 'my dir' --pbx b.wildixin.com",
  });
  assert.equal(
    find(list, /failed/).command,
    "wx-admin config import 'my dir' --pbx b.wildixin.com --only 'queues:a b;$(x),queues:x\\,y' --overwrite",
  );
});

// The cloud groups.
const R = 'wx-admin config import ./exp --pbx b.wildixin.com --cloud';
const cloud = (items, results = []) =>
  nextSteps({plan: {host: HOST, items, welcomeMails: 0}, results, host: HOST, rerun: R});

test('a pending secret: rotate it', () => {
  const s = cloud([], [{key: 'wilma-secrets/api key', action: 'create', id: '1', pending: true}]).find((x) =>
    /Wilma secret/.test(x.what),
  );
  assert.equal(s.command, `wx-admin --pbx ${HOST} wilma secret rotate 'api key'`);
  assert.equal(s.blocking, true);
});

test('a source without configuration: configure it', () => {
  const s = cloud([], [{key: 'kb-sources/docs', action: 'create', id: '1', unconfigured: true}]).find((x) =>
    /KB source/.test(x.what),
  );
  assert.equal(s.what, 'Configure the KB source docs');
  assert.equal(s.command, `wx-admin --pbx ${HOST} kb source configure docs`);
});

test('a source created and configured here: start its first sync, one step per source; none when unconfigured', () => {
  const list = cloud(
    [],
    [
      {key: 'kb-sources/docs', action: 'create', id: '1', steps: ['create', 'configure']},
      {key: 'kb-sources/help desk', action: 'create', id: '2', steps: ['create', 'configure']},
      {key: 'kb-sources/drive', action: 'create', id: '3', unconfigured: true},
      {key: 'kb-sources/old', action: 'overwrite', id: '4'},
    ],
  );
  const syncs = list.filter((x) => /first sync/.test(x.what));
  assert.deepEqual(
    syncs.map((x) => [x.what, x.command, x.objects]),
    [
      [
        'Start the first sync of the knowledge-base source docs',
        `wx-admin --pbx ${HOST} kb source sync docs`,
        [{kind: 'kb-sources', name: 'docs'}],
      ],
      [
        'Start the first sync of the knowledge-base source help desk',
        `wx-admin --pbx ${HOST} kb source sync 'help desk'`,
        [{kind: 'kb-sources', name: 'help desk'}],
      ],
    ],
  );
  assert.ok(find(list, /Configure the KB source drive/));
});

test('an overwritten source without a token: its own step', () => {
  const s = cloud(
    [],
    [{key: 'kb-sources/docs', action: 'overwrite', id: '1', notes: ['configuration not changed: no API token given']}],
  ).find((x) => /API token/.test(x.what));
  assert.equal(s.command, `${R} --only kb-sources:docs --overwrite --secrets FILE`);
  assert.match(s.why, /config\.confluence\.apiKey/);
  assert.ok(s.why.includes(`wx-admin --pbx ${HOST} kb source configure docs`), s.why);
});

test('a generated webhook secret: give it to the receiver', () => {
  const s = cloud(
    [],
    [{key: 'integration-webhooks/https://h.example/x', action: 'create', id: '1', generated: {path: 'secret'}}],
  )[0];
  assert.equal(s.what, 'Give the new signing secret of https://h.example/x to its receiver (shown once in the output)');
  assert.equal(s.command, undefined);
});

test('a shared connection created: authorize it', () => {
  const s = cloud([], [{key: 'wilma-connections/gdrive', action: 'create', id: '1'}])[0];
  assert.equal(s.what, 'authorize gdrive in the WIM console');
  assert.equal(
    cloud([], [{key: 'wilma-connections/gdrive', action: 'overwrite', id: '1'}])[0].what.includes('authorize'),
    false,
  );
});

test('CRM not installed: re-run for it', () => {
  const s = cloud([
    it('integration-crm/hubspot', 'blocked', {
      reason: `not installed on ${HOST}: install it in the WIM console, then re-run`,
    }),
  ]).find((x) => /CRM/.test(x.what));
  assert.equal(s.command, `${R} --only integration-crm:hubspot`);
  assert.equal(
    cloud([it('integration-crm/hubspot', 'blocked', {reason: 'not installed on b: x'})]).some((x) =>
      /^Not written/.test(x.what),
    ),
    false,
  );
});

test('not synced yet: re-run for the skipped objects', () => {
  const s = cloud(
    [],
    [
      {
        key: 'kite-widgets/w1',
        action: 'skip',
        because: 'x-bees has not synced sales yet: re-run in a few minutes',
        syncWait: true,
      },
    ],
  ).find((x) => /Wait for x-bees/.test(x.what));
  assert.equal(s.command, `${R} --only kite-widgets:w1`);
});

test('blocked on a lookup: a ready --map fragment of the right kind', () => {
  const s0 = cloud([
    it('wilma-agents/a', 'blocked', {
      reason: `needs xbees-users/ann@x.example: not on ${HOST} (map it with --map)`,
      missing: {kind: 'xbees-users', name: 'ann@x.example'},
    }),
    it('kite-widgets/w', 'blocked', {
      reason: `needs xbees-services/Sales team: not on ${HOST} (map it with --map)`,
      missing: {kind: 'xbees-services', name: 'Sales team'},
    }),
    it('kite-channels/+123', 'blocked', {
      reason: `+123 is not a number or sender of ${HOST}: map it with --map`,
      missing: {kind: 'kite-channels', name: '+123'},
    }),
    // Its target read failed: not something a map fixes.
    it('wilma-agents/b', 'blocked', {
      reason: `needs xbees-users/bob@x.example: xbees-users cannot be read on ${HOST}: e`,
    }),
  ]);
  const s = s0.find((x) => /Map what/.test(x.what));
  const json = JSON.stringify({
    'xbees-users': {'ann@x.example': '<name on target>'},
    'xbees-services': {'Sales team': '<name on target>'},
    'kite-channels': {'+123': '<name on target>'},
  });
  assert.ok(s.what.includes(json), s.what);
  assert.equal(s.command, `${R} --map map.json`);
  assert.equal(s.objects.length, 3);
  assert.match(
    find(s0, /^Not written/).why,
    /wilma-agents\/b: needs xbees-users\/bob@x\.example: xbees-users cannot be read/,
  );
});

test('failed with a stage: re-run with --only and --overwrite', () => {
  const s = cloud([], [{key: 'wilma-agents/a', action: 'failed', stage: 'publish', id: '5', error: 'boom'}]).find((x) =>
    /part way/.test(x.what),
  );
  assert.equal(s.command, `${R} --only wilma-agents:a --overwrite`);
  assert.match(s.what, /at publish/);
});

test('cloud steps come after the PBX ones; no secret value in any step', () => {
  const list = cloud(
    [it('trunks-sip/a', 'new')],
    [
      {key: 'trunks-sip/a', action: 'skip', because: 'no password: settingsPbx.secret'},
      {key: 'wilma-secrets/s', action: 'create', id: '1', pending: true},
      {key: 'integration-webhooks/h', action: 'create', id: '2', generated: {path: 'secret'}},
    ],
  );
  assert.match(list[0].what, /password/);
  assert.match(list[1].what, /Wilma secret/);
  const results = [{key: 'integration-webhooks/h', action: 'create', generated: {path: 'secret'}}];
  Object.defineProperty(results, 'generatedSecrets', {value: {'integration-webhooks/h': {secret: 'GEN-VALUE-123'}}});
  const json = JSON.stringify(cloud([], results));
  assert.equal(json.includes('GEN-VALUE-123'), false);
  assert.equal(json.includes('GIVEN-VALUE-456'), false);
});

test('every cloud step command names the target PBX (a copy may have the source as default)', () => {
  const list = cloud(
    [],
    [
      {key: 'wilma-secrets/s', action: 'create', id: '1', pending: true},
      {key: 'kb-sources/docs', action: 'create', id: '2', unconfigured: true},
      {key: 'kb-sources/wiki', action: 'overwrite', id: '3', notes: ['configuration not changed: no API token given']},
    ],
  );
  const commands = list.map((s) => s.command).filter((c) => c && !c.startsWith(R));
  assert.equal(commands.length, 3, JSON.stringify(list));
  for (const c of commands) for (const one of c.split('; ')) assert.ok(one.startsWith(`wx-admin --pbx ${HOST} `), one);
  const why = list.find((s) => /API token/.test(s.what)).why;
  assert.ok(why.includes(`wx-admin --pbx ${HOST} kb source configure wiki`), why);
});

test('a cloud object skipped for a missing secret: give it, with --secrets FILE; never the trunk text', () => {
  const header = 'handler.mcp.authorization.customHeaders.X-Api-Key';
  const env = 'tools[0].sandbox.inline.env[0].value';
  const list = cloud(
    [it('wilma-tools/lookup', 'new'), it('wilma-skills/faq', 'new'), it('wilma-agents/Support', 'new')],
    [
      {key: 'wilma-tools/lookup', action: 'skip', because: `no secret: ${header}`},
      {key: 'wilma-skills/faq', action: 'skip', because: `no secret: ${env}`},
      {key: 'wilma-agents/Support', action: 'skip', because: 'wilma-tools/lookup'},
    ],
  );
  assert.equal(
    list.some((s) => /^Set the password|skipped:/.test(s.what)),
    false,
    JSON.stringify(list),
  );
  const s = find(list, /secret/);
  assert.equal(
    s.what,
    'Give the secrets of 2 objects: wilma-tools/lookup, wilma-skills/faq, then write what uses them: wilma-agents/Support',
  );
  assert.equal(
    s.why,
    `Secret values are never exported; none was given for these, so they were not written (nor what uses them): wilma-tools/lookup: ${header}; wilma-skills/faq: ${env}. The command asks for them in a terminal; else give them in --secrets FILE.`,
  );
  assert.equal(
    s.command,
    `${R} --only wilma-tools:lookup,wilma-skills:faq,wilma-agents:Support --overwrite --secrets FILE`,
  );
  assert.equal(s.blocking, true);
  assert.deepEqual(
    s.objects.map((o) => o.name),
    ['lookup', 'faq', 'Support'],
  );

  const one = find(cloud([], [{key: 'wilma-skills/faq', action: 'skip', because: `no secret: ${env}`}]), /secret/);
  assert.equal(one.what, `Give the secret ${env} of the Wilma skill faq`);
  // A trunk keeps its own step and words, next to the cloud one.
  const both = cloud(
    [],
    [
      {key: 'trunks-sip/a', action: 'skip', because: 'no password: settingsPbx.secret'},
      {key: 'wilma-skills/faq', action: 'skip', because: `no secret: ${env}`},
    ],
  );
  assert.equal(find(both, /password/).what, 'Set the password of the trunk a');
  assert.deepEqual(find(both, /password/).objects, [{kind: 'trunks-sip', name: 'a'}]);
  assert.equal(find(both, /Give the secret/).what, `Give the secret ${env} of the Wilma skill faq`);
});
