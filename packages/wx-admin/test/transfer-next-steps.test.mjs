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
  assert.match(find(list, /administer/).command, /acl groups/);
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
