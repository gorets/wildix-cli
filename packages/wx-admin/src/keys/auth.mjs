// The Auth API Keys service (Company API Keys): https://auth[-stable|-stage].wildix.com/api/v3. Only the root admin of
// the company may call it, with an OpenID user token that has scope=api-keys and aud=https://<auth host>. The token is
// made like this, from the access wx-admin already has to the PBX (no password asked):
//   1. GET /api/v1/personal/token/?service=<auth host> on the PBX → a personal token (about 30 seconds);
//   2. POST https://<auth host>/api/v2/OpenId/service {aud, scope} with it → id_token;
//   3. /api/v3/... with the id token.
// `aud` must be the auth host of the environment: the service answers 200 for any aud and then refuses /api/v3 with 401.
// Both tokens stay in memory, are never printed and are cut out of every error. A Company API Key login cannot do
// this (the service needs the user token of the admin), and a user who is not the root admin is refused.
import {AuthError, UsageError} from 'wldx-core/errors';
import {query} from 'wldx-core/http';
import {userAgent} from 'wldx-core/program';
import {envOf} from '../cloud/env.mjs';
import {cloudToken} from '../cloud/token.mjs';
import {pbxClient} from '../pbx.mjs';

export const AUTH_HOSTS = {prod: 'auth.wildix.com', stable: 'auth-stable.wildix.com', stage: 'auth-stage.wildix.com'};
const PATH = /^\/(?!\/)[^\s#\\]*$/;
const WHO = 'only the root admin of the company may manage Company API Keys';

export async function keysClient(ctx) {
  const pbx = await pbxClient(ctx);
  const {target} = pbx;
  if (target.auth === 'apikey')
    throw new AuthError(
      `A Company API Key cannot manage keys (the service needs the user token of the admin): sign in with the password of the root admin, wx-admin login ${target.host} --password`,
    );
  const env = ctx.cloudEnv ?? envOf((await cloudToken(ctx)).portal);
  if (!Object.hasOwn(AUTH_HOSTS, env)) throw new UsageError(`Unknown environment: ${env}`);
  const host = AUTH_HOSTS[env];
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const seen = new Set();
  const scrub = (s) => [...seen].reduce((out, t) => out.replaceAll(t, '<token>'), String(s ?? ''));
  const send = async (url, init) => {
    try {
      return await fetchImpl(url, {redirect: 'error', signal: ctx.signal, ...init});
    } catch (e) {
      throw new Error(`${host} is not reachable: ${scrub(e.message)}`);
    }
  };
  const fail = (res, text) => {
    let reason = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      reason = j.message ?? j.reason ?? reason;
    } catch {}
    const hint = [401, 403].includes(res.status)
      ? ` (${WHO}; this access is ${target.host} as ${target.user ?? 'a user'})`
      : '';
    const err = new Error(`HTTP ${res.status} from ${host}: ${scrub(reason)}${hint}`);
    err.status = res.status;
    if ([401, 403].includes(res.status)) err.exitCode = 2;
    return err;
  };

  async function mint() {
    let personal;
    try {
      personal = (await pbx.call('GET', `/personal/token/${query({service: host})}`))?.token;
    } catch (e) {
      if (e.status === 401 || e.status === 403)
        throw new AuthError(
          `${target.host} refused a personal token: ${WHO}; sign in as it (wx-admin login ${target.host} --password)`,
        );
      throw e;
    }
    if (typeof personal !== 'string' || !personal) throw new Error(`${target.host} gave no personal token`);
    seen.add(personal);
    const res = await send(`https://${host}/api/v2/OpenId/service`, {
      method: 'POST',
      headers: {
        'user-agent': userAgent(),
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${personal}`,
      },
      body: JSON.stringify({aud: `https://${host}`, scope: 'api-keys'}),
    });
    const text = await res.text();
    if (!res.ok) throw fail(res, text);
    let data;
    try {
      data = JSON.parse(text);
    } catch {}
    const id = data?.result?.id_token ?? data?.id_token;
    if (typeof id !== 'string' || !id) throw new Error(`${host} gave no id token`);
    seen.add(id);
    return id;
  }

  let idToken;
  // One request to /api/v3; a 401 mints the tokens again once (the id token may have ended).
  async function call(method, path, {json} = {}) {
    if (typeof path !== 'string' || !PATH.test(path) || path.split(/[/?]/).includes('..'))
      throw new UsageError(`Not a path of the keys service: ${path}`);
    for (let attempt = 0; ; attempt++) {
      idToken ??= await mint();
      const res = await send(`https://${host}/api/v3${path}`, {
        method,
        headers: {
          'user-agent': userAgent(),
          accept: 'application/json',
          authorization: `Bearer ${idToken}`,
          ...(json === undefined ? {} : {'content-type': 'application/json'}),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      const text = await res.text();
      if (res.status === 401 && attempt === 0) {
        idToken = undefined;
        continue;
      }
      if (!res.ok) throw fail(res, text);
      return text ? JSON.parse(text) : {};
    }
  }
  return {call, host, env, pbxHost: target.host, pbxPort: target.port};
}
