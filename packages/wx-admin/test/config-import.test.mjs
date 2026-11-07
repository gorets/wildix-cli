import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {writeExport} from '../src/transfer/folder.mjs';
import {toPortable} from '../src/transfer/refs.mjs';
import {fakePbx} from './fake-pbx.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

// A folder exported from another PBX: a queue, a trunk with its password, a dialplan using both, a timetable.
function folder() {
  const portable = toPortable(
    {
      'trunks-sip': [
        {
          id: '3',
          name: 'carrier',
          data: {title: 'carrier', name: 'login', settingsPbx: {secret: 'old', context: 'main'}},
        },
      ],
      queues: [{id: '5', name: 'support', data: {title: 'support', members: [], settings: {}}}],
      timetables: [{id: '6', name: 'office', data: {title: 'office', items: [1]}}],
      dialplans: [
        {
          id: '1',
          name: 'main',
          data: {
            name: 'main',
            description: '',
            includedDialplans: [],
            numbers: [
              {
                number: '1',
                apps: [
                  {name: 'Queue', params: {queueId: '5'}},
                  {name: 'DialTrunk', params: {trunk: 'carrier'}},
                ],
              },
            ],
          },
        },
      ],
    },
    {serial: 'aaaa00000001', host: 'a.wildixin.com'},
  );
  const dir = path.join(tempConfigDir(), 'exp');
  writeExport({env: {}, cwd: tempConfigDir()}, dir, {source: {host: 'a.wildixin.com', wms: '7.11'}, portable});
  return dir;
}
const TARGET = () => ({
  '/PBX/settings/': {pbxSerial: 'bbbb00000002'},
  '/PBX/settings/license/': {limitations: {licenseTypes: {business: 5}}, licenseUsage: {business: 1}},
  '/Sounds/': {records: []},
  '/Sounds/MusicOnHold/': {records: []},
  '/Phonebooks/?count=1000': {records: []},
  '/Trunks/Sip/': [],
  '/Dialplan/CallGroups/': [],
  '/Dialplan/timeTables/': [{id: '60', title: 'office', items: [2]}],
  '/PBX/Dialplans/': [],
});
const SECRETS = () => {
  const f = path.join(tempConfigDir(), 'secrets.json');
  fs.writeFileSync(f, JSON.stringify({'trunks-sip/carrier': {password: 'new-pw'}}));
  return f;
};

async function importIt(args, {pbx = fakePbx(TARGET())} = {}) {
  const logDir = tempConfigDir();
  const r = await run(['config', 'import', folder(), '--pbx', 'demo', '--log', logDir, ...args], {
    env: env(),
    fetch: pbx.fetch,
  });
  const logs = fs.readdirSync(logDir);
  const log = logs.length ? fs.readFileSync(path.join(logDir, logs[0]), 'utf8') : '';
  return {r, pbx, logs, log, out: r.stdout ? JSON.parse(r.stdout) : undefined};
}
const writes = (pbx) => pbx.calls.filter((c) => c.method !== 'GET');

test('import --all --yes writes and logs', async () => {
  const {r, pbx, logs, log, out} = await importIt(['--all', '--yes', '--secrets', SECRETS()]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.state['/Dialplan/CallGroups/'].length, 1);
  assert.equal(pbx.state['/Trunks/Sip/'][0].settingsPbx.secret, 'new-pw');
  const main = pbx.state['/PBX/Dialplans/'].find((d) => d.name === 'main');
  assert.equal(main.numbers[0].apps[0].params.queueId, pbx.state['/Dialplan/CallGroups/'][0].id);
  assert.match(logs[0], /^wx-admin-import-demo\.wildixin\.com-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.log$/);
  assert.match(log, /create queues\/support id \d+/);
  assert.match(log, /next 1/);
  assert.equal(out.results.filter((x) => x.action === 'create').length, 3);
});

test('--dry-run writes nothing and still logs', async () => {
  const {r, pbx, log, out} = await importIt(['--all', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(writes(pbx), []);
  assert.match(log, /DRY RUN/);
  assert.equal(out.dryRun, true);
  assert.ok(out.nextSteps.length > 0);
});

test('without --yes and without a terminal nothing is written; without --all/--only it refuses', async () => {
  let x = await importIt(['--all']);
  assert.equal(x.r.code, 0, x.r.stderr);
  assert.deepEqual(writes(x.pbx), []);
  assert.equal(x.out.written, false);
  assert.match(x.log, /no --yes without a terminal/);
  x = await importIt([]);
  assert.equal(x.r.code, 64);
});

test('differs is skipped unless --overwrite', async () => {
  let x = await importIt(['--all', '--yes', '--secrets', SECRETS()]);
  assert.deepEqual(x.pbx.state['/Dialplan/timeTables/'][0].items, [2]);
  x = await importIt(['--all', '--overwrite', '--yes', '--secrets', SECRETS()]);
  assert.deepEqual(x.pbx.state['/Dialplan/timeTables/'][0].items, [1]);
  assert.ok(x.out.results.some((y) => y.key === 'timetables/office' && y.action === 'overwrite'));
});

test('--secrets fills trunk passwords; none in output or log', async () => {
  const {out, log, r} = await importIt(['--all', '--yes', '--secrets', SECRETS()]);
  assert.ok(!r.stdout.includes('new-pw') && !r.stderr.includes('new-pw') && !log.includes('new-pw'));
  assert.ok(out.results.some((y) => y.key === 'trunks-sip/carrier' && y.action === 'create'));
});

test('a trunk without a password is skipped, with what uses it, and the next steps say so', async () => {
  const {out} = await importIt(['--all', '--yes']);
  assert.deepEqual(
    out.results.find((y) => y.key === 'trunks-sip/carrier'),
    {key: 'trunks-sip/carrier', action: 'skip', because: 'no password: settingsPbx.secret'},
  );
  assert.equal(out.results.find((y) => y.key === 'dialplans/main').action, 'skip');
  assert.ok(out.nextSteps[0].blocking && /password/.test(out.nextSteps[0].what));
});

test('JSON output has plan, results, nextSteps, log; exit 1 when an object failed', async () => {
  const pbx = fakePbx(TARGET(), {
    failOn: ({method, path: p}) => method === 'POST' && p === '/Dialplan/CallGroups/' && 'Already present',
  });
  const {r, out} = await importIt(['--all', '--yes', '--secrets', SECRETS()], {pbx});
  assert.equal(r.code, 1);
  for (const k of ['plan', 'results', 'nextSteps', 'log']) assert.ok(k in out, k);
  assert.match(r.stderr, /1 objects failed/);
});

test('copy refuses the same PBX', async () => {
  const r = await run(['config', 'copy', '--from', 'demo', '--to', 'demo', '--all'], {
    env: env(),
    fetch: fakePbx(TARGET()).fetch,
  });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /the same PBX/);
});
