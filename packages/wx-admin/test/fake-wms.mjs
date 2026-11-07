// A PBX in memory for signing in: the WMS token sign-in (/api/v1/auth/{login,refresh,logout}/ with a second factor,
// sessions, refresh tokens bound to them), Basic (on or off), Bearer checks, and a few readable routes. It counts the
// sign-in attempts (Basic requests and password logins) so that tests can hold the code to one of each.
import {fakeJwt} from './helpers.mjs';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const result = (r, headers) => json(200, {type: 'result', result: r}, headers);
const error = (status, reason, headers) => json(status, {type: 'error', reason, code: null, result: null}, headers);

// users: {name: {password, factor?, code?, blocked?}}. basic: Basic accepted; auth: the /auth/* routes exist.
// now(): the clock of the PBX in ms. serial: what /PBX/settings/ answers.
export function fakeWms({
  users = {admin: {password: 'pw'}},
  basic = true,
  auth = true,
  accessTtl = 3600,
  refreshTtl = 604800,
  now = () => Date.now(),
  serial = '2211000000ef',
  redirectLogin = false,
} = {}) {
  let n = 0;
  const state = {
    users,
    basic,
    auth,
    attempts: {basic: 0, signIn: 0},
    resent: 0,
    sessions: new Map(), // sid → {user, done: boolean, factor}
    calls: [],
  };
  const sec = () => Math.floor(now() / 1000);
  const issue = (sid) => {
    const s = state.sessions.get(sid);
    n += 1;
    const access = fakeJwt({typ: 'access', user: s.user, sid, exp: sec() + accessTtl, n});
    const refresh = fakeJwt({typ: 'refresh', user: s.user, sid, exp: sec() + refreshTtl, n});
    return result(
      {access_token: access, token_type: 'Bearer', expires_in: accessTtl},
      {
        'set-cookie': `wms_refresh=${refresh}; Expires=x; Max-Age=${refreshTtl}; Path=/api/v1/auth/refresh/; Secure; HttpOnly; SameSite=Strict`,
      },
    );
  };
  const claims = (t) => {
    try {
      return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());
    } catch {
      return {};
    }
  };
  const cookieOf = (headers, name) =>
    String(headers?.cookie ?? '')
      .split(/;\s*/)
      .map((p) => p.split('='))
      .find(([k]) => k === name)?.[1];

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({method: init.method ?? 'GET', path, headers, body, redirect: init.redirect});

    if (path.startsWith('/api/v1/auth/')) {
      if (!state.auth) return error(404, 'Not found');
      if (headers.authorization) return error(401, 'Unauthorized');
      if (path === '/api/v1/auth/login/') {
        if (redirectLogin) return new Response('', {status: 302, headers: {location: '/somewhere'}});
        if (body?.type === 'next') {
          const sid = cookieOf(headers, 'PHPSESSID');
          const s = state.sessions.get(sid);
          if (!s || s.done) return error(401, 'Unauthorized');
          if (String(body.code) !== String(state.users[s.user].code)) return error(401, 'Wrong code');
          s.done = true;
          return issue(sid);
        }
        state.attempts.signIn += 1;
        const user = state.users[body?.login];
        if (user?.blocked) return error(403, user.blocked);
        if (!user || user.password !== body?.password) return error(401, 'Login or password incorrect');
        n += 1;
        const sid = `s${n}`;
        state.sessions.set(sid, {user: body.login, done: !user.factor, factor: user.factor});
        const cookie = {'set-cookie': `PHPSESSID=${sid}; path=/; HttpOnly`};
        if (user.factor) return result({next: user.factor}, cookie);
        return issue(sid);
      }
      if (path === '/api/v1/auth/refresh/') {
        const c = claims(body?.refresh_token ?? cookieOf(headers, 'wms_refresh'));
        const s = state.sessions.get(c.sid);
        if (c.typ !== 'refresh' || !s?.done || c.exp <= sec()) return error(401, 'Unauthorized');
        return issue(c.sid);
      }
      if (path === '/api/v1/auth/logout/') {
        const c = claims(body?.refresh_token);
        if (c.typ === 'refresh') state.sessions.delete(c.sid);
        return result('OK');
      }
      return error(404, 'Not found');
    }
    const resend = /^\/api\/v1\/personal\/settings\/TwoFactor\/([a-z]+)\/Code\/$/.exec(path);
    if (resend) {
      const s = state.sessions.get(cookieOf(headers, 'PHPSESSID'));
      if (!s || s.done) return error(401, 'Unauthorized');
      state.resent += 1;
      return result('OK');
    }

    // The rest of the API: Basic or Bearer.
    const authz = String(headers.authorization ?? '');
    if (authz.startsWith('Basic ')) {
      state.attempts.basic += 1;
      const [login, ...rest] = Buffer.from(authz.slice(6), 'base64').toString().split(':');
      if (!state.basic || state.users[login]?.password !== rest.join(':')) return error(401, 'Unauthorized');
    } else if (authz.startsWith('Bearer ')) {
      const c = claims(authz.slice(7));
      if (c.typ !== 'access' || c.exp <= sec() || !state.sessions.get(c.sid)?.done)
        return error(401, 'Unauthorized', {'www-authenticate': 'Bearer error="invalid_token"'});
    } else return error(401, 'Unauthorized');
    if (path === '/api/v1/PBX/settings/') return result({pbxSerial: serial});
    return result({});
  };
  return {fetch, state};
}
