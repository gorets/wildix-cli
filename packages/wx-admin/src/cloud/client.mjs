// Requests to a Wildix cloud service with the CPA token of the PBX: only to the base URL of that service (a path,
// never a URL, is accepted), redirects refused, the token cut out of every error. raw() is for presigned links
// (uploads, downloads): it never sends the token.
import {AuthError, UsageError} from 'wldx-core/errors';
import {query} from 'wldx-core/http';
import {userAgent} from 'wldx-core/program';
import {baseOf, envOf, SERVICES} from './env.mjs';
import {cloudToken} from './token.mjs';

const PATH = /^\/(?!\/)[^\s#\\]*$/;

// The type of a service error (a Smithy exception), without its namespace
// (wildix.wilma.common#NothingToPublishException → NothingToPublishException): first the `x-amzn-errortype` header,
// the only place live Wilma names it (`NothingToPublishException:http://internal.amazon.com/…`: the part before the
// first `:`), else the `__type`, `type`, `code` or `name` field of the JSON body.
function errorType(header, j) {
  const h = header?.split(':')[0];
  const t = h || [j?.__type, j?.type, j?.code, j?.name].find((v) => typeof v === 'string' && v !== '');
  return t?.slice(t.lastIndexOf('#') + 1);
}

export async function cloudClient(ctx, service) {
  if (!Object.hasOwn(SERVICES, service)) baseOf(service, 'prod'); // the error of an unknown service
  if (ctx.cloudEnv) baseOf(service, ctx.cloudEnv); // an environment the service lacks: refused before any request
  const first = await cloudToken(ctx);
  const env = ctx.cloudEnv ?? envOf(first.portal);
  const base = baseOf(service, env);
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const seen = new Set([first.token]); // every token this client used: none may show in an error
  const scrub = (s) => [...seen].reduce((out, token) => out.replaceAll(token, '<token>'), String(s ?? ''));

  async function call(method, path, {query: params, json} = {}) {
    if (typeof path !== 'string' || !PATH.test(path) || path.split(/[/?]/).includes('..'))
      throw new UsageError(`Not a path of ${service}: ${path}`);
    // The token of each request: the one in memory, or a new one from the PBX when it is near its end (a long watch).
    const t = await cloudToken(ctx);
    seen.add(t.token);
    const url = `${base}${path}${params ? query(params) : ''}`;
    const headers = {'user-agent': userAgent(), accept: 'application/json', authorization: `Bearer ${t.token}`};
    if (json !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        redirect: 'error',
        signal: ctx.signal,
      });
    } catch (e) {
      throw new Error(`${service} (${base}) is not reachable: ${scrub(e.message)}`);
    }
    const text = scrub(await res.text());
    if (!res.ok) {
      let reason = text.slice(0, 300);
      let j;
      try {
        j = JSON.parse(text);
        reason = j.message ?? j.reason ?? j.error ?? reason;
      } catch {
        // not JSON: the text as it is
      }
      const code = errorType(scrub(res.headers?.get?.('x-amzn-errortype') ?? ''), j);
      if (res.status === 401 || res.status === 403)
        throw new AuthError(
          `the cloud refused the token of ${t.company} for ${service} (${res.status}): ${scrub(reason)}`,
        );
      const err = new Error(`${service} answered ${res.status}: ${scrub(reason)}`);
      err.status = res.status;
      if (code) err.code = code; // what the service says went wrong (NothingToPublishException), for the caller
      err.exitCode = 1;
      throw err;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function raw(method, url, {headers = {}, body} = {}) {
    if (!/^https:\/\//.test(String(url))) throw new UsageError('A presigned link must be https');
    return fetchImpl(url, {method, headers, body, redirect: 'error', signal: ctx.signal});
  }

  return {env, base, company: first.company, companyName: first.companyName, pbx: first.pbx, call, raw};
}
