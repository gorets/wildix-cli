// The addresses of the Wildix services. The token is sent only to these: https/wss hosts under wildix.com, the
// x-bees API, and the user's own PBX named in the claims of the login token. Overrides (tests against a local
// server) are honoured only with WILDIX_ALLOW_CUSTOM_URL=1, except WILDIX_STREAM_URL and WILDIX_WDA_URL, which may
// name another https host under wildix.com.
import {jwtClaims} from './auth.mjs';
import {UsageError} from './errors.mjs';

export const XBEES_API = 'https://api.x-bees.com';

const UNDER_WILDIX = (scheme) => new RegExp(`^${scheme}://[a-z0-9-]+(\\.[a-z0-9-]+)*\\.wildix\\.com(:[0-9]+)?$`);
const HTTPS_WILDIX = UNDER_WILDIX('https');
const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const custom = (env) => env.WILDIX_ALLOW_CUSTOM_URL === '1';
const trim = (url) => url.replace(/\/+$/, '');

// base(variable, default, env, {wildixOverride}): the default, or the override in `variable` when allowed.
function base(variable, fallback, env, {wildixOverride = false} = {}) {
  const given = env[variable];
  if (!given) return fallback;
  const url = trim(given);
  if (custom(env)) return url;
  if (wildixOverride && HTTPS_WILDIX.test(url)) return url;
  throw new UsageError(
    wildixOverride
      ? `${variable} must be https://<host>.wildix.com (another address only with WILDIX_ALLOW_CUSTOM_URL=1), got: ${url}`
      : `${variable} is honoured only with WILDIX_ALLOW_CUSTOM_URL=1 (tests), got: ${url}`,
  );
}

function region(env) {
  const r = env.WILDIX_STREAM_REGION || 'eu-1';
  if (!/^[a-z0-9-]{1,32}$/.test(r)) throw new UsageError(`WILDIX_STREAM_REGION is not a region: ${r}`);
  return r;
}

// Chats (the stream service): https://<region>.stream.wildix.com, the live feed wss://<region>-ws.stream.wildix.com.
export const streamUrl = (env = process.env) =>
  base('WILDIX_STREAM_URL', `https://${region(env)}.stream.wildix.com`, env, {wildixOverride: true});
export const streamWsUrl = (env = process.env) =>
  base('WILDIX_STREAM_WS_URL', `wss://${region(env)}-ws.stream.wildix.com`, env);

// Wildix Data Analytics: history, insights, reports (https://wda.wildix.com), the live stream (wss://wda-ws...).
export const wdaUrl = (env = process.env) =>
  base('WILDIX_WDA_URL', 'https://wda.wildix.com', env, {wildixOverride: true});
export const wdaWsUrl = (env = process.env) => base('WILDIX_WDA_WS_URL', 'wss://wda-ws.wildix.com', env);

// The x-bees API (users, conversations of the older service, token check).
export const xbeesUrl = (env = process.env) => base('WILDIX_XBEES_URL', XBEES_API, env);

// The user's PBX: the login token names it (custom:pbx_domain, custom:pbx_port) and the PBX accepts that token.
export function pbxUrl(token, env = process.env) {
  if (env.WILDIX_PBX_URL) return base('WILDIX_PBX_URL', undefined, env);
  const claims = jwtClaims(token);
  const host = claims['custom:pbx_domain'];
  const port = claims['custom:pbx_port'];
  if (!host)
    throw new UsageError(
      'This login is not linked to a PBX (the token has no custom:pbx_domain): this needs a PBX user',
    );
  if (!HOST.test(host)) throw new UsageError(`The PBX address in the login is not a host name: ${host}`);
  if (port !== undefined && port !== '' && !/^[0-9]{1,5}$/.test(String(port)))
    throw new UsageError(`The PBX port in the login is not a number: ${port}`);
  return `https://${host}${port && String(port) !== '443' ? `:${port}` : ''}`;
}
