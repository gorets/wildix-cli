// The WMS sign-in for token clients (the public PBX API, operations authLogin, authRefresh, authLogout): a login and
// password, then a second factor when the PBX asks for one, give an access token (a JWT, 1 hour by default) and a
// refresh token (the `wms_refresh` cookie, bound to the PHP session of the sign-in). The refresh token is sent back in
// the body (`refresh_token`), as the API documents for clients without cookies. A PBX forgets an idle session after
// 36 hours and every session when it restarts: the refresh token then fails (kind 'expired').
//
// No state here: the caller keeps the tokens. PHPSESSID lives in memory between the two steps of a sign-in only.
// No Authorization header on these routes (a stale Bearer fails them), the trailing slashes kept, redirects refused.
// Nothing secret goes into an error message: the PBX's reason only.
import {jwtClaims} from 'wldx-core/auth';
import {AuthError} from 'wldx-core/errors';
import {userAgent} from 'wldx-core/program';

// kind: 'credentials' (a wrong login, password or code), 'missing' (no token sign-in on this WMS: 404), 'refused'
// (403: blocked after many attempts, a new location to confirm, not allowed), 'expired' (the refresh token is no
// longer accepted), 'redirect', 'failed' (anything else), 'unreachable'.
export class WmsAuthError extends AuthError {
  constructor(message, kind) {
    super(message);
    this.name = 'WmsAuthError';
    this.kind = kind;
  }
}

// The PBX sends these codes itself (an e-mail, an SMS) and can send them again; others come from an app.
const SENT_BY_PBX = new Set(['email', 'sms']);
const EMPTY_ANSWERS = 3;

async function post(base, path, body, {fetch, cookie, what}) {
  let res;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'user-agent': userAgent(),
        accept: 'application/json',
        'content-type': 'application/json',
        ...(cookie ? {cookie} : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new WmsAuthError(`The PBX did not answer (${e.cause?.code ?? e.message})`, 'unreachable');
  }
  if (res.status >= 300 && res.status < 400)
    throw new WmsAuthError(`The PBX answered ${what} with a redirect (HTTP ${res.status}): refused`, 'redirect');
  let data = {};
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return {res, data, reason: typeof data?.reason === 'string' ? data.reason.slice(0, 300) : ''};
}

function cookies(res) {
  const out = {};
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i < 1) continue;
    out[pair.slice(0, i).trim()] = {value: pair.slice(i + 1).trim()};
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

function tokensOf(res, data, what) {
  const accessToken = data?.result?.access_token;
  const refresh = cookies(res).wms_refresh;
  if (typeof accessToken !== 'string' || !refresh?.value)
    throw new WmsAuthError(`The PBX answered ${what} without the tokens it should give`, 'failed');
  const accessExp = jwtClaims(accessToken).exp;
  const refreshExp = jwtClaims(refresh.value).exp;
  if (!Number.isFinite(accessExp) || !Number.isFinite(refreshExp))
    throw new WmsAuthError(`The PBX answered ${what} with tokens that do not say when they expire`, 'failed');
  return {
    accessToken,
    accessTokenExpires: iso(accessExp * 1000),
    refresh: refresh.value,
    validUntil: iso(refreshExp * 1000),
  };
}

function refusal(status, reason, what, unauthorizedKind) {
  if (status === 404)
    return new WmsAuthError('This PBX does not offer the WMS sign-in for tools (a newer WMS has it)', 'missing');
  if (status === 403) return new WmsAuthError(`The PBX refused ${what}${reason ? `: ${reason}` : ''}`, 'refused');
  if (status === 401) return new WmsAuthError(reason || 'Unauthorized', unauthorizedKind);
  return new WmsAuthError(`The PBX answered ${what} with HTTP ${status}${reason ? `: ${reason}` : ''}`, 'failed');
}

// Signs in: {accessToken, accessTokenExpires, refresh, validUntil} (ISO dates). askCode(factor, {resent}) → the code
// typed by the user; an empty answer has the PBX send an e-mail or SMS code again (resent: true on the next ask).
export async function signIn({base, username, password, askCode, fetch}) {
  const what = 'the sign-in';
  const first = await post(base, '/api/v1/auth/login/', {login: username, password, remember: '1'}, {fetch, what});
  if (!first.res.ok || first.data?.type === 'error') throw refusal(first.res.status, first.reason, what, 'credentials');
  const factor = first.data?.result?.next;
  if (!factor) return tokensOf(first.res, first.data, what);

  const session = cookies(first.res).PHPSESSID?.value;
  if (!session) throw new WmsAuthError('The PBX asked for a second factor without a session', 'failed');
  const cookie = `PHPSESSID=${session}`;
  let code = '';
  let resent = false;
  for (let empty = 0; empty < EMPTY_ANSWERS && !code; empty += 1) {
    code = String((await askCode(String(factor), {resent})) ?? '').trim();
    if (!code && SENT_BY_PBX.has(String(factor).toLowerCase())) {
      await post(
        base,
        `/api/v1/personal/settings/TwoFactor/${encodeURIComponent(String(factor).toLowerCase())}/Code/`,
        {},
        {
          fetch,
          cookie,
          what: 'the request for a new code',
        },
      );
      resent = true;
    }
  }
  if (!code) throw new WmsAuthError('No code was given', 'credentials');
  const second = await post(base, '/api/v1/auth/login/', {type: 'next', code, remember: '1'}, {fetch, cookie, what});
  if (!second.res.ok || second.data?.type === 'error')
    throw refusal(second.res.status, second.reason || 'The code was not accepted', what, 'credentials');
  return tokensOf(second.res, second.data, what);
}

// A new access token (and refresh token) for a refresh token: the same shape as signIn.
export async function renew({base, refresh, fetch}) {
  const what = 'the renewal of the sign-in';
  const r = await post(base, '/api/v1/auth/refresh/', {refresh_token: refresh}, {fetch, what});
  if (!r.res.ok || r.data?.type === 'error') throw refusal(r.res.status, r.reason, what, 'expired');
  return tokensOf(r.res, r.data, what);
}

// Ends the session of the refresh token on the PBX. Never throws: the caller forgets the access anyway.
export async function signOut({base, refresh, fetch}) {
  try {
    const r = await post(base, '/api/v1/auth/logout/', {refresh_token: refresh}, {fetch, what: 'the sign-out'});
    return r.res.ok;
  } catch {
    return false;
  }
}
