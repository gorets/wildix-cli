import {HttpError} from './errors.mjs';
import {userAgent} from './program.mjs';

const SEGMENT = /^[A-Za-z0-9_+][A-Za-z0-9_.:+@-]*$/;

// A tagged template for request paths: every interpolated value is one path segment of id characters (no "/",
// "?", "#", "..", nothing empty), so an id taken from fetched data cannot rewrite the path.
//   apiPath`/channels/${id}/messages`
export function apiPath(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = String(values[i - 1] ?? '');
    if (!SEGMENT.test(v) || v.includes('..'))
      throw new Error(`An id is not safe in a request path: ${JSON.stringify(v)}`);
    return out + encodeURIComponent(v) + s;
  }, '');
}

// "?a=1&b=2" from an object; undefined, null, false and '' are left out; an array repeats the parameter.
export function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v])
      if (item !== undefined && item !== null && item !== false && item !== '') q.append(k, String(item));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

// One request. Redirects are refused, so the token never follows one to another host.
//   body          sent as JSON
//   raw           {data, contentType}: sent as it is (an upload); never with a token to a host the caller did not choose
//   headers       more headers
//   responseType  'json' (default: the parsed answer, {ok: true} when empty), 'text', 'buffer' (a Buffer), 'response'
// Throws HttpError on a status other than 2xx (except with responseType 'response').
export async function request(
  url,
  {
    method = 'GET',
    token,
    body,
    raw,
    headers = {},
    responseType = 'json',
    service,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
    signal,
  } = {},
) {
  const h = {'user-agent': userAgent(), accept: responseType === 'json' ? 'application/json' : '*/*', ...headers};
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw) {
    payload = raw.data;
    if (raw.contentType) h['content-type'] = raw.contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(url, {
    method,
    headers: h,
    body: payload,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (responseType === 'response') return res;
  if (!res.ok)
    throw new HttpError(res.status, method, new URL(url).pathname, await res.text().catch(() => ''), service);
  if (responseType === 'buffer') return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  if (responseType === 'text') return text;
  if (!text) return {ok: true};
  try {
    return JSON.parse(text);
  } catch {
    return {text};
  }
}
