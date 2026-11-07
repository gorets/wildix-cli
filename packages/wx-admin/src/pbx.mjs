// The PBX a command works on, and how it signs in there. Two kinds of access:
//   - the x-bees login (wx-admin login, shared with wx and the wildix-auth skill): the user's own PBX, named in the
//     login token, with the rights of that user (their ACL);
//   - access saved for a PBX (wx-admin pbx add): a Company API Key (wsk-v1-…, recommended by Wildix), a Simple Token
//     (deprecated by Wildix) or Basic (user and password; disabled on a PBX unless ALLOW_BASIC_AUTH=true).
// Which PBX: --pbx HOST, else the default PBX (wx-admin pbx use), else the PBX of the x-bees login.
// WILDIX_PBX_API_KEY with WILDIX_PBX_HOST gives a Company API Key for that one PBX without saving it (CI, scripts):
// the key is sent to WILDIX_PBX_HOST only, never to a --pbx of the command line (which an agent may have built from
// fetched text), and --all-pbx is refused while it is set.
//
// Company API Keys (docs.wildix.com, "Company API Key for the PBX API"): made by a root admin in WMS, PBX →
// Integrations → Company API Keys; shown once; valid 1 hour to 1 year; scopes {resource}:read for GET/HEAD and
// {resource}:* for the rest, or pbx:read / pbx:*; a key may be bound to a PBX user (else it acts as admin).
// Saved access lives in $WILDIX_CONFIG_DIR/admin/pbx/<host>.json (folder 0700, files 0600, written atomically).
// Secrets are never printed, never put on a command line or into the environment of a child process; the API key
// or token goes only to its own PBX over https, and redirects are refused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {configDir, getToken, jwtClaims, pickProfile, savedSession} from 'wldx-core/auth';
import {AuthError, UsageError} from 'wldx-core/errors';
import {userAgent} from 'wldx-core/program';
import {readSecret} from 'wldx-core/secret';
import {renew, signIn, WmsAuthError} from './wms-login.mjs';

export const AUTH_TYPES = ['apikey', 'token', 'password'];
// The access of a PBX as an older wx-admin saved it: Basic is now the mode `basic` of a `password` access.
const upgraded = (a) => (a?.auth === 'basic' ? {...a, auth: 'password', mode: 'basic'} : a);
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const API_KEY = /^wsk-v1-[A-Za-z0-9]{93}$/;

// A PBX host as given: a name without a dot is a cloud PBX (<name>.wildixin.com); else a host name or an IPv4.
export function normalizeHost(input) {
  const v = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const host = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v) ? `${v}.wildixin.com` : v;
  if (!IPV4.test(host) && !HOSTNAME.test(host)) throw new UsageError(`Not a PBX host: ${input}`);
  return host;
}

export function checkPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`Not a port: ${port}`);
  return n;
}

// A PBX as --pbx (or a command argument) names it: the serial of a known PBX (saved access, or the PBX of the x-bees
// login), bare or as <serial>.wildixin.com, else a host as normalizeHost takes it. A serial is 8 to 16 hex digits;
// it is looked up first, as a bare name would otherwise be read as <name>.wildixin.com. An unknown serial stays
// <serial>.wildixin.com (DNS may not know it: pbx add and pbx check record the serial of a PBX for --pbx).
export function pbxHostOf(ref, ctx = {}) {
  const s = String(ref ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.wildixin\.com$/, '');
  if (/^[0-9a-f]{8,16}$/.test(s)) {
    const saved = savedPbxs(ctx.env ?? process.env).find((p) => p.serial && p.serial.toLowerCase() === s);
    if (saved) return saved.host;
    const login = loginPbxOf({env: ctx.env ?? process.env, profile: ctx.profile});
    if (login?.serial && login.serial.toLowerCase() === s) return login.host;
  }
  return normalizeHost(ref);
}

const pbxDir = (env) => path.join(configDir(env), 'admin', 'pbx');
const accessFile = (host, env) => path.join(pbxDir(env), `${host}.json`);
const settingsFile = (env) => path.join(configDir(env), 'wx-admin.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writePrivate(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // not ours to change: the file itself is still 0600
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, file);
}

const readSettings = (env) => readJson(settingsFile(env)) ?? {};

// The saved access of a PBX ({host, port, auth, …secret}), or undefined.
export function savedAccess(host, env = process.env) {
  const a = upgraded(readJson(accessFile(host, env)));
  return a && AUTH_TYPES.includes(a.auth) && a.host === host ? a : undefined;
}

// The PBX with saved access: [{host, port, auth, mode?, user?, validUntil?, lastUsed?, serial, default}], never a
// secret.
export function savedPbxs(env = process.env) {
  let names;
  try {
    names = fs
      .readdirSync(pbxDir(env))
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
  const byDefault = readSettings(env).defaultPbx;
  return names
    .map((n) => savedAccess(n.slice(0, -'.json'.length), env))
    .filter(Boolean)
    .map((a) => ({
      host: a.host,
      port: a.port,
      auth: a.auth,
      ...(a.auth === 'password'
        ? {
            mode: a.mode,
            user: a.username,
            ...(a.mode === 'token' ? {validUntil: a.validUntil ?? null, lastUsed: a.lastUsed ?? null} : {}),
          }
        : {}),
      serial: a.serial ?? null,
      default: a.host === byDefault,
    }));
}

export function saveAccess(access, env = process.env) {
  const a = upgraded(access);
  if (!AUTH_TYPES.includes(a.auth)) throw new UsageError(`Unknown kind of access: ${a.auth}`);
  writePrivate(accessFile(a.host, env), a);
}

export function removeAccess(host, env = process.env) {
  const file = accessFile(host, env);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  if (readSettings(env).defaultPbx === host) setDefaultPbx(undefined, env);
  return true;
}

export const defaultPbx = (env = process.env) => {
  const host = readSettings(env).defaultPbx;
  return host && savedAccess(host, env) ? host : undefined;
};

export function setDefaultPbx(host, env = process.env) {
  const s = readSettings(env);
  if (host) s.defaultPbx = host;
  else delete s.defaultPbx;
  writePrivate(settingsFile(env), s);
}

// The PBX of the x-bees login of the profile, from the saved session (no network), or undefined.
export function loginPbxOf(ctx) {
  try {
    const email = pickProfile(ctx.env, ctx.profile);
    const set = savedSession(email, ctx.env);
    return set ? loginPbx(set.IdToken) : undefined;
  } catch {
    return undefined;
  }
}

// The PBX of the x-bees login and its port, from the claims of the token.
export function loginPbx(token) {
  const c = jwtClaims(token);
  const host = c['custom:pbx_domain'];
  if (!host) return undefined;
  return {
    host: String(host).toLowerCase(),
    port: c['custom:pbx_port'] ? Number(c['custom:pbx_port']) : 443,
    serial: c['custom:pbx_serial'] ? String(c['custom:pbx_serial']) : null,
  };
}

// Which PBX and how: {host, port, auth: 'login'|'apikey'|'token'|'basic', header: () => Promise<string>, by}.
export async function resolvePbx(ctx) {
  const {env} = ctx;
  const wanted = ctx.pbx ? pbxHostOf(ctx.pbx, ctx) : defaultPbx(env);
  const by = ctx.pbx ? 'option' : wanted ? 'default' : 'login';
  if (env.WILDIX_PBX_API_KEY) {
    const key = env.WILDIX_PBX_API_KEY.trim();
    if (!API_KEY.test(key))
      throw new UsageError('WILDIX_PBX_API_KEY is not a Company API Key (wsk-v1- and 93 letters and digits)');
    if (!env.WILDIX_PBX_HOST)
      throw new UsageError('WILDIX_PBX_API_KEY needs WILDIX_PBX_HOST: the one PBX the key may be sent to');
    const host = pbxHostOf(env.WILDIX_PBX_HOST, ctx);
    if (ctx.pbx && pbxHostOf(ctx.pbx, ctx) !== host)
      throw new UsageError(
        `WILDIX_PBX_API_KEY is for ${host} (WILDIX_PBX_HOST), not ${pbxHostOf(ctx.pbx, ctx)}: the key is not sent anywhere else`,
      );
    const port = env.WILDIX_PBX_PORT ? checkPort(env.WILDIX_PBX_PORT) : 443;
    return {host, port, auth: 'apikey', by: 'environment', fromEnvironment: true, header: async () => `Bearer ${key}`};
  }
  if (wanted) {
    const a = savedAccess(wanted, env);
    if (a) return targetOf(ctx, a, by);
  }
  // The x-bees login: its own PBX only.
  let token;
  try {
    token = await (ctx.freshToken ? ctx.freshToken() : getToken({profile: ctx.profile, env, fetchImpl: ctx.fetch}));
  } catch (e) {
    if (e instanceof AuthError && !wanted) {
      throw new AuthError(
        `No PBX to work on: add access to one (wx-admin pbx add <host>), or log in with an x-bees admin account (wx-admin login <e-mail>). ${e.message}`,
      );
    }
    throw e;
  }
  const own = loginPbx(token);
  if (!own)
    throw new AuthError('This x-bees login is not linked to a PBX: add access to a PBX with wx-admin pbx add <host>');
  if (wanted && wanted !== own.host) {
    const serial = /^([0-9a-f]{8,16})\.wildixin\.com$/.exec(wanted)?.[1];
    if (serial)
      throw new AuthError(
        `No known PBX has the serial ${serial}: add the PBX by its name (wx-admin pbx add <name>), which records its serial`,
      );
    throw new AuthError(
      `No access saved for ${wanted}, and the x-bees login belongs to ${own.host}. Add it: wx-admin pbx add ${wanted}`,
    );
  }
  return {...own, auth: 'login', by, header: async () => `Bearer ${await (ctx.freshToken ? ctx.freshToken() : token)}`};
}

const basicHeader = (a) => `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}`;

// The target of a saved (or new, not yet saved: persist false) access: {host, port, auth, mode?, by, header(),
// onUnauthorized?()}.
function targetOf(ctx, a, by, {persist = true} = {}) {
  const base = {host: a.host, port: a.port ?? 443, auth: a.auth, by};
  if (a.auth === 'password') {
    // A new access being checked before it is saved: its mode was chosen at sign-in, a refusal is final.
    if (!persist && a.mode === 'basic') return {...base, mode: 'basic', header: async () => basicHeader(a)};
    const {header, onUnauthorized} = passwordAccess(ctx, a, {persist});
    return {...base, mode: a.mode, header, ...(persist ? {onUnauthorized} : {})};
  }
  return {...base, header: async () => `Bearer ${a.auth === 'apikey' ? a.key : a.token}`};
}

// The address of a PBX: https://host[:port], or WILDIX_PBX_URL with WILDIX_ALLOW_CUSTOM_URL=1 (tests against a local
// server).
export function pbxBase(ctx, {host, port}) {
  if (ctx.env.WILDIX_PBX_URL && ctx.env.WILDIX_ALLOW_CUSTOM_URL === '1')
    return ctx.env.WILDIX_PBX_URL.replace(/\/+$/, '');
  return `https://${host}${port && port !== 443 ? `:${port}` : ''}`;
}

// Whether the PBX takes Basic for this login and password: one read. 401 → false (Basic off, or a wrong password:
// only the token sign-in can tell those apart).
export async function probeBasic({base, username, password, fetch}) {
  let res;
  try {
    res = await fetch(`${base}/api/v1/Dictionaries`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'user-agent': userAgent(),
        accept: 'application/json',
        authorization: basicHeader({username, password}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new PbxError(`The PBX did not answer (${e.cause?.code ?? e.message})`);
  }
  await res.text().catch(() => '');
  if (res.ok) return true;
  if (res.status === 401) return false;
  throw new PbxError(`HTTP ${res.status} from the PBX for a Basic check`, res.status);
}

const isoOf = (ms) => new Date(ms).toISOString();
const SKEW_MS = 60_000;

// A `password` access: {header(), onUnauthorized()} over the saved file. Mode basic: Basic on every request; a 401
// moves it to the token sign-in. Mode token: the saved access token while it has a minute left, else a renewal; a
// refused renewal tries Basic once (an administrator may have turned it on), else signs in again with the saved
// password (a 2FA code is asked on a terminal only). Every change re-reads the file first (another wx-admin may have
// signed in meanwhile) and is saved at once. One sign-in attempt of each kind per command at most.
export function passwordAccess(ctx, start, {persist = true} = {}) {
  const env = ctx.env;
  const fetch = ctx.fetch ?? globalThis.fetch;
  const base = pbxBase(ctx, start);
  const clock = () => ctx.clock?.() ?? Date.now();
  const {host} = start;
  const user = start.username;
  let current = start;
  const tried = {basic: false, signIn: false};
  const reread = () => (persist ? savedAccess(host, env) : undefined) ?? current;
  const store = (next) => {
    current = next;
    if (persist) saveAccess(next, env);
  };
  const withoutTokens = ({accessToken, accessTokenExpires, refresh, validUntil, lastUsed, ...rest}) => rest;
  const fresh = (a) => {
    const exp = jwtClaims(a.accessToken).exp;
    const until = Math.min(exp ? exp * 1000 : 0, a.accessTokenExpires ? Date.parse(a.accessTokenExpires) : Infinity);
    return a.mode === 'token' && a.accessToken && until - clock() > SKEW_MS;
  };

  const askCode = async (factor, {resent}) => {
    if (!(ctx.stdin?.isTTY && typeof ctx.stdin.setRawMode === 'function'))
      throw new AuthError(`${host} asks for a 2FA code (${factor}) to sign in again: wx-admin login ${host}`);
    const sent = ['email', 'sms'].includes(factor.toLowerCase());
    return readSecret(
      {stdin: ctx.stdin, stderr: ctx.stderr},
      sent
        ? `${resent ? 'A new code was sent' : `${host} has sent a code`} (${factor}); the code, or Enter to send it again: `
        : `The ${factor === 'googleauthenticator' ? 'authenticator app' : factor} code for ${user} on ${host}: `,
    );
  };

  // The token sign-in with the saved password; else the reason, as an AuthError.
  async function signInAgain(a) {
    if (!a.password || tried.signIn) {
      if (persist) store(withoutTokens(a));
      throw new AuthError(
        `The sign-in to ${host} has ended (unused for 36 hours, a restart of the PBX, or ended in WMS): wx-admin login ${host}`,
      );
    }
    tried.signIn = true;
    try {
      const t = await signIn({base, username: user, password: a.password, askCode, fetch});
      store({...a, mode: 'token', ...t, lastUsed: isoOf(clock())});
    } catch (e) {
      if (!(e instanceof WmsAuthError)) throw e;
      if (e.kind === 'credentials')
        throw new AuthError(
          `The password of ${user} on ${host} has changed (or the code was wrong): wx-admin login ${host}`,
        );
      if (e.kind === 'missing')
        throw new AuthError(
          `${host} accepts neither Basic nor the WMS sign-in for tools any more: wx-admin login ${host} --api-key`,
        );
      throw e;
    }
  }

  async function tryBasic(a) {
    if (tried.basic || a.basic === false || !a.password) return false;
    tried.basic = true;
    if (!(await probeBasic({base, username: user, password: a.password, fetch}))) return false;
    store({...withoutTokens(a), mode: 'basic'});
    return true;
  }

  // A valid access token in `current`, or the mode moved to basic.
  async function renewOrRecover() {
    const a = reread();
    if (a.mode === 'basic' || fresh(a)) {
      current = a;
      return;
    }
    for (const candidate of [a, null]) {
      const b = candidate ?? reread(); // a newer refresh token saved by another process meanwhile
      if (!candidate && (b.refresh === a.refresh || b.mode !== 'token')) {
        if (b.mode === 'basic') return void (current = b);
        break;
      }
      if (!b.refresh) break;
      try {
        const t = await renew({base, refresh: b.refresh, fetch});
        return store({...b, ...t, lastUsed: isoOf(clock())});
      } catch (e) {
        if (!(e instanceof WmsAuthError && e.kind === 'expired')) throw e;
      }
    }
    const latest = reread();
    if (await tryBasic(latest)) return;
    await signInAgain(latest);
  }

  return {
    async header() {
      if (current.mode !== 'basic') await renewOrRecover();
      return current.mode === 'basic' ? basicHeader(current) : `Bearer ${current.accessToken}`;
    },
    // A 401 from the API: mode basic → the token sign-in; mode token → a renewal (the PBX refused a token it should
    // take). true: send the request again (once).
    async onUnauthorized() {
      const a = reread();
      if (a.mode === 'basic') {
        if (tried.signIn) return false;
        await signInAgain({...a, mode: 'token'});
        return true;
      }
      store({...a, accessToken: undefined, accessTokenExpires: undefined});
      await renewOrRecover();
      return true;
    },
  };
}

export class PbxError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PbxError';
    this.status = status;
    if (status === 401 || status === 403) this.exitCode = 2; // the access was refused (help: exit code 2)
  }
}

// What a refusal means, by the kind of access. scope: the resource of the route (dialplan, colleagues…).
function hint(status, target, method, scope) {
  const key = target.auth === 'apikey';
  if (status === 401) {
    return key
      ? 'The PBX did not accept the API key: it may have expired or been deleted (WMS → PBX → Integrations → Company API Keys).'
      : target.auth === 'login'
        ? 'The PBX did not accept the x-bees login: log in again (wx-admin login).'
        : target.auth === 'password' && target.mode === 'basic'
          ? `The PBX did not accept Basic for this user (it needs ALLOW_BASIC_AUTH=true and the right password): wx-admin login ${target.host}`
          : target.auth === 'password'
            ? `The PBX did not accept the sign-in: wx-admin login ${target.host}`
            : `The PBX did not accept the access: check it (wx-admin pbx check) or sign in again (wx-admin login ${target.host}).`;
  }
  if (status === 403) {
    const need = scope ? `${scope}:${['GET', 'HEAD'].includes(method) ? 'read' : '*'}` : undefined;
    return key
      ? `The API key may not do this${need ? `: it needs the scope ${need} (or pbx:${need.endsWith(':read') ? 'read' : '*'})` : ''}; if the key is bound to a PBX user, that extension must exist on this PBX.`
      : 'The PBX refuses this to this user: it needs the Admin role and the ACL of the menu.';
  }
  if (status === 404) return 'Not found on this PBX (an id that does not exist, or a PBX without this API).';
  return '';
}

// A client of the PBX REST API (https://<pbx>/api/v1). call(method, path, body) unwraps {"type":"result","result":X}
// to X and turns {"type":"error",…} and HTTP errors into a PbxError with a hint.
// access: a saved-access object to use instead of resolving one ({host, port, auth, …}): pbx add checks a new access
// with it before anything is saved.
export async function pbxClient(ctx, {access} = {}) {
  const target = access ? targetOf(ctx, upgraded(access), 'option', {persist: false}) : await resolvePbx(ctx);
  const base = pbxBase(ctx, target);
  // options.api 'v2': the routes the PBX serves at /api/v2 (call-group managers); else /api/v1.
  const root = (version) => `${base}/api/${version === 'v2' ? 'v2' : 'v1'}`;
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const checkPath = (apiPath) => {
    if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || apiPath.includes('..') || /[\s#]/.test(apiPath))
      throw new UsageError(`Not an API path: ${apiPath}`);
  };

  // One request. options: scope (the API-key resource, for the hint of a 403); json (a body sent as JSON); data and
  // contentType (a body sent as it is: a FormData for multipart, a Buffer…); responseType 'json' (default: the
  // answer unwrapped), 'buffer' (the bytes, e.g. a recording) or 'response' (the Response, not checked).
  async function request(method, apiPath, options = {}) {
    checkPath(apiPath);
    const headers = {
      'user-agent': userAgent(),
      accept: options.responseType === 'buffer' ? '*/*' : 'application/json',
      authorization: await target.header(),
    };
    let payload;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.json);
    } else if (options.data !== undefined) {
      payload = options.data;
      if (options.contentType) headers['content-type'] = options.contentType;
    }
    const send = async () => {
      try {
        return await fetchImpl(root(options.api) + apiPath, {
          method,
          headers,
          body: payload,
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
      } catch (e) {
        const serialHost = /^[0-9a-f]{8,16}\.wildixin\.com$/.test(target.host) && e.cause?.code === 'ENOTFOUND';
        throw new PbxError(
          `The PBX ${target.host} did not answer (${e.cause?.code ?? e.message})${serialHost ? '. A serial works with --pbx for a PBX wx-admin knows: add it by its name (wx-admin login <name>), which records its serial' : ''}`,
        );
      }
    };
    let res = await send();
    // A sign-in that the PBX no longer takes (Basic turned off, a token it refuses): the access recovers once.
    if (res.status === 401 && target.onUnauthorized && (await target.onUnauthorized())) {
      await res.body?.cancel().catch(() => {});
      headers.authorization = await target.header();
      res = await send();
    }
    if (options.responseType === 'response') return res;
    if (options.responseType === 'buffer' && res.ok) {
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('application/json')) return Buffer.from(await res.arrayBuffer());
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {text};
    }
    if (!res.ok || data?.type === 'error') {
      const reason = data?.reason ?? data?.text?.slice(0, 300) ?? '';
      // errors: a list of messages, or {field: {code, reason}} (validation)
      const errs = data?.errors;
      const details =
        Array.isArray(errs) && errs.length
          ? ` ${JSON.stringify(errs).slice(0, 500)}`
          : errs && typeof errs === 'object' && Object.keys(errs).length
            ? ` (${Object.entries(errs)
                .map(([k, v]) => `${k}: ${v?.reason ?? v?.code ?? JSON.stringify(v)}`)
                .join('; ')
                .slice(0, 500)})`
            : '';
      const why = hint(res.status, target, method, options.scope);
      const err = new PbxError(
        `HTTP ${res.status} from ${target.host} (${method} /api/${options.api === 'v2' ? 'v2' : 'v1'}${apiPath.split('?')[0]}): ${reason}${details}${why ? `\n${why}` : ''}`,
        res.status,
      );
      err.errors = Array.isArray(data?.errors) ? data.errors : [];
      throw err;
    }
    return data?.type === 'result' ? data.result : data;
  }

  return {
    target,
    request,
    // call(method, path, body, {scope}): a JSON request (the common case).
    call: (method, apiPath, body, options = {}) => request(method, apiPath, {...options, json: body}),
  };
}

// The serial of a PBX (its settings, else its license), or null when the access may read neither.
export async function readSerial(client) {
  for (const [path, pick] of [
    ['/PBX/settings/', (r) => r?.pbxSerial],
    ['/PBX/settings/license/', (r) => r?.hwserial ?? r?.limitations?.serial],
  ]) {
    try {
      const v = pick(await client.call('GET', path, undefined, {scope: 'pbx'}));
      if (typeof v === 'string' && /^[0-9a-f]{8,16}$/i.test(v)) return v.toLowerCase();
    } catch {
      // not readable with this access: try the next one
    }
  }
  return null;
}
