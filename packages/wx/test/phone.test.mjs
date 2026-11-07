// wx phone, the REST side (Call Control API of the PBX): every command with an injected fetch.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups} from '../src/commands/phone.mjs';
import {checkCallId, normNumber} from '../src/phone/pbx.mjs';
import {fakeFetch, fakeJwt, run} from './helpers.mjs';

const registry = {groups};
const claims = {
  email: 'me@example.com',
  name: 'Test User',
  'custom:pbx_domain': 'pbx.example.com',
  'custom:pbx_user_extension': '201',
  'custom:pbx_user_role': 'user',
  'custom:pbx_license': 'premium',
};
const token = fakeJwt(claims);
const env = {WILDIX_ID_TOKEN: token};
const API = 'https://pbx.example.com/api/v2/call-control';
const ok = (result = {message: 'done'}) => ({body: {type: 'result', result}});
const wx = (argv, options = {}) => run(['phone', ...argv], {env, registry, ...options});
const DEVICES = {
  devices: [
    {userAgent: 'wx watcher', contact: 'sip:201@w.invalid;transport=ws', active: true},
    {userAgent: 'Wildix W-AIR 1.0', contact: 'sip:201@10.0.0.5:5060', active: false},
    {
      userAgent: 'x-bees Web 2.82.0 8fde88b2-e732-4745-8398-0bc0b8967026',
      contact: 'sip:201@abc.invalid;transport=ws',
      active: false,
    },
  ],
};

test('phone me: the claims of the login and the PBX, no request', async () => {
  const fetch = fakeFetch();
  const r = await wx(['me'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    extension: '201',
    name: 'Test User',
    email: 'me@example.com',
    role: 'user',
    license: 'premium',
    pbx: 'https://pbx.example.com',
  });
  assert.equal(fetch.calls.length, 0);
  const t = await wx(['me'], {fetch, output: 'text'});
  assert.match(t.stdout, /^Extension +201$/m);
  assert.match(t.stdout, /^PBX +https:\/\/pbx\.example\.com$/m);
});

test('phone list: GET list-calls on the PBX of the login, the result unwrapped', async () => {
  const calls = {
    calls: [
      {
        sipCallId: 'abc123@pbx',
        callerNumber: '201',
        callerName: 'Me',
        calleeNumber: '202',
        calleeName: 'Anna',
        state: 'Up',
        duration: 65,
      },
    ],
    total: 1,
  };
  const fetch = fakeFetch(ok(calls));
  const r = await wx(['list'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), calls);
  const [call] = fetch.calls;
  assert.equal(call.url, `${API}/list-calls/`);
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.authorization, `Bearer ${token}`);
  assert.equal(call.redirect, 'error');
  const t = await wx(['list'], {fetch: fakeFetch(ok(calls)), output: 'text'});
  assert.equal(t.stdout.trim(), 'Up  1:05  201 Me  →  202 Anna  abc123@pbx');
  const empty = await wx(['list'], {fetch: fakeFetch(ok({calls: [], total: 0})), output: 'text'});
  assert.equal(empty.stdout.trim(), 'No calls now.');
});

test('the PBX port of the login is kept; a login without a PBX is refused before any request', async () => {
  const fetch = fakeFetch(ok({calls: [], total: 0}));
  const r = await wx(['list'], {fetch, env: {WILDIX_ID_TOKEN: fakeJwt({...claims, 'custom:pbx_port': '8443'})}});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, 'https://pbx.example.com:8443/api/v2/call-control/list-calls/');
  const none = fakeFetch();
  const n = await wx(['list'], {fetch: none, env: {WILDIX_ID_TOKEN: fakeJwt({email: 'x@example.com'})}});
  assert.equal(n.code, 64);
  assert.match(n.stderr, /not linked to a PBX/);
  assert.equal(none.calls.length, 0);
  const custom = await wx(['list'], {fetch: none, env: {...env, WILDIX_PBX_URL: 'https://evil.example'}});
  assert.equal(custom.code, 64);
  assert.equal(none.calls.length, 0);
});

test('phone call: the number normalized, the active real device picked (never a watcher)', async () => {
  const fetch = fakeFetch(ok(DEVICES), ok({message: 'Call initiated successfully'}));
  const r = await wx(['call', '+39 (02) 123-45.67'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {ok: true, message: 'Call initiated successfully'});
  assert.equal(fetch.calls[0].url, `${API}/list-devices/`);
  assert.equal(fetch.calls[1].url, `${API}/make-call/`);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.deepEqual(fetch.calls[1].body, {destination: '+39021234567', deviceContact: 'sip:201@10.0.0.5:5060'});
  const devices = {devices: [...DEVICES.devices.slice(0, 2), {...DEVICES.devices[2], active: true}]};
  const active = fakeFetch(ok(devices), ok());
  await wx(['call', '*76'], {fetch: active});
  assert.deepEqual(active.calls[1].body, {destination: '*76', deviceContact: 'sip:201@abc.invalid;transport=ws'});
});

test('phone call: no real device online is an error and nothing is dialled', async () => {
  const fetch = fakeFetch(ok({devices: [DEVICES.devices[0]]}));
  const r = await wx(['call', '202'], {fetch});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no device of this user is online/);
  assert.equal(fetch.calls.length, 1);
});

test('phone call --mobile, --any, --device; one of them only; a bad number or contact makes no request', async () => {
  for (const [flag, body] of [
    [['--mobile'], {destination: '202', callType: 'mobility'}],
    [['--any'], {destination: '202', callType: 'any'}],
    [
      ['--device', 'sip:201@10.0.0.5:5060'],
      {destination: '202', callType: 'device', deviceContact: 'sip:201@10.0.0.5:5060'},
    ],
  ]) {
    const fetch = fakeFetch(ok());
    const r = await wx(['call', '202', ...flag], {fetch});
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(fetch.calls[0].body, body);
  }
  const fetch = fakeFetch();
  for (const argv of [
    ['call', '202', '--mobile', '--any'],
    ['call', '202', '--device', '10.0.0.5'],
    ['call', 'abc'],
    ['call', '1'.repeat(41)],
    ['call', '202; rm'],
  ]) {
    const r = await wx(argv, {fetch});
    assert.equal(r.code, 64, argv.join(' '));
  }
  assert.equal(fetch.calls.length, 0);
  const t = await wx(['call', '202', '--mobile'], {
    fetch: fakeFetch(ok({message: 'Call initiated successfully'})),
    output: 'text',
  });
  assert.equal(
    t.stdout,
    'Call initiated successfully\nThe PBX rings your mobile first; it dials the number when you pick up.\n',
  );
});

test('phone answer, hold, unhold, hangup: POST with the call id', async () => {
  const id = "a1.b!c%d*e_f'g+h~i-j@pbx.example.com";
  for (const [cmd, path] of [
    ['hold', 'hold'],
    ['unhold', 'unhold'],
    ['hangup', 'hangup'],
    ['answer', 'answer'],
  ]) {
    const fetch = fakeFetch(ok({message: `${cmd} ok`}));
    const r = await wx([cmd, id], {fetch});
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {ok: true, message: `${cmd} ok`});
    assert.equal(fetch.calls[0].url, `${API}/${path}/`);
    assert.equal(fetch.calls[0].method, 'POST');
    assert.deepEqual(fetch.calls[0].body, {sipCallId: id});
  }
  const fetch = fakeFetch(ok());
  await wx(['answer', 'c1', '--device', 'sip:201@10.0.0.5'], {fetch});
  assert.deepEqual(fetch.calls[0].body, {sipCallId: 'c1', deviceContact: 'sip:201@10.0.0.5'});
  const t = await wx(['hold', 'c1'], {fetch: fakeFetch(ok({message: 'Call put on hold'})), output: 'text'});
  assert.equal(t.stdout, 'Call put on hold\n');
});

test('a call id that is not one is refused without a request', async () => {
  const fetch = fakeFetch();
  for (const bad of ['a b', 'a/b', '../x', 'x@y/z', 'a'.repeat(101), '']) {
    const r = await wx(['hangup', bad], {fetch});
    assert.equal(r.code, 64, bad);
  }
  assert.equal(fetch.calls.length, 0);
  assert.equal(checkCallId('abc@pbx-1.example.com'), 'abc@pbx-1.example.com');
  assert.equal(normNumber(' 2 0 1 '), '201');
  assert.equal(normNumber('#21#'), '#21#');
});

test('phone transfer and attended-transfer', async () => {
  const fetch = fakeFetch(ok());
  assert.equal((await wx(['transfer', 'c1', '305'], {fetch})).code, 0);
  assert.equal(fetch.calls[0].url, `${API}/blind-transfer/`);
  assert.deepEqual(fetch.calls[0].body, {sipCallId: 'c1', destination: '305'});
  const att = fakeFetch(ok());
  assert.equal((await wx(['attended-transfer', 'c1', 'c2'], {fetch: att})).code, 0);
  assert.equal(att.calls[0].url, `${API}/attendant-transfer/`);
  assert.deepEqual(att.calls[0].body, {sipCallId: 'c1', destination: 'c2'});
  const none = fakeFetch();
  const same = await wx(['attended-transfer', 'c1', 'c1'], {fetch: none});
  assert.equal(same.code, 64);
  assert.match(same.stderr, /transferred to itself/);
  assert.equal((await wx(['transfer', 'c1', 'x'], {fetch: none})).code, 64);
  assert.equal(none.calls.length, 0);
});

test('phone dtmf: parts of 10 digits in order; other characters refused', async () => {
  const fetch = fakeFetch(ok({message: 'a'}), ok({message: 'b'}), ok({message: 'c'}));
  const r = await wx(['dtmf', 'c1', '1234567890*#12345678901'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    fetch.calls.map((c) => c.body.digits),
    ['1234567890', '*#12345678', '901'],
  );
  assert.ok(fetch.calls.every((c) => c.url === `${API}/dtmf/` && c.body.sipCallId === 'c1'));
  assert.deepEqual(JSON.parse(r.stdout), {ok: true, message: 'c'});
  const none = fakeFetch();
  assert.equal((await wx(['dtmf', 'c1', '12a'], {fetch: none})).code, 64);
  assert.equal(none.calls.length, 0);
});

test('phone show-as: name and number; at least one; the name 1 to 100 characters', async () => {
  const fetch = fakeFetch(ok());
  const r = await wx(['show-as', 'c1', '--name', 'ACME Ltd', '--number', '+1 (555) 010-0000'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fetch.calls[0].url, `${API}/update-contact-info/`);
  assert.deepEqual(fetch.calls[0].body, {sipCallId: 'c1', name: 'ACME Ltd', number: '+15550100000'});
  const none = fakeFetch();
  for (const argv of [
    ['show-as', 'c1'],
    ['show-as', 'c1', '--name', ''],
    ['show-as', 'c1', '--name', 'x'.repeat(101)],
    ['show-as', 'c1', '--number', 'abc'],
  ]) {
    assert.equal((await wx(argv, {fetch: none})).code, 64, argv.join(' '));
  }
  assert.equal(none.calls.length, 0);
});

test('phone devices: the list with the watchers marked', async () => {
  const fetch = fakeFetch(ok(DEVICES));
  const r = await wx(['devices'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.devices[0].watcher, true);
  assert.equal(out.devices[1].watcher, undefined);
  assert.equal(fetch.calls[0].url, `${API}/list-devices/`);
  const skill = await wx(['devices'], {
    fetch: fakeFetch(ok({devices: [{userAgent: 'wildix-agent-skills watcher', contact: 'sip:x', active: false}]})),
  });
  assert.equal(JSON.parse(skill.stdout).devices[0].watcher, true);
  const t = await wx(['devices'], {fetch: fakeFetch(ok(DEVICES)), output: 'text'});
  assert.deepEqual(t.stdout.trimEnd().split('\n'), [
    'active watcher  wx watcher    sip:201@w.invalid;transport=ws',
    '                Wildix W-AIR  sip:201@10.0.0.5:5060',
    '                x-bees Web    sip:201@abc.invalid;transport=ws',
  ]);
});

test('phone use: a device by its contact (with its user agent), the mobile, all devices', async () => {
  const fetch = fakeFetch(ok(DEVICES), ok({message: 'Active device set'}));
  const r = await wx(['use', 'sip:201@10.0.0.5:5060'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {ok: true, message: 'Active device set'});
  assert.equal(fetch.calls[1].url, `${API}/set-active-device/`);
  assert.equal(fetch.calls[1].method, 'PUT');
  assert.deepEqual(fetch.calls[1].body, {
    deviceType: 'device',
    contact: 'sip:201@10.0.0.5:5060',
    userAgent: 'Wildix W-AIR 1.0',
  });
  for (const [flag, body] of [
    ['--mobile', {deviceType: 'mobility'}],
    ['--any', {deviceType: 'any'}],
  ]) {
    const f = fakeFetch(ok());
    assert.equal((await wx(['use', flag], {fetch: f})).code, 0);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].body, body);
  }
  const unknown = fakeFetch(ok(DEVICES));
  const u = await wx(['use', 'sip:999@nowhere'], {fetch: unknown});
  assert.equal(u.code, 1);
  assert.match(u.stderr, /no registered device of this user has the contact/);
  assert.equal(unknown.calls.length, 1);
  const watcher = fakeFetch(ok(DEVICES));
  const w = await wx(['use', 'sip:201@w.invalid;transport=ws'], {fetch: watcher});
  assert.equal(w.code, 1);
  assert.match(w.stderr, /SIP watcher/);
  assert.equal(watcher.calls.length, 1);
  const none = fakeFetch();
  for (const argv of [['use'], ['use', '--mobile', '--any'], ['use', 'sip:x', '--any'], ['use', '10.0.0.5']])
    assert.equal((await wx(argv, {fetch: none})).code, 64, argv.join(' '));
  assert.equal(none.calls.length, 0);
});

// fetch answering with a raw text body and a status.
const rawFetch = (status, text) => {
  const fn = async (url, init) => {
    fn.calls.push({url, ...init});
    return new Response(text, {status});
  };
  fn.calls = [];
  return fn;
};

test('PBX errors: the reason and a hint per status, exit 1, never the token', async () => {
  const cases = [
    [
      rawFetch(404, '<html><body><h1>404 Not Found</h1></body></html>'),
      /HTTP 404 from the PBX \(POST \/hold\/\): <html>.*\nThis PBX has no Call Control API/s,
    ],
    [
      fakeFetch({status: 404, body: {type: 'error', reason: 'Call not found', code: 404}}),
      /HTTP 404 from the PBX \(POST \/hold\/\): "Call not found"\nThe PBX does not see this call/,
    ],
    [
      fakeFetch({status: 401, body: {type: 'error', reason: 'Unauthorized'}}),
      /HTTP 401 .*\nThe PBX rejected the login: log in again/,
    ],
    [
      fakeFetch({status: 403, body: {type: 'error', reason: 'Forbidden'}}),
      /HTTP 403 .*\nThe PBX does not allow this to this user/,
    ],
    [
      fakeFetch({status: 503, body: {message: 'down'}}),
      /HTTP 503 from the PBX \(POST \/hold\/\): {"message":"down"}\nThe PBX could not reach its call engine/,
    ],
    [
      fakeFetch({status: 200, body: {type: 'error', reason: 'Validation failed'}}),
      /HTTP 200 from the PBX \(POST \/hold\/\): "Validation failed"$/m,
    ],
  ];
  for (const [fetch, expected] of cases) {
    const r = await wx(['hold', 'c1'], {fetch});
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, expected);
    assert.doesNotMatch(r.stderr, new RegExp(token.slice(0, 20)));
    assert.equal(r.stdout, '');
  }
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  const r = await wx(['list'], {fetch: down});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /request failed: GET \/list-calls\/ \(the PBX https:\/\/pbx\.example\.com did not answer\)/);
});

test('an answer without the result wrapper is printed as it is', async () => {
  const fetch = fakeFetch({body: {calls: [], total: 0}});
  const r = await wx(['list'], {fetch});
  assert.deepEqual(JSON.parse(r.stdout), {calls: [], total: 0});
});
