// The CPA token (Cognito PBX Auth): the cloud identity of a PBX, a Cognito ID token whose user is the PBX itself
// (cognito:username = its serial) in the company of the PBX. The PBX gives it to an administrator on an internal route
// of its WMS interface and keeps it until it expires (12 hours). Kept here in the memory of the process only, per PBX,
// and taken again a minute before its end.
import {jwtClaims} from 'wldx-core/auth';
import {AuthError} from 'wldx-core/errors';
import {PbxError, pbxClient} from '../pbx.mjs';

const ROUTE = '/PBX/integration/x-bees?skip-basic-auth-header=true';
const EARLY_MS = 60_000;
const tokens = new Map(); // PBX host → {token, company, companyName, portal, expiresAt, pbx}

export function clearCloudTokens() {
  tokens.clear();
}

export async function cloudToken(ctx) {
  const client = await pbxClient(ctx);
  const host = client.target.host;
  const now = ctx.clock?.() ?? Date.now();
  const kept = tokens.get(host);
  if (kept && kept.expiresAt - now > EARLY_MS) return kept;
  let answer;
  try {
    answer = await client.call('GET', ROUTE);
  } catch (e) {
    if (e instanceof PbxError && (e.status === 401 || e.status === 403))
      throw new AuthError(
        `${host} gives its cloud token only to an administrator: use an access with the Admin role (wx-admin pbx check)`,
      );
    throw e;
  }
  const token = answer?.token;
  if (typeof token !== 'string' || token.split('.').length !== 3)
    throw new Error(`${host} answered no cloud token (WMS too old, or the PBX not linked to the cloud)`);
  const claims = jwtClaims(token);
  const t = {
    token,
    company: claims['custom:company_id'],
    companyName: claims['custom:company_name'],
    portal: answer.portal,
    expiresAt: Number(claims.exp) * 1000,
    pbx: host,
  };
  tokens.set(host, t);
  return t;
}
