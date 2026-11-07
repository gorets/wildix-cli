// The SIP channel of the PBX, as the wildix-call-control skill uses it (through @gorets/wildix-callcontrol): a
// headless SIP user of the logged-in extension that registers, subscribes to the event packages `dialog` (calls and
// presence), `reg` (devices) and `active-device` (ringing mode), and sends call commands as Wildix TAPI PUBLISH
// requests (event `wildixtsp/action`), the way Wildix clients do. Same behaviour as that library: the same events,
// reconnect and resubscribe with the same backoff, a registration that lingers at most `expires` seconds when the
// process is killed.
//
// Events: registered, ready (the first dialog state after each registration), callStart, callUpdate, callEnd,
// devicesChanged, presenceChanged, activeDeviceChanged, reconnecting {attempt}, error (an Error).
import {EventEmitter} from 'node:events';
import {
  CallTracker,
  ValueTracker,
  deviceName,
  devicesEqual,
  parseActiveDevice,
  parseDialogInfo,
  parseRegInfo,
  toActiveDevice,
} from './events.mjs';
import {ALLOWED, SipUserAgent, paramOf, randomToken, tagOf, uriOf} from './sip.mjs';

export const TAPI_EVENT = 'wildixtsp/action';
export const RECORD_ACTIONS = ['on', 'off', 'pause', 'unpause'];
const PACKAGES = ['dialog', 'reg', 'active-device'];
const SUBSCRIPTION_DISPOSE_GRACE_MS = 500;

// 3 s, then up to 30 s over five attempts (quadratic), as the library.
export function backoffMs(attempt) {
  const a = Math.min(Math.max(attempt, 1), 5);
  return Math.round(((30_000 - 3_000) / 16) * (a - 1) ** 2 + 3_000);
}

const bounded = (work, ms) => {
  let timer;
  return Promise.race([work.catch(() => undefined), new Promise((r) => (timer = setTimeout(r, ms)))]).finally(() =>
    clearTimeout(timer),
  );
};

export class CallControl extends EventEmitter {
  // {domain, wsUrl, extension, password, userAgent, expires, WebSocketImpl, keepAliveSeconds, disconnectTimeoutMs, backoff}
  constructor(config) {
    super();
    this.config = config;
    this.expires = config.expires ?? 3600;
    if (!Number.isInteger(this.expires) || this.expires <= 0)
      throw new Error(`expires must be a positive integer: ${config.expires}`);
    this.disconnectTimeoutMs = config.disconnectTimeoutMs ?? 10_000;
    this.backoff = config.backoff ?? backoffMs;
    this.aor = `sip:${config.extension}@${config.domain}`;
    this.stopping = false;
    this.ready = false;
    this.generation = 0;
    this.reconnectAttempt = 0;
    this.subs = new Map(); // Call-ID -> subscription
    this.timers = new Set();
    this.calls = new CallTracker();
    this.devices = new ValueTracker();
    this.presence = new ValueTracker();
    this.activeDevice = new ValueTracker();
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  cancel(t) {
    if (t) {
      clearTimeout(t);
      this.timers.delete(t);
    }
  }

  async connect() {
    this.stopping = false;
    await this.start();
    this.reconnectAttempt = 0;
    this.emit('registered');
  }

  async start() {
    const c = this.config;
    const ua = new SipUserAgent({
      wsUrl: c.wsUrl,
      domain: c.domain,
      extension: c.extension,
      password: c.password,
      userAgent: c.userAgent,
      WebSocketImpl: c.WebSocketImpl,
      keepAliveSeconds: c.keepAliveSeconds ?? 30,
      timeoutMs: c.timeoutMs,
    });
    ua.onNotify = (req) => this.notify(req);
    ua.on('error', (e) => this.emit('error', e));
    // Only a connection that was up reconnects; one that fails to come up is the caller's error.
    let live = false;
    ua.on('disconnect', () => {
      if (live && this.ua === ua && !this.stopping) this.scheduleReconnect();
    });
    this.ua = ua;
    this.generation += 1;
    this.ready = false;
    try {
      await ua.open();
      await this.register(this.generation);
      live = true;
      if (ua.closed) throw new Error('the PBX closed the SIP connection right after the registration');
    } catch (e) {
      if (this.ua === ua) this.ua = undefined;
      ua.close();
      throw e;
    }
    for (const pkg of PACKAGES) this.subscribe(pkg, this.generation, 0);
  }

  // REGISTER, refreshed before it runs out. A refresh that fails reconnects.
  async register(generation, expires = this.expires) {
    const ua = this.ua;
    this.registration ??= {callId: randomToken(22), fromTag: randomToken(10), seq: {cseq: 0}};
    const r = this.registration;
    const res = await ua.request('REGISTER', {
      ruri: `sip:${this.config.domain}`,
      to: `<${this.aor}>`,
      from: `<${this.aor}>;tag=${r.fromTag}`,
      callId: r.callId,
      seq: r.seq,
      headers: [
        'X-Disable-DirectRTP: yes',
        `Contact: ${ua.contact};expires=${expires}`,
        `Allow: ACK,CANCEL,INVITE,MESSAGE,BYE,OPTIONS,INFO,NOTIFY,REFER`,
      ],
    });
    if (res.status === 423 && expires > 0) {
      const min = Number(res.header('min-expires'));
      if (Number.isInteger(min) && min > expires) return this.register(generation, min);
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`REGISTER rejected: ${res.status} ${res.reason}`);
    if (expires === 0) return;
    const ours = res
      .headers('contact')
      .flatMap((v) => v.split(/,(?![^<]*>)/))
      .find((v) => uriOf(v).includes(ua.viaHost));
    const granted = Number(paramOf(ours, 'expires') ?? res.header('expires') ?? expires) || expires;
    this.cancel(this.registerTimer);
    this.registerTimer = this.later(
      () => {
        if (this.stopping || generation !== this.generation) return;
        this.register(generation).catch((e) => {
          if (generation !== this.generation || this.stopping) return;
          this.emit('error', e);
          this.scheduleReconnect();
        });
      },
      Math.max(1, granted * 0.9) * 1000,
    );
  }

  subscribe(pkg, generation, attempt) {
    if (!this.ua || this.stopping || generation !== this.generation) return;
    const sub = {
      pkg,
      generation,
      attempt,
      callId: randomToken(22),
      fromTag: randomToken(10),
      seq: {cseq: 0},
      remoteTag: undefined,
      target: undefined,
      routes: [],
    };
    this.subs.set(sub.callId, sub);
    this.sendSubscribe(sub, this.expires).then(
      (res) => {
        if (this.subs.get(sub.callId) !== sub) return;
        if (res.status >= 200 && res.status < 300) {
          sub.attempt = 0;
          if (!sub.remoteTag) {
            sub.remoteTag = tagOf(res.header('to'));
            sub.target = res.header('contact') ? uriOf(res.header('contact')) : undefined;
            sub.routes = SipUserAgent.routes(res).reverse();
          }
          this.scheduleRefresh(sub, Number(res.header('expires')) || this.expires);
        } else {
          this.emit('error', new Error(`SUBSCRIBE ${pkg} rejected: ${res.status} ${res.reason}`));
          this.terminated(sub);
        }
      },
      (e) => {
        if (this.subs.get(sub.callId) !== sub) return;
        this.emit('error', e);
        this.terminated(sub);
      },
    );
  }

  sendSubscribe(sub, expires) {
    const inDialog = Boolean(sub.remoteTag);
    return this.ua.request('SUBSCRIBE', {
      ruri: inDialog && sub.target ? sub.target : this.aor,
      routes: inDialog ? sub.routes : [],
      to: `<${this.aor}>${inDialog ? `;tag=${sub.remoteTag}` : ''}`,
      from: `<${this.aor}>;tag=${sub.fromTag}`,
      callId: sub.callId,
      seq: sub.seq,
      headers: [
        `Allow: ${ALLOWED.join(',')}`,
        `Event: ${sub.pkg}`,
        `Expires: ${expires}`,
        `Contact: ${this.ua.contact}`,
      ],
    });
  }

  scheduleRefresh(sub, seconds) {
    this.cancel(sub.timer);
    sub.timer = this.later(
      () => {
        if (this.stopping || this.subs.get(sub.callId) !== sub) return;
        this.sendSubscribe(sub, this.expires).then(
          (res) => {
            if (this.subs.get(sub.callId) !== sub) return;
            if (res.status >= 200 && res.status < 300)
              this.scheduleRefresh(sub, Number(res.header('expires')) || this.expires);
            else this.terminated(sub);
          },
          () => this.subs.get(sub.callId) === sub && this.terminated(sub),
        );
      },
      Math.max(1, seconds * 0.9) * 1000,
    );
  }

  // A subscription that ended: subscribe again, after a backoff, while connected.
  terminated(sub) {
    this.cancel(sub.timer);
    this.subs.delete(sub.callId);
    if (this.stopping || sub.generation !== this.generation) return;
    const attempt = sub.attempt + 1;
    this.later(() => this.subscribe(sub.pkg, sub.generation, attempt), this.backoff(attempt));
  }

  // A NOTIFY: true when it belongs to one of our subscriptions.
  notify(req) {
    const sub = this.subs.get(req.header('call-id'));
    if (!sub || tagOf(req.header('to')) !== sub.fromTag) return false;
    if (!sub.remoteTag) {
      sub.remoteTag = tagOf(req.header('from'));
      sub.target = req.header('contact') ? uriOf(req.header('contact')) : undefined;
      sub.routes = SipUserAgent.routes(req);
    }
    const state = req.header('subscription-state') ?? '';
    const body = req.body ?? '';
    try {
      if (sub.pkg === 'dialog') this.onDialog(body);
      else if (sub.pkg === 'reg') this.onReg(body);
      else this.onActiveDevice(body);
    } catch (e) {
      this.emit('error', new Error(`could not read the ${sub.pkg} state from the PBX: ${e.message}`));
    }
    if (/^\s*terminated/i.test(state)) {
      sub.attempt = 0;
      this.terminated(sub);
    } else {
      const expires = Number(paramOf(state, 'expires'));
      if (Number.isFinite(expires) && expires > 0) this.scheduleRefresh(sub, expires);
    }
    return true;
  }

  onDialog(body) {
    if (body.trim()) {
      const {dialogs, presence} = parseDialogInfo(body);
      const {started, updated, ended} = this.calls.apply(dialogs);
      for (const c of started) this.emit('callStart', c);
      for (const c of updated) this.emit('callUpdate', c);
      for (const c of ended) this.emit('callEnd', c);
      const next = presence ? {...presence} : undefined;
      if (this.presence.apply(next) && next) this.emit('presenceChanged', next);
    }
    // The PBX answers the unsubscribe of disconnect() with a last NOTIFY: that is not a new start.
    if (!this.ready && !this.stopping) {
      this.ready = true;
      this.emit('ready');
    }
  }

  onReg(body) {
    if (!body.trim() || !this.ua) return;
    const via = this.ua.viaHost;
    const devices = parseRegInfo(body).map((d) => ({
      uri: d.uri,
      userAgent: d.userAgent,
      deviceName: deviceName(d.userAgent),
      isLocalRegistration: d.uri.includes(via),
    }));
    if (this.devices.apply(devices, devicesEqual)) this.emit('devicesChanged', devices);
  }

  onActiveDevice(body) {
    if (!body.trim()) return;
    const next = toActiveDevice(parseActiveDevice(body));
    if (this.activeDevice.apply(next) && next) this.emit('activeDeviceChanged', next);
  }

  isReady() {
    return this.ready;
  }

  waitUntilReady(timeoutMs = 10_000) {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off('ready', onReady);
        reject(new Error(`no call state from the PBX within ${timeoutMs} ms`));
      }, timeoutMs);
      this.once('ready', onReady);
    });
  }

  getActiveCalls() {
    return this.calls.list();
  }

  getDevices() {
    return this.devices.value ?? [];
  }

  getPresence() {
    return this.presence.value;
  }

  getActiveDevice() {
    return this.activeDevice.value;
  }

  // A TAPI command: PUBLISH to the user's own address with W-TapiCommand and its parameters. Resolves when the PBX
  // takes it (2xx): taken, not necessarily done.
  async tapi(command, ...params) {
    if (!this.ua) throw new Error('not connected to the PBX');
    const headers = [`W-TapiCommand: ${command}`];
    for (const [i, p] of params.entries()) if (p !== undefined) headers.push(`W-TapiParam${i + 1}: ${p}`);
    headers.push(`Event: ${TAPI_EVENT}`, 'Expires: 1');
    for (const h of headers) if (/[\r\n]/.test(h)) throw new Error('a SIP header value cannot hold a line break');
    const res = await this.ua.request('PUBLISH', {
      ruri: this.aor,
      to: `<${this.aor}>`,
      from: `<${this.aor}>;tag=${randomToken(10)}`,
      callId: randomToken(22),
      seq: {cseq: 0},
      headers,
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`TAPI command "${command}" rejected: ${res.status} ${res.reason}`);
  }

  record(callId, action) {
    if (!RECORD_ACTIONS.includes(action))
      return Promise.reject(new Error(`record action must be one of ${RECORD_ACTIONS.join(', ')}`));
    return this.tapi('record', callId, action);
  }

  conferenceTransfer(callId, destination) {
    return this.tapi('conftransfer', callId, destination);
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.emit('reconnecting', {attempt: this.reconnectAttempt});
    this.reconnectTimer = this.later(() => {
      this.reconnectTimer = undefined;
      this.reconnect();
    }, this.backoff(this.reconnectAttempt));
  }

  async reconnect() {
    if (this.stopping) return;
    this.dropState();
    const old = this.ua;
    this.ua = undefined;
    old?.close();
    try {
      await this.start();
      this.reconnectAttempt = 0;
      this.emit('registered');
    } catch (e) {
      if (this.stopping) return;
      this.emit('error', e);
      this.scheduleReconnect();
    }
  }

  // Forgets the registration and the subscriptions of the connection that is gone (the calls stay known, so the
  // state after the reconnect is told as changes).
  dropState() {
    this.cancel(this.registerTimer);
    for (const s of this.subs.values()) this.cancel(s.timer);
    this.subs.clear();
    this.registration = undefined;
  }

  // Ends the registration and the subscriptions (sent together; the registration waited for at most
  // disconnectTimeoutMs, the subscriptions 0.5 s), then closes the socket. Never rejects.
  async disconnect() {
    this.stopping = true;
    this.ready = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.reconnectTimer = undefined;
    const ua = this.ua;
    if (ua && !ua.closed) {
      const subs = [...this.subs.values()].filter((s) => s.remoteTag);
      const unregistered = this.registration
        ? this.register(this.generation, 0).catch(() => undefined)
        : Promise.resolve();
      const unsubscribed = Promise.all(subs.map((s) => this.sendSubscribe(s, 0).catch(() => undefined)));
      await bounded(
        Promise.all([unregistered, bounded(unsubscribed, SUBSCRIPTION_DISPOSE_GRACE_MS)]),
        this.disconnectTimeoutMs,
      );
    }
    this.subs.clear();
    this.registration = undefined;
    ua?.close();
    this.ua = undefined;
  }
}
