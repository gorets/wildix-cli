// Requests to a Wildix cloud service with the CPA token of the PBX: only to the base URL of that service (a path,
// never a URL, is accepted), redirects refused, the token cut out of every error. raw() is for presigned links
// (uploads, downloads): it never sends the token.
import {AuthError, UsageError} from 'wldx-core/errors';
import {query} from 'wldx-core/http';
import {userAgent} from 'wldx-core/program';
import {baseOf, envOf, SERVICES} from './env.mjs';
import {cloudToken} from './token.mjs';

const PATH = /^\/(?!\/)[^\s#\\]*$/;

export async function cloudClient(ctx, service) {
  if (!Object.hasOwn(SERVICES, service)) baseOf(service, 'prod'); // the error of an unknown service
  const t = await cloudToken(ctx);
  const env = ctx.cloudEnv ?? envOf(t.portal);
  const base = baseOf(service, env);
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const scrub = (s) => String(s ?? '').replaceAll(t.token, '<token>');

  async function call(method, path, {query: params, json} = {}) {
    if (typeof path !== 'string' || !PATH.test(path) || path.split(/[/?]/).includes('..'))
      throw new UsageError(`Not a path of ${service}: ${path}`);
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
      try {
        const j = JSON.parse(text);
        reason = j.message ?? j.reason ?? j.error ?? reason;
      } catch {
        // not JSON: the text as it is
      }
      if (res.status === 401 || res.status === 403)
        throw new AuthError(
          `the cloud refused the token of ${t.company} for ${service} (${res.status}): ${scrub(reason)}`,
        );
      const err = new Error(`${service} answered ${res.status}: ${scrub(reason)}`);
      err.status = res.status;
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

  return {env, base, company: t.company, companyName: t.companyName, pbx: t.pbx, call, raw};
}
