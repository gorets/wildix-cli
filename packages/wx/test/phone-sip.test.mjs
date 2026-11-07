// wx phone, the SIP side: the XML reader, the event parsers, the SIP messages and digest, and the commands that go
// over SIP (watch, list --sip, record, conference-transfer) against a fake PBX on a fake WebSocket. No network.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {afterEach, beforeEach, test} from 'node:test';
import {groups, sipIo} from '../src/commands/phone.mjs';
import {backoffMs} from '../src/phone/control.mjs';
import {CallTracker, deviceName, parseActiveDevice, parseDialogInfo, parseRegInfo} from '../src/phone/events.mjs';
import {digestAuthorization, parseChallenge, parseMessage, tagOf, uriOf} from '../src/phone/sip.mjs';
import {parseXml} from '../src/phone/xml.mjs';
import {fakeFetch, fakeJwt, run} from './helpers.mjs';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const registry = {groups};
const token = fakeJwt({
  email: 'me@example.com',
  'custom:pbx_domain': 'pbx.example.com',
  'custom:pbx_user_extension': '201',
});
const env = {WILDIX_ID_TOKEN: token};
const SIP_PASSWORD = 'sip-secret-pw';
const info = (result = {extension: '201', sipPassword: SIP_PASSWORD}) => ({body: {type: 'result', result}});
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// ---- unit: XML, parsers, SIP messages

test('parseXml: elements, attributes, entities, CDATA, prefixes; refuses a DOCTYPE and broken XML', () => {
  const root = parseXml(
    '<?xml version="1.0"?><!-- c --><a:root xmlns:a="x"><b k="1 &amp; 2" j=\'q\'>t&lt;x&gt;&#65;&#x42;</b><c/><d><![CDATA[<raw>]]></d></a:root>',
  );
  assert.equal(root.name, 'root');
  assert.deepEqual(
    root.children.map((c) => c.name),
    ['b', 'c', 'd'],
  );
  assert.deepEqual(root.children[0].attrs, {k: '1 & 2', j: 'q'});
  assert.equal(root.children[0].text, 't<x>AB');
  assert.equal(root.children[2].text, '<raw>');
  for (const bad of ['<!DOCTYPE x [<!ENTITY a "b">]><x/>', '<a><b></a>', '<a>', '<a/><b/>', 'text', '<a><</a>'])
    assert.throws(() => parseXml(bad), bad);
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

function dialogXml(calls, {status = 'ONLINE', custom} = {}) {
  const dialogs = calls.map(
    (
      c,
    ) => `<dialog id="d-${c.id}" call-id="${c.id}" direction="${c.direction === 'outbound' ? 'initiator' : 'recipient'}">
      <state${c.reason ? ` reason="${c.reason}"` : ''}>${c.state}</state>${c.hold ? '<note>On hold</note>' : ''}
      <local><identity${c.name ? ` display="${c.name}"` : ''}>sip:${c.number}@pbx.example.com</identity><target uri="sip:x"><param pname="X-Wildix-record" pval="${c.otherRecording ?? 'off'}"/></target></local>
      <remote><identity>sip:201@pbx.example.com</identity><target uri="sip:201@pbx.example.com">
        <param pname="X-Wildix-record" pval="${c.recording ?? 'off'}"/>${c.tags ? `<param pname="X-Wildix-tags" pval="${c.tags}"/>` : ''}
        <param pname="X-Wildix-state" pval="${status}"/>${custom ? `<param pname="X-Wildix-custom" pval="${b64(custom)}"/>` : ''}
      </target></remote>
    </dialog>`,
  );
  const presence = calls.length
    ? ''
    : `<dialog id="p"><param pname="X-Wildix-state" pval="${status}"/>${custom ? `<param pname="X-Wildix-custom" pval="${b64(custom)}"/>` : ''}</dialog>`;
  return `<?xml version="1.0"?>\n<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" version="1" state="full" entity="sip:201@pbx.example.com">${dialogs.join('')}${presence}</dialog-info>`;
}

const regXml = (contacts) =>
  `<?xml version="1.0"?><reginfo xmlns="urn:ietf:params:xml:ns:reginfo" version="0" state="full"><registration aor="sip:201@pbx.example.com" id="r" state="active">${contacts
    .map(
      (c, i) =>
        `<contact id="c${i}" state="${c.state ?? 'active'}" event="registered" user_agent="${c.ua}"><uri>${c.uri}</uri></contact>`,
    )
    .join('')}</registration></reginfo>`;

const activeXml = (type, contact, ua) =>
  `<?xml version="1.0"?><active-device><type>${type}</type>${contact ? `<contact>${contact}</contact>` : ''}${ua ? `<user-agent>${ua}</user-agent>` : ''}</active-device>`;

test('parseDialogInfo: calls with state, hold, remote party, tags, recording, and the presence', () => {
  const xml = dialogXml(
    [
      {
        id: 'call-1@pbx',
        direction: 'outbound',
        state: 'confirmed',
        hold: true,
        number: '202',
        name: 'Anna &amp; Co',
        recording: 'personal',
        tags: 'vip, support',
      },
    ],
    {status: 'DND', custom: {message: 'in a meeting', untilTime: '2026-11-07T18:00:00Z'}},
  );
  const {dialogs, presence} = parseDialogInfo(xml);
  assert.deepEqual(dialogs, [
    {
      id: 'call-1@pbx',
      direction: 'outbound',
      rawState: 'confirmed',
      rawStateReason: undefined,
      hold: true,
      remoteName: 'Anna & Co',
      remoteNumber: '202',
      tags: ['vip', 'support'],
      recording: 'personal',
    },
  ]);
  assert.deepEqual(presence, {status: 'dnd', message: 'in a meeting', until: '2026-11-07T18:00:00Z'});
  const paused = parseDialogInfo(
    dialogXml([{id: 'c', state: 'early', number: '1', recording: 'personal', otherRecording: 'paused'}]),
  ).dialogs[0];
  assert.equal(paused.recording, 'paused');
  assert.equal(paused.direction, 'inbound');
});

test('CallTracker: started, updated, ended (also a call that is missing from the next state)', () => {
  const t = new CallTracker();
  const d = (id, rawState, extra = {}) => ({
    id,
    direction: 'inbound',
    rawState,
    hold: false,
    remoteNumber: '1',
    ...extra,
  });
  let r = t.apply([d('a', 'early'), d('b', 'confirmed')]);
  assert.deepEqual(
    [r.started.map((c) => [c.id, c.state]), r.updated, r.ended],
    [
      [
        ['a', 'ringing'],
        ['b', 'answered'],
      ],
      [],
      [],
    ],
  );
  r = t.apply([d('a', 'confirmed', {hold: true}), d('b', 'confirmed')]);
  assert.deepEqual(
    r.updated.map((c) => [c.id, c.state]),
    [['a', 'held']],
  );
  r = t.apply([d('a', 'terminated', {rawStateReason: 'remote-bye'})]);
  assert.deepEqual(
    r.ended.map((c) => [c.id, c.state, c.endReason]),
    [
      ['a', 'ended', 'remote-bye'],
      ['b', 'ended', undefined],
    ],
  );
  assert.deepEqual(t.list(), []);
});

test('parseRegInfo and parseActiveDevice; deviceName drops versions and UUIDs', () => {
  const devices = parseRegInfo(
    regXml([
      {ua: 'x-bees Web 2.82.0 8fde88b2-e732-4745-8398-0bc0b8967026', uri: 'sip:201@a.invalid'},
      {ua: 'WildixGW 1.0', uri: 'sip:gw'},
      {ua: 'Old', uri: 'sip:old', state: 'terminated'},
      {ua: '', uri: 'sip:none'},
    ]),
  );
  assert.deepEqual(devices, [
    {uri: 'sip:201@a.invalid', userAgent: 'x-bees Web 2.82.0 8fde88b2-e732-4745-8398-0bc0b8967026'},
  ]);
  assert.equal(deviceName(devices[0].userAgent), 'x-bees Web');
  assert.equal(deviceName('Collaboration-8fde88b2-e732-4745-8398-0bc0b8967026'), 'Collaboration');
  assert.equal(deviceName(''), 'Unknown device');
  assert.deepEqual(parseActiveDevice(activeXml('device', 'sip:201@a.invalid', 'x-bees Web')), {
    type: 'device',
    contactUri: 'sip:201@a.invalid',
    userAgent: 'x-bees Web',
  });
  assert.equal(parseActiveDevice('<active-device/>'), null);
});

test('digestAuthorization: the RFC 2617 example; parseChallenge', () => {
  const challenge = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  );
  assert.equal(challenge.realm, 'testrealm@host.com');
  const value = digestAuthorization({
    username: 'Mufasa',
    password: 'Circle Of Life',
    method: 'GET',
    uri: '/dir/index.html',
    challenge,
    nc: 1,
    cnonce: '0a4f113b',
  });
  assert.match(value, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(value, /qop=auth, cnonce="0a4f113b", nc=00000001/);
  assert.match(value, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  assert.throws(
    () =>
      digestAuthorization({
        username: 'a',
        password: 'b',
        method: 'X',
        uri: 'u',
        challenge: {realm: 'r', nonce: 'n', algorithm: 'SHA-256'},
      }),
    /MD5/,
  );
  assert.equal(parseChallenge('Basic realm="x"'), undefined);
});

test('parseMessage: requests, responses, compact headers, folded lines, body', () => {
  const m = parseMessage(
    'NOTIFY sip:201@x.invalid;transport=ws SIP/2.0\r\nv: SIP/2.0/WSS a;branch=z9hG4bK1\r\nf: <sip:201@pbx>;tag=srv\r\nt: <sip:201@pbx>;tag=me\r\ni: cid\r\nSubscription-State: active;\r\n expires=60\r\nl: 4\r\n\r\nbody',
  );
  assert.equal(m.method, 'NOTIFY');
  assert.equal(m.header('call-id'), 'cid');
  assert.equal(tagOf(m.header('from')), 'srv');
  assert.equal(m.header('subscription-state'), 'active; expires=60');
  assert.equal(m.body, 'body');
  const r = parseMessage(
    'SIP/2.0 202 Accepted\r\nTo: "A ;tag=x" <sip:201@pbx;tag=no>;tag=yes\r\nContact: <sip:pbx@10.0.0.1;transport=ws>;expires=5\r\n\r\n',
  );
  assert.equal(r.status, 202);
  assert.equal(tagOf(r.header('to')), 'yes');
  assert.equal(uriOf(r.header('contact')), 'sip:pbx@10.0.0.1;transport=ws');
  assert.throws(() => parseMessage('HTTP/1.1 200 OK\r\n\r\n'));
});

test('backoff: 3 s, then up to 30 s over five attempts', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffMs), [3000, 4688, 9750, 18188, 30000, 30000]);
});

// ---- the fake PBX

const REALM = 'pbx.example.com';
const NONCE = 'nonce-123';

function authParams(value) {
  const out = {};
  for (const m of String(value)
    .replace(/^Digest\s+/, '')
    .matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g))
    out[m[1]] = m[2] ?? m[3];
  return out;
}

class FakePbx {
  constructor({
    password = SIP_PASSWORD,
    publishStatus = [200, 'OK'],
    registerStatus,
    calls = [],
    devices,
    activeDevice = ['device', 'sip:201@phone.invalid', 'x-bees Web 2.0'],
    presence = {status: 'ONLINE'},
  } = {}) {
    Object.assign(this, {password, publishStatus, registerStatus, calls, presence, activeDevice});
    this.devices = devices ?? [
      {ua: 'x-bees Web 2.0 8fde88b2-e732-4745-8398-0bc0b8967026', uri: 'sip:201@phone.invalid'},
    ];
    this.requests = []; // requests the client sent
    this.responses = []; // responses the client sent
    this.sockets = [];
    this.subs = []; // {pkg, callId, fromTag, ws}
    this.publishes = [];
    this.badAuth = 0;
    const pbx = this;
    this.WebSocket = class {
      constructor(url, protocol) {
        Object.assign(this, {url, protocol, readyState: 0, listeners: {}});
        pbx.sockets.push(this);
        setImmediate(() => {
          this.readyState = 1;
          this.fire('open', {});
        });
      }
      addEventListener(type, fn) {
        (this.listeners[type] ??= []).push(fn);
      }
      fire(type, e) {
        for (const fn of this.listeners[type] ?? []) fn(e);
      }
      send(text) {
        if (this.readyState !== 1) throw new Error('not open');
        pbx.receive(this, text);
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        setImmediate(() => this.fire('close', {}));
      }
      push(text) {
        setImmediate(() => this.readyState === 1 && this.fire('message', {data: text}));
      }
      drop() {
        this.readyState = 3;
        this.fire('close', {});
      }
    };
  }

  get ws() {
    return this.sockets[this.sockets.length - 1];
  }

  respond(ws, req, status, reason, extra = []) {
    const to = req.header('to');
    const lines = [
      `SIP/2.0 ${status} ${reason}`,
      ...req.headers('via').map((v) => `Via: ${v}`),
      `To: ${tagOf(to) ? to : `${to};tag=srv${this.requests.length}`}`,
      `From: ${req.header('from')}`,
      `Call-ID: ${req.header('call-id')}`,
      `CSeq: ${req.header('cseq')}`,
      ...extra,
      'Content-Length: 0',
      '',
      '',
    ];
    ws.push(lines.join('\r\n'));
  }

  authorized(req) {
    const auth = req.header('authorization');
    if (!auth) return false;
    const p = authParams(auth);
    const ha1 = md5(`${p.username}:${p.realm}:${this.password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const ok =
      p.username === '201' &&
      p.nonce === NONCE &&
      p.uri === req.uri &&
      p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    if (!ok) this.badAuth += 1;
    return ok;
  }

  receive(ws, text) {
    if (!text.trim()) return;
    const m = parseMessage(text);
    if (m.status !== undefined) return this.responses.push(m);
    this.requests.push(m);
    if (['REGISTER', 'SUBSCRIBE', 'PUBLISH'].includes(m.method) && !this.authorized(m)) {
      if (m.header('authorization')) return this.respond(ws, m, 403, 'Forbidden');
      return this.respond(ws, m, 401, 'Unauthorized', [
        `WWW-Authenticate: Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=MD5`,
      ]);
    }
    if (m.method === 'REGISTER') {
      if (this.registerStatus) return this.respond(ws, m, ...this.registerStatus);
      this.contact = uriOf(m.header('contact'));
      return this.respond(ws, m, 200, 'OK', [`Contact: ${m.header('contact')}`]);
    }
    if (m.method === 'SUBSCRIBE') {
      const pkg = m.header('event');
      const expires = Number(m.header('expires'));
      const known = this.subs.find((s) => s.callId === m.header('call-id'));
      this.respond(ws, m, 202, 'Accepted', ['Contact: <sip:pbx@10.0.0.1;transport=ws>', `Expires: ${expires}`]);
      // As a real PBX does (RFC 6665): an unsubscribe gets a last NOTIFY with the state, "terminated".
      if (known && expires === 0) return this.notify(pkg, 'terminated;reason=timeout');
      if (!known && expires > 0) {
        this.subs.push({pkg, callId: m.header('call-id'), fromTag: tagOf(m.header('from')), ws});
        if (this.subs.filter((s) => s.ws === ws).length === 3) {
          // The full state once all three are up: devices, ringing mode, then the calls (ready).
          this.notify('reg');
          this.notify('active-device');
          this.notify('dialog');
        }
      }
      return undefined;
    }
    if (m.method === 'PUBLISH') {
      this.publishes.push(m);
      return this.respond(ws, m, ...this.publishStatus);
    }
    return this.respond(ws, m, 405, 'Method Not Allowed');
  }

  body(pkg) {
    if (pkg === 'dialog') return dialogXml(this.calls, this.presence);
    if (pkg === 'reg')
      return regXml([...this.devices, ...(this.contact ? [{ua: 'wx watcher', uri: this.contact}] : [])]);
    return activeXml(...this.activeDevice);
  }

  notify(pkg, state = 'active;expires=120') {
    const sub = this.subs.filter((s) => s.pkg === pkg && s.ws === this.ws).pop();
    const body = this.body(pkg);
    const lines = [
      `NOTIFY ${this.contact ?? 'sip:201@x.invalid'} SIP/2.0`,
      `Via: SIP/2.0/WSS 10.0.0.1;branch=z9hG4bKn${Math.random().toString(36).slice(2)}`,
      `From: <sip:201@pbx.example.com>;tag=srv-${pkg}`,
      `To: <sip:201@pbx.example.com>;tag=${sub.fromTag}`,
      `Call-ID: ${sub.callId}`,
      'CSeq: 1 NOTIFY',
      `Event: ${pkg}`,
      `Subscription-State: ${state}`,
      'Contact: <sip:pbx@10.0.0.1;transport=ws>',
      'Content-Type: application/xml',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ];
    this.ws.push(lines.join('\r\n'));
  }

  request(method) {
    const lines = [
      `${method} ${this.contact} SIP/2.0`,
      'Via: SIP/2.0/WSS 10.0.0.1;branch=z9hG4bKr1',
      'From: <sip:202@pbx.example.com>;tag=caller',
      'To: <sip:201@pbx.example.com>',
      'Call-ID: incoming-1',
      `CSeq: 1 ${method}`,
      'Content-Length: 0',
      '',
      '',
    ];
    this.ws.push(lines.join('\r\n'));
  }
}

let pbx;
beforeEach(() => {
  pbx = new FakePbx();
  sipIo.WebSocket = pbx.WebSocket;
  sipIo.options = {keepAliveSeconds: 0, backoff: () => 10, disconnectTimeoutMs: 300, timeoutMs: 2000};
});
afterEach(() => {
  sipIo.WebSocket = undefined;
  sipIo.options = {};
});

const wx = (argv, options = {}) => run(['phone', ...argv], {env, registry, fetch: fakeFetch(info()), ...options});
const lines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const CALL = {
  id: 'call-1@pbx',
  direction: 'outbound',
  state: 'confirmed',
  hold: true,
  number: '202',
  name: 'Anna',
  recording: 'personal',
  tags: 'vip',
};

test('phone list --sip: the SIP password from the PBX, a digest REGISTER as "wx watcher", the calls, then a clean exit', async () => {
  pbx.calls = [CALL];
  const fetch = fakeFetch(info());
  const r = await wx(['list', '--sip'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    calls: [
      {
        id: 'call-1@pbx',
        direction: 'outbound',
        state: 'held',
        remoteNumber: '202',
        remoteName: 'Anna',
        tags: ['vip'],
        recording: 'personal',
      },
    ],
  });
  // the password request
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://pbx.example.com/api/v1/personal/info?fields=extension%2CsipPassword');
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${token}`);
  assert.equal(fetch.calls[0].headers.connection, 'close');
  // the socket and the registration
  assert.equal(pbx.sockets.length, 1);
  assert.equal(pbx.ws.url, 'wss://pbx.example.com/sip/');
  assert.equal(pbx.ws.protocol, 'sip');
  assert.equal(pbx.badAuth, 0);
  const registers = pbx.requests.filter((m) => m.method === 'REGISTER');
  assert.equal(registers[0].uri, 'sip:pbx.example.com');
  assert.match(
    registers[1].header('authorization'),
    /^Digest algorithm=MD5, username="201", realm="pbx.example.com", nonce="nonce-123", uri="sip:pbx.example.com", response="[0-9a-f]{32}"/,
  );
  assert.match(registers[1].header('contact'), /^<sip:201@[a-z0-9]{12}\.invalid;transport=ws>;expires=120$/);
  assert.equal(registers[1].header('user-agent'), 'wx watcher');
  assert.equal(registers[1].header('x-disable-directrtp'), 'yes');
  assert.ok(Number(registers[1].header('cseq').split(' ')[0]) > Number(registers[0].header('cseq').split(' ')[0]));
  // subscriptions to the three packages, then unregistered and unsubscribed
  const subscribes = pbx.requests.filter((m) => m.method === 'SUBSCRIBE' && m.header('authorization'));
  assert.deepEqual(
    subscribes
      .filter((m) => m.header('expires') === '120')
      .map((m) => m.header('event'))
      .sort(),
    ['active-device', 'dialog', 'reg'],
  );
  assert.deepEqual(
    subscribes
      .filter((m) => m.header('expires') === '0')
      .map((m) => m.header('event'))
      .sort(),
    ['active-device', 'dialog', 'reg'],
  );
  assert.ok(
    subscribes
      .filter((m) => m.header('expires') === '0')
      .every((m) => tagOf(m.header('to'))?.startsWith('srv') && m.uri === 'sip:pbx@10.0.0.1;transport=ws'),
  );
  assert.match(registers[registers.length - 1].header('contact'), /;expires=0$/);
  assert.equal(pbx.ws.readyState, 3);
  // NOTIFYs answered 200 in their dialog: the three states, and the "terminated" ones that answer the unsubscribe
  // while the socket is still open
  const ok = pbx.responses.filter((m) => m.header('cseq') === '1 NOTIFY');
  assert.ok(ok.length >= 3, `${ok.length} NOTIFY answers`);
  assert.ok(ok.every((m) => m.status === 200));
  // the SIP password never shows
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SIP_PASSWORD));
  assert.ok(pbx.requests.every((m) => !JSON.stringify(m.headerList).includes(SIP_PASSWORD)));
  const t = await wx(['list', '--sip'], {output: 'text'});
  assert.equal(t.stdout.trim(), 'held  to  202 Anna  recording personal [vip]  call-1@pbx');
});

test('phone watch: READY with the state, then call, device, presence and ringing-mode events; stops on the signal', async () => {
  pbx.calls = [CALL];
  const controller = new AbortController();
  const done = wx(['watch'], {signal: controller.signal});
  while (pbx.responses.filter((m) => m.header('cseq') === '1 NOTIFY').length < 3) await tick(5);
  await tick();
  pbx.calls = [CALL, {id: 'call-2', direction: 'inbound', state: 'early', number: '203'}];
  pbx.notify('dialog');
  await tick();
  pbx.calls = [{id: 'call-2', direction: 'inbound', state: 'confirmed', number: '203'}];
  pbx.notify('dialog');
  await tick();
  pbx.presence = {status: 'DND', custom: {message: 'busy'}};
  pbx.notify('dialog');
  await tick();
  pbx.devices = [];
  pbx.notify('reg');
  pbx.activeDevice = ['any_device'];
  pbx.notify('active-device');
  pbx.request('INVITE');
  pbx.request('OPTIONS');
  await tick();
  controller.abort();
  const r = await done;
  assert.equal(r.code, 0, r.stderr);
  const events = lines(r.stdout);
  assert.deepEqual(
    events.map((e) => e.event),
    ['CALL_START', 'READY', 'CALL_START', 'CALL_UPDATE', 'CALL_END', 'PRESENCE', 'DEVICES', 'ACTIVE_DEVICE'],
  );
  const ready = events[1].data;
  assert.equal(ready.extension, '201');
  assert.equal(ready.calls[0].state, 'held');
  assert.deepEqual(ready.presence, {status: 'online'});
  assert.deepEqual(ready.activeDevice, {
    type: 'device',
    contactUri: 'sip:201@phone.invalid',
    userAgent: 'x-bees Web 2.0',
  });
  assert.deepEqual(
    ready.devices.map((d) => [d.name, d.watcher ?? false]),
    [
      ['x-bees Web', false],
      ['wx watcher', true],
    ],
  );
  assert.deepEqual(events[2].data, {
    id: 'call-2',
    direction: 'inbound',
    state: 'ringing',
    remoteNumber: '203',
    recording: 'off',
  });
  assert.equal(events[3].data.state, 'answered');
  assert.deepEqual([events[4].data.id, events[4].data.state], ['call-1@pbx', 'ended']);
  assert.deepEqual(events[5].data, {status: 'dnd', message: 'busy'});
  assert.deepEqual(
    events[6].data.map((d) => d.watcher),
    [true],
  );
  assert.deepEqual(events[7].data, {type: 'any_device'});
  // the calls offered to the watcher are turned down; OPTIONS answered
  const invite = pbx.responses.find((m) => m.header('cseq') === '1 INVITE');
  assert.equal(invite.status, 480);
  assert.ok(tagOf(invite.header('to')));
  assert.equal(pbx.responses.find((m) => m.header('cseq') === '1 OPTIONS').status, 200);
  assert.equal(pbx.publishes.length, 0);
  assert.equal(pbx.ws.readyState, 3);
});

test('phone watch --calls-only --for: only the calls; text lines; stops by itself', async () => {
  const r = await wx(['watch', '--calls-only', '--for', '1'], {signal: new AbortController().signal});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [{event: 'READY', data: {extension: '201', calls: []}}]);
  const t = await wx(['watch', '--for', '1'], {signal: new AbortController().signal, output: 'text'});
  assert.match(
    t.stdout.trim(),
    /^\d\d:\d\d:\d\d ready extension 201, 0 calls, presence online, 1 device\(s\), ringing x-bees Web 2\.0 sip:201@phone\.invalid$/,
  );
  const bad = await wx(['watch', '--for', '-1'], {signal: new AbortController().signal});
  assert.equal(bad.code, 64);
});

test('phone watch: a dropped connection reconnects (RECONNECTING, RECONNECTED) and resubscribes', async () => {
  pbx.calls = [CALL];
  const controller = new AbortController();
  const done = wx(['watch', '--calls-only'], {signal: controller.signal});
  while (pbx.responses.filter((m) => m.header('cseq') === '1 NOTIFY').length < 3) await tick(5);
  await tick();
  pbx.ws.drop();
  while (pbx.sockets.length < 2 || pbx.responses.filter((m) => m.header('cseq') === '1 NOTIFY').length < 6)
    await tick(5);
  await tick();
  controller.abort();
  const r = await done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    lines(r.stdout).map((e) => e.event),
    ['CALL_START', 'READY', 'RECONNECTING', 'RECONNECTED'],
  );
  assert.deepEqual(lines(r.stdout)[2].data, {attempt: 1});
  assert.equal(lines(r.stdout)[3].data.calls.length, 1);
});

test('a subscription the PBX ends is subscribed again', async () => {
  const controller = new AbortController();
  const done = wx(['watch', '--calls-only'], {signal: controller.signal});
  while (pbx.subs.length < 3) await tick(5);
  await tick();
  pbx.notify('reg', 'terminated;reason=timeout');
  while (pbx.subs.filter((s) => s.pkg === 'reg').length < 2) await tick(5);
  controller.abort();
  const r = await done;
  assert.equal(r.code, 0, r.stderr);
});

test('phone record: a TAPI PUBLISH on a current call of the user', async () => {
  pbx.calls = [CALL];
  const r = await wx(['record', 'call-1@pbx', 'on']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {ok: true, command: 'record', callId: 'call-1@pbx'});
  const p = pbx.publishes.find((m) => m.header('authorization'));
  assert.equal(p.uri, 'sip:201@pbx.example.com');
  assert.equal(p.header('w-tapicommand'), 'record');
  assert.equal(p.header('w-tapiparam1'), 'call-1@pbx');
  assert.equal(p.header('w-tapiparam2'), 'on');
  assert.equal(p.header('event'), 'wildixtsp/action');
  assert.equal(p.header('expires'), '1');
  assert.equal(p.header('content-length'), '0');
  assert.equal(pbx.ws.readyState, 3);
  const t = await wx(['record', 'call-1@pbx', 'pause'], {output: 'text'});
  assert.equal(t.stdout, 'record pause: the PBX took it (call call-1@pbx)\n');
});

test('phone record: an unknown call, a refusal of the PBX, a wrong action', async () => {
  pbx.calls = [CALL];
  const unknown = await wx(['record', 'other-call', 'on']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no current call of this user has the id other-call/);
  assert.equal(pbx.publishes.length, 0);
  pbx.publishStatus = [500, 'recording already started'];
  const refused = await wx(['record', 'call-1@pbx', 'on']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /record failed: TAPI command "record" rejected: 500 recording already started/);
  const fetch = fakeFetch();
  const bad = await wx(['record', 'call-1@pbx', 'start'], {fetch});
  assert.equal(bad.code, 64);
  assert.equal(fetch.calls.length, 0);
});

test('phone conference-transfer: TAPI conftransfer with the normalized number', async () => {
  pbx.calls = [CALL];
  const r = await wx(['conference-transfer', 'call-1@pbx', '+39 02-123']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {ok: true, command: 'conference-transfer', callId: 'call-1@pbx'});
  const p = pbx.publishes.find((m) => m.header('authorization'));
  assert.deepEqual(
    [p.header('w-tapicommand'), p.header('w-tapiparam1'), p.header('w-tapiparam2')],
    ['conftransfer', 'call-1@pbx', '+3902123'],
  );
  const fetch = fakeFetch();
  assert.equal((await wx(['conference-transfer', 'call-1@pbx', 'abc'], {fetch})).code, 64);
  assert.equal((await wx(['conference-transfer', 'bad id', '201'], {fetch})).code, 64);
  assert.equal(fetch.calls.length, 0);
});

test('the SIP password: a 401 exits 2, a wrong extension or no password exits 1, no socket opened', async () => {
  const rejected = await wx(['list', '--sip'], {fetch: fakeFetch({status: 401, body: {}})});
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /the PBX rejected the login/);
  const other = await wx(['list', '--sip'], {fetch: fakeFetch(info({extension: '999', sipPassword: 'x'}))});
  assert.equal(other.code, 1);
  assert.match(other.stderr, /answered for extension 999, not 201/);
  const none = await wx(['list', '--sip'], {fetch: fakeFetch(info({extension: '201'}))});
  assert.equal(none.code, 1);
  assert.match(none.stderr, /did not give the SIP password/);
  const failed = await wx(['list', '--sip'], {fetch: fakeFetch({status: 500, body: {}})});
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /no personal info \(HTTP 500\)/);
  const noExt = await wx(['list', '--sip'], {
    env: {WILDIX_ID_TOKEN: fakeJwt({'custom:pbx_domain': 'pbx.example.com'})},
  });
  assert.equal(noExt.code, 64);
  assert.equal(pbx.sockets.length, 0);
});

test('a registration the PBX refuses is an error, nothing left running', async () => {
  pbx.password = 'another';
  const r = await wx(['list', '--sip']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not connect to the PBX as extension 201: REGISTER rejected: 403 Forbidden/);
  assert.doesNotMatch(r.stderr, new RegExp(SIP_PASSWORD));
  assert.equal(pbx.ws.readyState, 3);
  pbx = new FakePbx({registerStatus: [503, 'Service Unavailable']});
  sipIo.WebSocket = pbx.WebSocket;
  const busy = await wx(['watch']);
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /REGISTER rejected: 503/);
});

test('a PBX that does not open the WebSocket is an error', async () => {
  sipIo.WebSocket = class {
    constructor() {
      this.listeners = {};
      setImmediate(() => {
        for (const fn of this.listeners.error ?? []) fn({});
        for (const fn of this.listeners.close ?? []) fn({});
      });
    }
    addEventListener(t, fn) {
      (this.listeners[t] ??= []).push(fn);
    }
    close() {}
  };
  const r = await wx(['list', '--sip']);
  assert.equal(r.code, 1);
  assert.match(
    r.stderr,
    /could not connect to the PBX as extension 201: the PBX did not open the SIP WebSocket \(pbx\.example\.com\)/,
  );
});
