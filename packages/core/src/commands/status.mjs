// status: the version, the profiles and who the current one is (from the claims of its token). No
// network, unless --check asks Wildix whether it accepts the token. Never prints a token.
import {chooseProfile, defaultProfile, getToken, jwtClaims, savedSession, sessions} from '../auth.mjs';
import {AuthError, HttpError} from '../errors.mjs';
import {localTime, paint, table} from '../format.mjs';
import {request} from '../http.mjs';
import {XBEES_API} from '../services.mjs';
import {program} from '../program.mjs';

function whoami(claims) {
  const port = claims['custom:pbx_port'];
  return {
    email: claims.email,
    name: claims.name,
    company: claims['custom:company_name'],
    license: claims['custom:company_license_type'],
    pbx: claims['custom:pbx_domain']
      ? {
          host: claims['custom:pbx_domain'] + (port && String(port) !== '443' ? `:${port}` : ''),
          serial: claims['custom:pbx_serial'],
          extension: claims['custom:pbx_user_extension'],
          role: claims['custom:pbx_user_role'],
        }
      : undefined,
  };
}

export default {
  get summary() {
    return `who you are logged in as, until when, and the version of ${program.name}`;
  },
  get usage() {
    return `${program.name} status [--profile EMAIL] [--check]`;
  },
  options: {
    check: {type: 'boolean', description: 'also ask Wildix whether it accepts the token (renews it when needed)'},
  },
  args: [0, 0],
  async run(ctx) {
    const {env, values} = ctx;
    const byDefault = defaultProfile(env);
    const all = sessions(env).map((s) => ({
      email: s.email,
      default: s.email === byDefault,
      tokenValidUntil: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      expired: s.expiresAt <= ctx.now,
    }));
    const out = {
      version: program.version,
      loggedIn: false,
      profile: null,
      user: null,
      tokenFromEnvironment: Boolean(env.WILDIX_ID_TOKEN),
      profiles: all,
    };
    let token;
    if (env.WILDIX_ID_TOKEN) {
      token = env.WILDIX_ID_TOKEN;
    } else {
      let email;
      try {
        const chosen = chooseProfile(env, values.profile);
        email = chosen.email;
        out.profile = {email, by: chosen.by};
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        out.problem = e.message;
        return out;
      }
      const session = all.find((s) => s.email === email);
      if (!session) {
        out.problem = `No saved session for ${email}. Log in with: ${program.name} login ${email}`;
        return out;
      }
      out.tokenValidUntil = session.tokenValidUntil;
      token = values.check
        ? await getToken({profile: email, env, fetchImpl: ctx.fetch, now: ctx.clock()})
        : savedSession(email, env)?.IdToken;
    }
    out.loggedIn = true;
    out.user = whoami(jwtClaims(token));
    if (values.check) {
      try {
        await request(`${XBEES_API}/v2/conversations/inbox/state`, {token, fetchImpl: ctx.fetch, service: 'x-bees'});
        out.tokenAccepted = true;
      } catch (e) {
        if (!(e instanceof HttpError) || ![401, 403].includes(e.status)) throw e;
        out.tokenAccepted = false;
        out.problem = `Wildix rejected the token (HTTP ${e.status}). Log in again: ${program.name} login ${out.user.email ?? '<e-mail>'}`;
      }
    }
    return out;
  },
  text(r, ctx) {
    const c = paint(ctx);
    const rows = [[program.name, r.version]];
    if (r.user) {
      const a = r.user;
      const why = r.profile
        ? {
            option: 'chosen with --profile',
            environment: 'chosen with WILDIX_EMAIL',
            default: 'the default',
            only: 'the only one',
          }[r.profile.by]
        : 'from WILDIX_ID_TOKEN';
      rows.push(['Profile', `${a.email ?? ''}${a.name ? ` (${a.name})` : ''} · ${why}`]);
      if (a.company) rows.push(['Company', `${a.company}${a.license ? ` · ${a.license}` : ''}`]);
      if (a.pbx)
        rows.push([
          'PBX',
          [
            a.pbx.host,
            a.pbx.serial && `serial ${a.pbx.serial}`,
            a.pbx.extension && `extension ${a.pbx.extension}`,
            a.pbx.role,
          ]
            .filter(Boolean)
            .join(' · '),
        ]);
    }
    if (r.tokenFromEnvironment) rows.push(['Token', 'from WILDIX_ID_TOKEN']);
    else if (r.tokenValidUntil)
      rows.push(['Token', `valid until ${localTime(r.tokenValidUntil)} (renewed automatically)`]);
    if (r.tokenAccepted !== undefined)
      rows.push(['Check', r.tokenAccepted ? c.green('Wildix accepts the token') : c.red('rejected')]);
    if (r.profiles.length > 1)
      rows.push([
        'Profiles',
        `${r.profiles.map((p) => `${p.email}${p.default ? ' (default)' : ''}`).join(', ')} · ${program.name} profile use <e-mail>`,
      ]);
    const lines = table(rows);
    if (r.problem) lines.push(c.yellow(r.problem));
    else if (!r.loggedIn) lines.push(c.yellow(`Not logged in. Run: ${program.name} login <e-mail>`));
    return lines;
  },
};
