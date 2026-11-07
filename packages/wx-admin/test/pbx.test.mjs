import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {complete} from '../src/cli.mjs';
import {normalizeHost, savedAccess} from '../src/pbx.mjs';
import {fakeFetch, run, tempConfigDir} from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 7, 12);
const KEY = `wsk-v1-${'a'.repeat(93)}`;
const ok = (result) => ({body: {type: 'result', result}});

function home() {
  return {WILDIX_CONFIG_DIR: tempConfigDir()};
}
const add = (env, argv, secret, fetch = fakeFetch(ok({records: []}))) =>
  run(['pbx', 'add', ...argv], {env, fetch, stdin: `${secret}\n`, now: () => NOW});

test('a host: a bare name is a cloud PBX; host names and IPs as given; nothing else', () => {
  assert.equal(normalizeHost('demo'), 'demo.wildixin.com');
  assert.equal(normalizeHost('https://Demo.wildixin.com/x'), 'demo.wildixin.com');
  assert.equal(normalizeHost('10.0.0.5'), '10.0.0.5');
  for (const bad of ['', 'a b', 'demo.wildixin.com:443', '../x', 'demo..wildixin.com', '-demo.com'])
    assert.throws(() => normalizeHost(bad), bad);
});

test('pbx add reads the secret from stdin, checks it with one read, keeps it 0600, never prints it', async () => {
  const env = home();
  const fetch = fakeFetch(ok({records: []}));
  const r = await add(env, ['demo', '--api-key'], KEY, fetch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    host: 'demo.wildixin.com',
    port: 443,
    auth: 'apikey',
    serial: null,
    checked: true,
  });
  assert.equal(fetch.calls[0].url, 'https://demo.wildixin.com/api/v1/Dictionaries');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(fetch.calls[0].redirect, 'error');
  const file = path.join(env.WILDIX_CONFIG_DIR, 'admin', 'pbx', 'demo.wildixin.com.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
});

test('pbx add refuses a malformed key, two kinds, and keeps nothing when the PBX refuses the access', async () => {
  const env = home();
  assert.equal((await add(env, ['demo', '--api-key'], 'wsk-v1-short')).code, 64);
  assert.equal((await add(env, ['demo', '--api-key', '--token'], KEY)).code, 64);
  const refused = await add(
    env,
    ['demo', '--basic', '--user', 'admin'],
    'pw',
    fakeFetch({status: 401, body: {type: 'error', reason: 'Unauthorized'}}),
  );
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /ALLOW_BASIC_AUTH/);
  assert.equal(savedAccess('demo.wildixin.com', env), undefined);
});

test('a refused new access gives back the access saved before', async () => {
  const env = home();
  await add(env, ['demo', '--token'], 'tok-1');
  await add(env, ['demo', '--token'], 'tok-2', fakeFetch({status: 401, body: {}}));
  assert.equal(savedAccess('demo.wildixin.com', env).token, 'tok-1');
});

test('several PBX: the only saved one, --pbx anywhere, the default one; several without a default exit 2', async () => {
  const env = home();
  const urlOf = async (argv) => {
    const fetch = fakeFetch(ok({records: []}));
    const r = await run(argv, {env, fetch, now: () => NOW});
    return [fetch.calls[0]?.url, fetch.calls[0]?.headers.authorization.split(' ')[0], r.code];
  };
  await add(env, ['one', '--token'], 'tok-1');
  assert.deepEqual(await urlOf(['dialplan', 'list']), ['https://one.wildixin.com/api/v1/PBX/Dialplans/', 'Bearer', 0]);
  await add(env, ['two', '--basic'], 'pw-2');
  const several = await run(['dialplan', 'list'], {env, fetch: fakeFetch()});
  assert.equal(several.code, 2);
  assert.match(
    several.stderr,
    /Several PBX are saved and none is the default: give --pbx or run wx-admin pbx use <host>/,
  );
  assert.deepEqual(await urlOf(['dialplan', 'list', '--pbx', 'two']), [
    'https://two.wildixin.com/api/v1/PBX/Dialplans/',
    'Basic',
    0,
  ]);
  assert.equal((await run(['pbx', 'use', 'one'], {env})).code, 0);
  assert.deepEqual(await urlOf(['--pbx=two.wildixin.com', 'dialplan', 'list']), [
    'https://two.wildixin.com/api/v1/PBX/Dialplans/',
    'Basic',
    0,
  ]);
  assert.deepEqual(await urlOf(['dialplan', 'list']), ['https://one.wildixin.com/api/v1/PBX/Dialplans/', 'Bearer', 0]);
  const list = JSON.parse((await run(['pbx', 'list'], {env})).stdout);
  assert.deepEqual(
    list.pbxs.map((p) => [p.host, p.auth, p.default]),
    [
      ['one.wildixin.com', 'token', true],
      ['two.wildixin.com', 'password', false],
    ],
  );
  assert.equal(list.login, undefined);
  assert.equal((await run(['pbx', 'use', '--login'], {env})).code, 64);
  assert.equal((await run(['pbx', 'remove', 'two'], {env})).code, 0);
  assert.equal((await run(['dialplan', 'list', '--pbx', 'two'], {env, fetch: fakeFetch()})).code, 2);
  assert.deepEqual(complete(['--pbx', ''], env), ['one.wildixin.com\ttoken']);
  assert.deepEqual(complete(['pbx', 'use', 'o'], env), ['one.wildixin.com\ttoken']);
});

test('wx-admin has no x-bees login: no profile command, no --profile', async () => {
  const env = home();
  assert.equal((await run(['profile', 'list'], {env})).code, 64);
  assert.equal((await run(['pbx', 'list', '--profile', 'a@b.c'], {env})).code, 64);
  const help = await run([], {env, output: 'text'});
  assert.doesNotMatch(help.stdout, /--profile|x-bees login|e-mail/);
});

test('WILDIX_PBX_API_KEY goes only to WILDIX_PBX_HOST: never to another --pbx, never with --all-pbx', async () => {
  const env = {...home(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'ci'};
  let fetch = fakeFetch(ok({records: []}));
  assert.equal((await run(['dialplan', 'list'], {env, fetch})).code, 0);
  assert.equal(fetch.calls[0].url, 'https://ci.wildixin.com/api/v1/PBX/Dialplans/');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${KEY}`);
  fetch = fakeFetch(ok({records: []}));
  assert.equal((await run(['dialplan', 'list', '--pbx', 'ci.wildixin.com'], {env, fetch})).code, 0);
  fetch = fakeFetch();
  const other = await run(['dialplan', 'list', '--pbx', 'attacker.example.com'], {env, fetch});
  assert.equal(other.code, 64);
  assert.equal(fetch.calls.length, 0);
  assert.equal((await run(['--all-pbx', 'dialplan', 'list'], {env, fetch})).code, 64);
  assert.equal(fetch.calls.length, 0);
  assert.equal((await run(['dialplan', 'list'], {env: {...env, WILDIX_PBX_HOST: undefined}, fetch})).code, 64);
  assert.equal((await run(['dialplan', 'list'], {env: {...env, WILDIX_PBX_API_KEY: 'nope'}, fetch})).code, 64);
});

test('pbx add checks the new access itself, never the key of the environment, and saves only after the check', async () => {
  const env = {...home(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'ci'};
  const fetch = fakeFetch({status: 401, body: {}});
  const r = await add(env, ['demo', '--token'], 'wrong-token', fetch);
  assert.equal(r.code, 2);
  assert.equal(fetch.calls[0].url, 'https://demo.wildixin.com/api/v1/Dictionaries');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer wrong-token');
  assert.equal(savedAccess('demo.wildixin.com', env), undefined);
});

test('a refusal says what to do, by the kind of access and the scope of the route', async () => {
  const env = {...home(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'ci'};
  const r403 = await run(['dialplan', 'list', '--pbx', 'ci'], {
    env,
    fetch: fakeFetch({status: 403, body: {type: 'error', reason: 'Access error', code: 'AccessError'}}),
  });
  assert.equal(r403.code, 2);
  assert.match(r403.stderr, /the scope dialplan:read \(or pbx:read\)/);
  const r401 = await run(['dialplan', 'list', '--pbx', 'ci'], {env, fetch: fakeFetch({status: 401, body: {}})});
  assert.equal(r401.code, 2);
  assert.match(r401.stderr, /expired or been deleted.*Company API Keys/s);
  assert.ok(!r401.stderr.includes(KEY));
});

test('no PBX at all: a hint to sign in to one', async () => {
  const r = await run(['dialplan', 'list'], {env: home(), fetch: fakeFetch()});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No PBX chosen: wx-admin login <host>/);
});

test('wx-admin api: GET reads; other methods need --yes; the path stays under /api/v1', async () => {
  const env = {...home(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'ci'};
  let fetch = fakeFetch(ok({records: [1]}));
  let r = await run(['api', 'get', '/Colleagues/', '--query', 'start=0', '--query', 'count=5', '--pbx', 'ci'], {
    env,
    fetch,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {records: [1]});
  assert.equal(fetch.calls[0].url, 'https://ci.wildixin.com/api/v1/Colleagues/?start=0&count=5');
  assert.equal((await run(['api', 'DELETE', '/Colleagues/1/', '--pbx', 'ci'], {env, fetch: fakeFetch()})).code, 64);
  fetch = fakeFetch(ok({id: 9}));
  r = await run(['api', 'POST', '/PBX/Dialplans/', '--data', '{"name":"x"}', '--yes', '--pbx', 'ci'], {env, fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {name: 'x'});
  for (const bad of ['/../etc', 'PBX/x', '/a b', '/x#y'])
    assert.equal((await run(['api', 'GET', bad, '--pbx', 'ci'], {env, fetch: fakeFetch()})).code, 64, bad);
});

test('--all-pbx: a command that reads runs on every PBX; one that fails does not stop the others; writes are refused', async () => {
  const env = home();
  await add(env, ['one', '--token'], 'tok-1');
  await add(env, ['two', '--token'], 'tok-2');
  const fetch = async (url) => {
    const host = new URL(url).host;
    if (host === 'two.wildixin.com')
      return new Response(JSON.stringify({type: 'error', reason: 'Access error'}), {status: 403});
    return new Response(JSON.stringify({type: 'result', result: {records: [{id: 1, name: host, description: ''}]}}), {
      status: 200,
    });
  };
  const r = await run(['--all-pbx', 'dialplan', 'list'], {env, fetch, now: () => NOW});
  assert.equal(r.code, 1);
  const {results} = JSON.parse(r.stdout);
  assert.deepEqual(
    results.map((x) => [x.pbx, Boolean(x.result), Boolean(x.error)]),
    [
      ['one.wildixin.com', true, false],
      ['two.wildixin.com', false, true],
    ],
  );
  const text = await run(['dialplan', 'list', '--all-pbx', '--no-color'], {env, fetch, now: () => NOW, output: 'text'});
  assert.match(text.stdout, /^== one\.wildixin\.com\n1 {2}one\.wildixin\.com/m);
  assert.match(text.stdout, /^== two\.wildixin\.com\nHTTP 403/m);
  assert.equal((await run(['--all-pbx', 'dialplan', 'delete', 'x', '--yes'], {env, fetch})).code, 64);
  assert.equal((await run(['--all-pbx', '--pbx', 'one', 'dialplan', 'list'], {env, fetch})).code, 64);
});

test('--pbx by serial: bare or as <serial>.wildixin.com, for saved access (recorded by pbx add)', async () => {
  const env = home();
  // pbx add reads the serial from the settings of the PBX
  const fetch = fakeFetch(ok({records: []}), ok({pbxSerial: '2211000000EF'}));
  const added = await add(env, ['one', '--token'], 'tok-1', fetch);
  assert.equal(JSON.parse(added.stdout).serial, '2211000000ef');
  const urlOf = async (pbx) => {
    const f = fakeFetch(ok({records: []}));
    await run(['dialplan', 'list', '--pbx', pbx], {env, fetch: f, now: () => NOW});
    return f.calls[0]?.url;
  };
  assert.equal(await urlOf('2211000000ef'), 'https://one.wildixin.com/api/v1/PBX/Dialplans/');
  assert.equal(await urlOf('2211000000EF.wildixin.com'), 'https://one.wildixin.com/api/v1/PBX/Dialplans/');
  assert.deepEqual(complete(['--pbx', '2211'], env), ['2211000000ef\tone.wildixin.com']);
});
