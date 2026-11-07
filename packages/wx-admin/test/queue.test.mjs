import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups} from '../src/commands/queue.mjs';
import {pbxClient} from '../src/pbx.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});

const SETTINGS = {
  queueManager: '',
  cid: '',
  autoPause: 'no',
  autoPauseTime: 5,
  autoPauseDelay: 0,
  autoPauseBusy: false,
  autoPauseUnAvail: false,
  maxLen: 5,
  retry: 1,
  ringInUse: false,
  strategy: 'wringall',
  defaultPriority: 1,
  timeout: 60,
  weight: 0,
  wrapUpTime: 120,
  rule: '',
  announce: {frequency: 0, holdTime: 'yes', roundSeconds: 5},
  exitAllMembers: {busy: false, paused: false, ringing: false},
  smsNumber: '',
  broadcast: '',
  broadcastPriority: '0',
  broadcastSkills: '',
  aclGroup: null,
};
const SUPPORT = {id: 2, title: 'Support', members: ['101@internalcalls', 'SIP/102'], settings: SETTINGS};

// A PBX with call groups in memory, as the three APIs show them (same ids), answers wrapped as the PBX does.
// POST/PUT answer "Success" without the object, as a real PBX does; POST wants retry, autoPauseTime,
// autoPauseDelay and maxLen in the settings.
function fakePbx(list = [SUPPORT]) {
  const store = new Map(list.map((g) => [g.id, structuredClone(g)]));
  const dynamic = new Map();
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), {status});
  const result = (r) => reply(200, {type: 'result', result: r});
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path: u.pathname, body});
    const p = u.pathname;
    const key = `${init.method} ${p}`;
    if (key === 'GET /api/v1/Dialplan/CallGroups/') return result({records: [...store.values()]});
    if (key === 'POST /api/v1/Dialplan/CallGroups/') {
      const missing = ['retry', 'autoPauseTime', 'autoPauseDelay', 'maxLen'].filter(
        (k) => !(k in (body.settings ?? {})),
      );
      if (missing.length)
        return reply(400, {
          type: 'error',
          reason: 'Validation error',
          errors: {settings: Object.fromEntries(missing.map((k) => [k, {code: 'FieldRequired'}]))},
        });
      const id = Math.max(0, ...store.keys()) + 1;
      store.set(id, {id, ...body, settings: {...body.settings, autoPauseBusy: false}});
      return result('Success');
    }
    let m = /^\/api\/v1\/Dialplan\/CallGroups\/(\d+)\/(stat)?$/.exec(p);
    if (m) {
      const g = store.get(Number(m[1]));
      if (!g) return reply(404, {type: 'error', reason: '404 Not Found'});
      if (m[2])
        return result({
          id: g.id,
          title: g.title,
          totalMembers: g.members.length,
          loggedMembers: 1,
          availableMembers: 1,
          busyMembers: 0,
          waitingCalls: 2,
        });
      if (init.method === 'PUT') {
        store.set(g.id, {id: g.id, ...body});
        return result('Success');
      }
      if (init.method === 'DELETE') {
        store.delete(g.id);
        return result('Success');
      }
    }
    m = /^\/api\/(v1\/PBX\/settings\/CallQueues|v2\/call-groups)\/(\d+)\/(members\/dynamic\/(.*))?$/.exec(p);
    if (m) {
      const id = Number(m[2]);
      if (!store.has(id)) return reply(404, {type: 'error', reason: 'Not found'});
      const set = dynamic.get(id) ?? new Set();
      dynamic.set(id, set);
      if (init.method === 'GET') {
        return result({
          id,
          name: store.get(id).title,
          members: [
            {
              name: 'Local/101@internalcalls',
              stateInterface: 'SIP/101',
              membership: 'static',
              penalty: '1',
              callsTaken: '3',
              status: '1',
              paused: '0',
            },
            ...[...set].map((name) => ({
              name,
              membership: 'dynamic',
              penalty: '0',
              callsTaken: '0',
              status: '2',
              paused: '1',
            })),
          ],
        });
      }
      if (init.method === 'POST') {
        if (set.has(body.member)) return reply(400, {type: 'error', reason: 'Unable to add interface: Already there'});
        set.add(body.member);
        return result({Response: 'Success', Message: 'Added interface to queue'});
      }
      if (init.method === 'DELETE') {
        const member = decodeURIComponent(m[4]);
        if (!set.delete(member)) return reply(400, {type: 'error', reason: 'Unable to remove interface: Not there'});
        return result({Response: 'Success', Message: 'Removed interface from queue'});
      }
    }
    if (key === 'POST /api/v2/call-groups/2/forward/') return result({message: 'Forward completed successfully'});
    return reply(404, {type: 'error', reason: '404 Not Found'});
  };
  return {fetch, calls, store, last: () => calls.at(-1)};
}

const registry = {groups};
const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry, ...options});

// The routes of the delegated managers live at /api/v2, outside /api/v1: they need pbxClient's `api: 'v2'` option.
const v2Ready = await (async () => {
  let seen;
  const client = await pbxClient({
    pbx: 'demo',
    env: env(),
    fetch: async (url) => {
      seen = url;
      return new Response('{"type":"result","result":null}');
    },
  });
  await client.call('GET', '/x', undefined, {api: 'v2'});
  return new URL(seen).pathname === '/api/v2/x';
})();
const needsV2 = v2Ready ? {} : {skip: 'pbxClient has no api: "v2" option yet (a shared change of src/pbx.mjs)'};

test('list and get (by name, with the members of the queue now) as text', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['queue', 'list'], {output: 'text'})).stdout, '2  Support  wringall  2 members\n');
  const r = await wx(pbx, ['queue', 'get', 'support', '--no-color'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.last().path, '/api/v1/PBX/settings/CallQueues/2/');
  assert.equal(
    r.stdout,
    [
      'Support (id 2): wringall, ring 60 s, wrap-up 120 s, up to 5 waiting',
      'members: 101, SIP/102',
      'now:',
      '  Local/101@internalcalls  static  not in use  3 calls',
      '',
    ].join('\n'),
  );
  const json = JSON.parse((await wx(pbx, ['queue', 'get', '2'])).stdout);
  assert.equal(json.liveMembers[0].stateInterface, 'SIP/101');
  assert.equal(json.settings.strategy, 'wringall');
  assert.equal((await wx(pbx, ['queue', 'get', 'nope'])).code, 64);
});

test('create: the required settings filled, options win, members as the PBX names them, the new id found', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['queue', 'create', 'Support'])).code, 64);
  assert.equal((await wx(pbx, ['queue', 'create', 'Sales', '--timeout', '500'])).code, 64);
  assert.equal((await wx(pbx, ['queue', 'create', 'Sales', '--member', '10 1'])).code, 64);
  assert.equal((await wx(pbx, ['queue', 'create', 'a/b'])).code, 64);
  assert.ok(!pbx.calls.some((c) => c.method === 'POST'));
  const r = await wx(
    pbx,
    [
      'queue',
      'create',
      'Sales',
      '--member',
      '201',
      '--member',
      '202,2',
      '--member',
      '203@other',
      '--strategy',
      'priority',
      '--timeout',
      '30',
      '--wrap-up',
      '10',
      '--max-len',
      '9',
    ],
    {output: 'text'},
  );
  assert.equal(r.code, 0, r.stderr);
  const post = pbx.calls.find((c) => c.method === 'POST').body;
  assert.equal(post.title, 'Sales');
  assert.deepEqual(post.members, ['201@internalcalls', '202@internalcalls,2', '203@other']);
  assert.equal(post.settings.strategy, 'priority');
  assert.equal(post.settings.timeout, 30);
  assert.equal(post.settings.wrapUpTime, 10);
  assert.equal(post.settings.maxLen, 9);
  assert.equal(post.settings.retry, 1);
  assert.equal(post.settings.autoPause, 'no');
  assert.equal(r.stdout.split('\n')[0], 'Created Sales (id 3): priority, ring 30 s, wrap-up 10 s, up to 9 waiting');
  assert.equal(pbx.store.get(3).title, 'Sales');
});

test('update: written back whole, readonly settings left out, --member replaces, members of the PBX kept as they are', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['queue', 'update', 'Support'])).code, 64);
  assert.equal((await wx(pbx, ['queue', 'update', 'Support', '--member', '1', '--no-members'])).code, 64);
  let r = await wx(pbx, ['queue', 'update', 'Support', '--timeout', '20', '--name', 'Help'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  const put = pbx.last();
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/api/v1/Dialplan/CallGroups/2/');
  assert.equal(put.body.title, 'Help');
  assert.deepEqual(put.body.members, ['101@internalcalls', 'SIP/102']);
  assert.equal(put.body.settings.timeout, 20);
  assert.equal(put.body.settings.wrapUpTime, 120);
  assert.equal(put.body.settings.smsNumber, '');
  assert.ok(!('autoPauseBusy' in put.body.settings) && !('autoPauseUnAvail' in put.body.settings));
  assert.deepEqual(put.body.settings.announce, {frequency: 0, holdTime: 'yes'});
  assert.equal(r.stdout.split('\n')[0], 'Updated Help (id 2): wringall, ring 20 s, wrap-up 120 s, up to 5 waiting');
  assert.equal((await wx(pbx, ['queue', 'update', '2', '--member', '301'])).code, 64); // replacing members needs --yes
  r = await wx(pbx, ['queue', 'update', '2', '--member', '301', '--yes']);
  assert.deepEqual(pbx.last().body.members, ['301@internalcalls']);
  r = await wx(pbx, ['queue', 'update', '2', '--no-members', '--yes']);
  assert.deepEqual(pbx.last().body.members, []);
});

test('delete needs --yes and takes names and ids', async () => {
  const pbx = fakePbx([SUPPORT, {...SUPPORT, id: 7, title: 'Old'}]);
  const no = await wx(pbx, ['queue', 'delete', 'Old']);
  assert.equal(no.code, 64);
  assert.match(no.stderr, /--yes/);
  assert.ok(!pbx.calls.some((c) => c.method === 'DELETE'));
  const r = await wx(pbx, ['queue', 'delete', 'Old', '2', '--yes'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    pbx.calls.filter((c) => c.method === 'DELETE').map((c) => c.path),
    ['/api/v1/Dialplan/CallGroups/7/', '/api/v1/Dialplan/CallGroups/2/'],
  );
  assert.equal(r.stdout, 'Deleted Old (id 7)\nDeleted Support (id 2)\n');
  assert.equal(pbx.store.size, 0);
});

test('stats: every queue, or the ones given (an id needs no list)', async () => {
  const pbx = fakePbx();
  const r = await wx(pbx, ['queue', 'stats', '--no-color'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.last().path, '/api/v1/Dialplan/CallGroups/2/stat');
  assert.equal(
    r.stdout,
    'id  queue    members  logged in  available  busy  waiting\n2   Support  2        1          1          0     2\n',
  );
  const one = fakePbx();
  await wx(one, ['queue', 'stats', '2']);
  assert.deepEqual(
    one.calls.map((c) => c.path),
    ['/api/v1/Dialplan/CallGroups/2/stat'],
  );
});

test('member-add and member-remove: dynamic members, the interface URI-encoded in the path', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['queue', 'member-add', '2', 'bad member'])).code, 64);
  assert.equal((await wx(pbx, ['queue', 'member-add', '2', '101', '--penalty', 'x'])).code, 64);
  const add = await wx(pbx, ['queue', 'member-add', '2', '101', '--penalty', '2', '--paused'], {output: 'text'});
  assert.equal(add.code, 0, add.stderr);
  assert.deepEqual(
    pbx.calls.map((c) => [c.method, c.path]),
    [['POST', '/api/v1/PBX/settings/CallQueues/2/members/dynamic/']],
  );
  assert.deepEqual(pbx.last().body, {member: 'Local/101@internalcalls', penalty: 2, paused: 1});
  assert.equal(add.stdout, 'Added Local/101@internalcalls to the queue 2 (Added interface to queue)\n');
  assert.equal((await wx(pbx, ['queue', 'member-add', 'Support', 'SIP/105'])).code, 0);
  assert.deepEqual(pbx.last().body, {member: 'SIP/105'});
  const again = await wx(pbx, ['queue', 'member-add', '2', '101']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /Already there/);
  const rm = await wx(pbx, ['queue', 'member-remove', '2', '101'], {output: 'text'});
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal(pbx.last().method, 'DELETE');
  assert.equal(pbx.last().path, '/api/v1/PBX/settings/CallQueues/2/members/dynamic/Local%2F101%40internalcalls');
  assert.equal(rm.stdout, 'Removed Local/101@internalcalls from the queue 2 (Removed interface from queue)\n');
});

test('--manager: dynamic members through /api/v2/call-groups', needsV2, async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['queue', 'member-add', '2', '101', '--manager'])).code, 0);
  assert.equal(pbx.last().path, '/api/v2/call-groups/2/members/dynamic/');
  assert.equal((await wx(pbx, ['queue', 'member-remove', '2', '101', '--manager'])).code, 0);
  assert.equal(pbx.last().path, '/api/v2/call-groups/2/members/dynamic/Local%2F101%40internalcalls');
});

test('forward: a call of the queue to a destination, through /api/v2', needsV2, async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['queue', 'forward', '2', 'abc@pbx', 'nobody'])).code, 64);
  const r = await wx(pbx, ['queue', 'forward', 'Support', 'e21b3ecf@pbx.local', '201'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pbx.last().path, '/api/v2/call-groups/2/forward/');
  assert.deepEqual(pbx.last().body, {sipCallId: 'e21b3ecf@pbx.local', destination: '201'});
  assert.equal(r.stdout, 'Forwarded the call to 201 (Forward completed successfully)\n');
});

test('forward refuses a bad destination before any request', async () => {
  const pbx = fakePbx();
  assert.equal((await wx(pbx, ['queue', 'forward', '2', 'abc@pbx', '20 1'])).code, 64);
  assert.equal(pbx.calls.length, 0);
});
