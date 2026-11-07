// A minimal SIP user agent over a WebSocket (RFC 7118), with Node built-ins only: the global WebSocket and
// node:crypto (MD5 digest). It carries no media and makes no calls: it registers, subscribes, publishes and answers
// what the PBX sends. Only what the call control of the Wildix PBX needs: non-INVITE client transactions (a WebSocket
// is reliable: no retransmissions), digest authentication (RFC 2617/3261, MD5, qop=auth), incoming requests answered
// at once (NOTIFY to the subscriptions, INVITE turned down with 480, OPTIONS 200). The wire format follows sip.js
// 0.21 (the library the wildix-call-control skill runs), so the PBX sees the same kind of client.
//
// Security: the SIP password is used only to compute the digest; it is never sent, printed or put in an error.
import {EventEmitter} from 'node:events';
import {createHash, randomBytes} from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const randomToken = (n) => [...randomBytes(n)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
const md5 = (s) => createHash('md5').update(s).digest('hex');

export const ALLOWED = [
  'ACK',
  'BYE',
  'CANCEL',
  'INFO',
  'INVITE',
  'MESSAGE',
  'NOTIFY',
  'OPTIONS',
  'PRACK',
  'REFER',
  'REGISTER',
  'SUBSCRIBE',
];
const COMPACT = {
  i: 'call-id',
  f: 'from',
  t: 'to',
  v: 'via',
  m: 'contact',
  l: 'content-length',
  c: 'content-type',
  o: 'event',
  k: 'supported',
  u: 'allow-events',
  e: 'content-encoding',
  s: 'subject',
  r: 'refer-to',
  b: 'referred-by',
  x: 'session-expires',
};
const TRANSACTION_TIMEOUT_MS = 32_000; // Timer F of RFC 3261

// One SIP message from its text: {method, uri} for a request or {status, reason} for a response; header(name) gives
// the first value of a header, headers(name) all of them (names without case; compact forms understood).
export function parseMessage(raw) {
  const s = String(raw);
  let split = s.indexOf('\r\n\r\n');
  let sep = 4;
  if (split < 0) {
    split = s.indexOf('\n\n');
    sep = 2;
  }
  const head = split < 0 ? s : s.slice(0, split);
  const body = split < 0 ? '' : s.slice(split + sep);
  const lines = head.split(/\r?\n/).reduce((out, l) => {
    if (/^[ \t]/.test(l) && out.length) out[out.length - 1] += ` ${l.trim()}`;
    else out.push(l);
    return out;
  }, []);
  const first = lines.shift() ?? '';
  const msg = {headerList: [], body};
  let m;
  if ((m = /^SIP\/2\.0 (\d{3})(?: (.*))?$/.exec(first))) Object.assign(msg, {status: Number(m[1]), reason: m[2] ?? ''});
  else if ((m = /^([A-Za-z]+) (\S+) SIP\/2\.0$/.exec(first)))
    Object.assign(msg, {method: m[1].toUpperCase(), uri: m[2]});
  else throw new Error('not a SIP message');
  for (const l of lines) {
    const c = l.indexOf(':');
    if (c <= 0) continue;
    let name = l.slice(0, c).trim().toLowerCase();
    name = COMPACT[name] ?? name;
    msg.headerList.push([name, l.slice(c + 1).trim()]);
  }
  msg.headers = (name) => msg.headerList.filter(([n]) => n === name.toLowerCase()).map(([, v]) => v);
  msg.header = (name) => msg.headers(name)[0];
  return msg;
}

// Parts of header values.
export const tagOf = (value) => paramOf(value, 'tag');
export const uriOf = (value) => {
  const v = String(value ?? '');
  const a = /<([^>]*)>/.exec(v);
  return a ? a[1] : v.split(';')[0].trim();
};
export function paramOf(value, name) {
  // The display name and the URI may hold ";tag=" themselves: only the parameters after them count.
  const v = String(value ?? '')
    .replace(/^\s*"(?:[^"\\]|\\.)*"/, '')
    .replace(/<[^>]*>/, '');
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;,\\s]+))`, 'i').exec(v);
  return m ? (m[1] ?? m[2]) : undefined;
}
const branchOf = (via) => /;\s*branch=([^;,\s]+)/i.exec(via ?? '')?.[1];
const splitList = (values) =>
  values.flatMap((v) => v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)(?![^<]*>)/).map((x) => x.trim())).filter(Boolean);

// A digest challenge (WWW-Authenticate / Proxy-Authenticate) as {realm, nonce, qop, opaque, algorithm, stale}.
export function parseChallenge(value) {
  const v = String(value ?? '');
  if (!/^\s*Digest\s/i.test(v)) return undefined;
  const out = {};
  for (const m of v.replace(/^\s*Digest\s+/i, '').matchAll(/([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g))
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

// The Authorization value for a challenge (MD5; qop auth when offered), as sip.js computes it.
export function digestAuthorization({username, password, method, uri, challenge, nc = 1, cnonce = randomToken(12)}) {
  const algorithm = challenge.algorithm ?? 'MD5';
  if (algorithm.toUpperCase() !== 'MD5')
    throw new Error(`the PBX asks for a digest algorithm other than MD5: ${algorithm}`);
  if (!challenge.realm || !challenge.nonce) throw new Error('the PBX sent a digest challenge without realm or nonce');
  const qops = (challenge.qop ?? '').split(',').map((q) => q.trim());
  const qop = challenge.qop === undefined ? undefined : qops.includes('auth') ? 'auth' : undefined;
  if (challenge.qop !== undefined && !qop)
    throw new Error(`the PBX asks for a digest qop other than auth: ${challenge.qop}`);
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const ncHex = nc.toString(16).padStart(8, '0');
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `algorithm=MD5`,
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `cnonce="${cnonce}"`, `nc=${ncHex}`);
  return `Digest ${parts.join(', ')}`;
}

// The user agent: one WebSocket to the PBX. Events: 'request' (an incoming request already answered: NOTIFYs go to
// onNotify), 'disconnect' (the socket closed). onNotify(request) returns true when the NOTIFY belongs to a
// subscription (answered 200), false otherwise (481).
export class SipUserAgent extends EventEmitter {
  constructor({
    wsUrl,
    domain,
    extension,
    password,
    userAgent,
    WebSocketImpl = globalThis.WebSocket,
    keepAliveSeconds = 30,
    timeoutMs = TRANSACTION_TIMEOUT_MS,
  }) {
    super();
    this.wsUrl = wsUrl;
    this.domain = domain;
    this.extension = extension;
    this.password = password;
    this.userAgent = userAgent;
    this.WebSocketImpl = WebSocketImpl;
    this.keepAliveSeconds = keepAliveSeconds;
    this.timeoutMs = timeoutMs;
    this.aor = `sip:${extension}@${domain}`;
    this.viaHost = `${randomToken(12)}.invalid`;
    this.contact = `<sip:${extension}@${this.viaHost};transport=ws>`;
    this.transactions = new Map();
    this.nc = new Map(); // nonce -> count
    this.onNotify = () => false;
    this.closed = false;
  }

  // Opens the WebSocket (subprotocol "sip"); rejects when it cannot.
  open() {
    if (!this.WebSocketImpl)
      return Promise.reject(new Error('this Node.js has no WebSocket (Node 22 or newer is needed)'));
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new this.WebSocketImpl(this.wsUrl, 'sip');
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => {
        opened = true;
        if (this.keepAliveSeconds > 0) {
          this.keepAlive = setInterval(() => this.write('\r\n\r\n'), this.keepAliveSeconds * 1000);
          this.keepAlive.unref?.();
        }
        resolve();
      });
      ws.addEventListener('message', (e) =>
        this.receive(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')),
      );
      ws.addEventListener('error', () => {
        if (!opened) reject(new Error(`the PBX did not open the SIP WebSocket (${new URL(this.wsUrl).host})`));
      });
      ws.addEventListener('close', () => {
        if (!opened) reject(new Error(`the PBX closed the SIP WebSocket (${new URL(this.wsUrl).host})`));
        this.dropped();
      });
    });
  }

  dropped() {
    clearInterval(this.keepAlive);
    for (const t of this.transactions.values()) t.fail(new Error('the SIP connection closed'));
    this.transactions.clear();
    if (!this.closed) {
      this.closed = true;
      this.emit('disconnect');
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.keepAlive);
    for (const t of this.transactions.values()) t.fail(new Error('the SIP connection closed'));
    this.transactions.clear();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }

  write(text) {
    if (this.ws?.readyState !== 1) throw new Error('the SIP connection is not open');
    this.ws.send(text);
  }

  // Sends a request and resolves with its final response. A digest challenge is answered once (twice when stale).
  //   o: {ruri, to, from, callId, seq: {cseq}, routes?, headers?: [lines], body?, contentType?}
  // seq.cseq is incremented for every request sent (the caller keeps it per registration or dialog).
  async request(method, o) {
    let auth;
    for (let round = 0; ; round += 1) {
      o.seq.cseq += 1;
      const res = await this.transaction(method, o, auth);
      if (res.status !== 401 && res.status !== 407) return res;
      const challenge = parseChallenge(res.header(res.status === 401 ? 'www-authenticate' : 'proxy-authenticate'));
      const stale = String(challenge?.stale).toLowerCase() === 'true';
      if (!challenge || round >= (stale ? 2 : 1)) return res;
      const nc = (this.nc.get(challenge.nonce) ?? 0) + 1;
      this.nc.set(challenge.nonce, nc);
      const value = digestAuthorization({
        username: this.extension,
        password: this.password,
        method,
        uri: o.ruri,
        challenge,
        nc,
      });
      auth = `${res.status === 401 ? 'Authorization' : 'Proxy-Authorization'}: ${value}`;
    }
  }

  transaction(method, o, auth) {
    const branch = `z9hG4bK${randomToken(23)}`;
    const body = o.body ?? '';
    const lines = [
      `${method} ${o.ruri} SIP/2.0`,
      ...(o.routes ?? []).map((r) => `Route: ${r}`),
      `Via: SIP/2.0/WSS ${this.viaHost};branch=${branch}`,
      `To: ${o.to}`,
      `From: ${o.from}`,
      `CSeq: ${o.seq.cseq} ${method}`,
      `Call-ID: ${o.callId}`,
      'Max-Forwards: 70',
      ...(auth ? [auth] : []),
      ...(o.headers ?? []),
      `Supported: ${method === 'REGISTER' ? 'outbound, path, gruu' : 'outbound'}`,
      `User-Agent: ${this.userAgent}`,
      ...(body ? [`Content-Type: ${o.contentType}`] : []),
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.transactions.delete(branch);
        reject(new Error(`the PBX did not answer ${method} in time`));
      }, this.timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        this.transactions.delete(branch);
      };
      this.transactions.set(branch, {
        method,
        ok: (res) => {
          done();
          resolve(res);
        },
        fail: (e) => {
          done();
          reject(e);
        },
      });
      try {
        this.write(lines.join('\r\n'));
      } catch (e) {
        done();
        reject(e);
      }
    });
  }

  receive(text) {
    if (!text.trim()) return; // a keep-alive answer
    let msg;
    try {
      msg = parseMessage(text);
    } catch {
      return;
    }
    if (msg.status !== undefined) {
      const t = this.transactions.get(branchOf(msg.header('via')));
      if (t && msg.status >= 200) t.ok(msg);
      return;
    }
    this.answerRequest(msg);
  }

  answerRequest(req) {
    switch (req.method) {
      case 'ACK':
        return;
      case 'NOTIFY': {
        let known = false;
        try {
          known = this.onNotify(req);
        } catch (e) {
          this.emit('error', e);
          known = true;
        }
        this.respond(req, known ? 200 : 481, known ? 'OK' : 'Subscription does not exist');
        break;
      }
      case 'INVITE':
        // Not a phone: every call offered to this registration is turned down, the user's phones keep ringing.
        this.respond(req, 480, 'Not a call-handling device');
        break;
      case 'OPTIONS':
        this.respond(req, 200, 'OK', [`Allow: ${ALLOWED.join(',')}`]);
        break;
      case 'CANCEL':
        this.respond(req, 200, 'OK');
        break;
      case 'BYE':
        this.respond(req, 481, 'Call/Transaction Does Not Exist');
        break;
      default:
        this.respond(req, 405, 'Method Not Allowed', [`Allow: ${ALLOWED.join(',')}`]);
    }
    this.emit('request', req);
  }

  respond(req, status, reason, headers = []) {
    const to = req.header('to') ?? '';
    const lines = [
      `SIP/2.0 ${status} ${reason}`,
      ...req.headers('via').map((v) => `Via: ${v}`),
      `To: ${tagOf(to) ? to : `${to};tag=${randomToken(10)}`}`,
      `From: ${req.header('from') ?? ''}`,
      `Call-ID: ${req.header('call-id') ?? ''}`,
      `CSeq: ${req.header('cseq') ?? ''}`,
      ...headers,
      'Supported: outbound',
      `User-Agent: ${this.userAgent}`,
      'Content-Length: 0',
      '',
      '',
    ];
    try {
      this.write(lines.join('\r\n'));
    } catch {
      // the socket is gone: the PBX retries or drops it
    }
  }

  // Record-Route values of a message, one route per entry.
  static routes(msg) {
    return splitList(msg.headers('record-route'));
  }
}
