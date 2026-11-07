// The Call Control REST API of the user's PBX (https://<pbx>/api/v2/call-control/), as the wildix-call-control
// skill calls it (scripts/lib.sh pbx_call): the PBX from the claims of the login token, the same token as Bearer,
// answers {"type":"result","result":X} unwrapped, {"type":"error","reason":…} (or a status other than 2xx) turned
// into an error with a hint per status. Also the checks of call ids, numbers and device contacts of the skill.
import {jwtClaims} from 'wldx-core/auth';
import {AuthError, UsageError} from 'wldx-core/errors';
import {request} from 'wldx-core/http';
import {pbxUrl} from 'wldx-core/services';

// The SIP watchers that register as a device of the user: wx's own and the one of the skill (sip.sh). They are
// marked in the device lists and never chosen to ring or to place a call.
export const WATCHER_USER_AGENT = 'wx watcher';
const WATCHERS = new Set([WATCHER_USER_AGENT, 'wildix-agent-skills watcher']);
export const isWatcher = (userAgent) => WATCHERS.has(userAgent);

export class PbxError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PbxError';
    this.status = status;
  }
}

const HINTS = {
  401: 'The PBX rejected the login: log in again (wx login <e-mail>). A PBX accepts only the login of its own environment (a production login works only on a production PBX).',
  403: 'The PBX does not allow this to this user: an ordinary user controls only their own calls and devices.',
  503: 'The PBX could not reach its call engine: try again in a moment.',
};

function hint(status, reason) {
  if (status === 404) {
    return reason.includes('404 Not Found')
      ? 'This PBX has no Call Control API: it needs a newer WMS version.'
      : "The PBX does not see this call among the user's current calls: list them again (wx phone list).";
  }
  return HINTS[status];
}

// pbxCall(ctx, METHOD, '/list-calls/', body?): the `result` of the answer (or the whole answer without one).
export async function pbxCall(ctx, method, path, body) {
  if (!/^\/[a-z-]+\/$/.test(path)) throw new Error(`not a call-control path: ${path}`);
  const base = pbxUrl(ctx.token, ctx.env);
  let res;
  try {
    res = await request(`${base}/api/v2/call-control${path}`, {
      method,
      token: ctx.token,
      body,
      fetchImpl: ctx.fetch,
      responseType: 'response',
      timeoutMs: 30_000,
      service: 'the PBX',
    });
  } catch {
    throw new PbxError(`request failed: ${method} ${path} (the PBX ${base} did not answer)`);
  }
  const text = await res.text().catch(() => '');
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok || data?.type === 'error') {
    let reason;
    if (data === undefined) reason = text.slice(0, 500);
    else reason = JSON.stringify(data && typeof data === 'object' && data.reason ? data.reason : data);
    const lines = [`HTTP ${res.status} from the PBX (${method} ${path}): ${reason}`];
    const h = hint(res.status, reason);
    if (h) lines.push(h);
    throw new PbxError(lines.join('\n'), res.status);
  }
  if (data === undefined) return text ? {text} : {};
  return data?.result ?? data;
}

// An action: {ok: true, message} (the message of the PBX, or its whole answer).
export async function pbxAction(ctx, method, path, body) {
  const r = await pbxCall(ctx, method, path, body);
  return {ok: true, message: r?.message ?? r};
}

// A SIP call id as list-calls gives it (the PBX checks the same pattern).
export function checkCallId(id) {
  const v = String(id ?? '');
  if (!/^[A-Za-z0-9.!%*_'+~-]+(@[A-Za-z0-9.-]+)?$/.test(v) || v.length > 100)
    throw new UsageError(`not a call id (take sipCallId from: wx phone list): ${id}`);
  return v;
}

// A number to call or to transfer to: an extension, a phone number, a feature code like *76. Spaces, dashes, dots
// and brackets that people write in phone numbers are dropped; what is left must be +, digits, * and #.
export function normNumber(input) {
  const v = String(input ?? '').replace(/[\s\-.()]/g, '');
  if (!/^\+?[0-9*#]+$/.test(v) || v.length > 40) throw new UsageError(`not a phone number or extension: ${input}`);
  return v;
}

export function checkContact(contact) {
  const v = String(contact ?? '');
  if (!/^sip:\S+$/.test(v) || v.length > 255)
    throw new UsageError(`a device is its SIP contact, as wx phone devices gives it (sip:…): ${contact}`);
  return v;
}

export function checkDigits(digits) {
  const v = String(digits ?? '');
  if (!/^[0-9*#]+$/.test(v)) throw new UsageError(`DTMF digits are 0-9, * and #: ${digits}`);
  return v;
}

// The extension of the login (custom:pbx_user_extension).
export function extensionOf(token) {
  const ext = jwtClaims(token)['custom:pbx_user_extension'];
  if (!/^[0-9]+$/.test(String(ext ?? '')))
    throw new UsageError('this login has no PBX extension (custom:pbx_user_extension)');
  return String(ext);
}

// The SIP password of the user: the PBX gives it to the user's own login token. Never printed.
export async function sipPassword(ctx, extension) {
  const base = pbxUrl(ctx.token, ctx.env);
  let res;
  try {
    // Without `Connection: close` the socket of this request may be reused for the SIP WebSocket to the same host,
    // which the PBX then closes at once (seen with the skill).
    res = await request(`${base}/api/v1/personal/info?fields=extension%2CsipPassword`, {
      token: ctx.token,
      fetchImpl: ctx.fetch,
      headers: {connection: 'close'},
      responseType: 'response',
      timeoutMs: 30_000,
    });
  } catch {
    throw new PbxError(`request failed: GET /api/v1/personal/info (the PBX ${base} did not answer)`);
  }
  if (res.status === 401) throw new AuthError('the PBX rejected the login: log in again (wx login <e-mail>)');
  if (!res.ok) throw new PbxError(`the PBX gave no personal info (HTTP ${res.status})`, res.status);
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const info = body?.result ?? body;
  if (!info?.sipPassword) throw new PbxError('the PBX did not give the SIP password of this user');
  if (String(info.extension) !== String(extension))
    throw new PbxError(`the PBX answered for extension ${info.extension}, not ${extension}`);
  return String(info.sipPassword);
}

// The SIP WebSocket of the PBX: wss://<host>/sip/ (the host and port of the PBX address; ws:// only for a custom
// http:// address in tests) and the SIP domain (the host name).
export function sipEndpoint(token, env) {
  const base = new URL(pbxUrl(token, env));
  const scheme = base.protocol === 'http:' ? 'ws:' : 'wss:';
  return {wsUrl: `${scheme}//${base.host}/sip/`, domain: base.hostname};
}
