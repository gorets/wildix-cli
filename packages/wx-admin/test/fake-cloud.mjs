// A PBX that hands out a CPA token and the cloud services behind it, in one fetch. `cloud(method, url, init)` answers
// the service requests ({status, body} or a Response); every request is recorded with its headers.
import {clearCloudTokens} from '../src/cloud/token.mjs';
import {fakeJwt, tempConfigDir} from './helpers.mjs';

export const KEY = `wsk-v1-${'a'.repeat(93)}`;
export const EXP = Date.UTC(2026, 10, 7, 20) / 1000;
export const CPA = fakeJwt({'custom:company_id': 'it_x', 'custom:company_name': 'X Inc', exp: EXP});

export function fakeCloud(cloud, {portal = 'https://wim-console-stage.wildix.com'} = {}) {
  clearCloudTokens();
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;
    if (typeof body === 'string' && headers['content-type']?.includes('json')) body = JSON.parse(body);
    calls.push({
      method: init.method ?? 'GET',
      url: u.href,
      host: u.host,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers,
      body,
    });
    if (u.host === 'demo.wildixin.com')
      return new Response(JSON.stringify({type: 'result', result: {token: CPA, portal}}), {status: 200});
    const a = await cloud(init.method ?? 'GET', u, {headers, body});
    if (a instanceof Response) return a;
    return new Response(a?.body === undefined ? '' : JSON.stringify(a.body), {status: a?.status ?? 200});
  };
  return {fetch, calls, cloudCalls: () => calls.filter((c) => c.host !== 'demo.wildixin.com')};
}

export const envOfTest = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});
export const ctxOf = (f, extra = {}) => {
  const now = Date.UTC(2026, 10, 7, 12);
  return {env: envOfTest(), fetch: f.fetch, values: {}, info: () => {}, clock: () => now, now, ...extra};
};
