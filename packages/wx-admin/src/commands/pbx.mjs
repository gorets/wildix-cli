// wx-admin pbx: the PBX the commands work on and the access saved for them.
import {savedSession, sessions} from 'wldx-core/auth';
import {UsageError} from 'wldx-core/errors';
import {paint, table} from 'wldx-core/format';
import {
  API_KEY,
  checkPort,
  loginPbx,
  loginPbxOf,
  normalizeHost,
  pbxClient,
  pbxHostOf,
  readSerial,
  removeAccess,
  resolvePbx,
  saveAccess,
  savedAccess,
  savedPbxs,
  setDefaultPbx,
} from '../pbx.mjs';
import {readSecret} from '../secret.mjs';

const KINDS = {
  apikey: 'a Company API Key (wsk-v1-…), the access Wildix recommends',
  token: 'a Simple Token (deprecated by Wildix: no new ones can be made)',
  basic: 'a user and password (Basic; the PBX accepts it only with ALLOW_BASIC_AUTH=true)',
};

// The PBX of the x-bees login of the profile, if any (no network).
function loginTarget(ctx) {
  const email = ctx.profile ?? sessions(ctx.env)[0]?.email;
  const set = email ? savedSession(email, ctx.env) : undefined;
  return set ? loginPbx(set.IdToken) : undefined;
}

export const groups = {
  pbx: {
    summary: 'the PBX to work on: saved access (API key, token, user), the default one, a check',
    commands: {
      add: {
        summary: 'save access to a PBX; the secret is typed hidden or read from stdin, never an argument',
        usage: 'wx-admin pbx add <host> (--api-key | --token | --basic [--user NAME]) [--port N] [--no-check]',
        details: [
          'host: name.wildixin.com (or just name), another host name, or an IP address.',
          ...Object.entries(KINDS).map(([k, v]) => `  --${k === 'apikey' ? 'api-key' : k}  ${v}`),
          'The access is checked with a read of the PBX before it is kept (--no-check skips it).',
        ].join('\n'),
        options: {
          'api-key': {type: 'boolean', description: 'a Company API Key (wsk-v1-…)'},
          token: {type: 'boolean', description: 'a Simple Token'},
          basic: {type: 'boolean', description: 'a user and password'},
          user: {type: 'string', placeholder: 'NAME', description: 'the user of --basic (default admin)'},
          port: {type: 'string', placeholder: 'N', description: 'the https port of the PBX (default 443)'},
          'no-check': {type: 'boolean', description: 'keep the access without reading the PBX first'},
        },
        args: [1, 1],
        async run(ctx) {
          const {values} = ctx;
          const kinds = ['api-key', 'token', 'basic'].filter((k) => values[k]);
          if (kinds.length !== 1) throw new UsageError('Give one of --api-key, --token, --basic', ctx.usage());
          if (values.user !== undefined && !values.basic) throw new UsageError('--user goes with --basic', ctx.usage());
          const host = normalizeHost(ctx.positionals[0]);
          const port = values.port === undefined ? 443 : checkPort(values.port);
          const auth = kinds[0] === 'api-key' ? 'apikey' : kinds[0];
          const secret = (
            await readSecret(
              ctx,
              auth === 'basic'
                ? `Password of ${values.user ?? 'admin'} on ${host}: `
                : `${auth === 'apikey' ? 'API key' : 'Token'} for ${host}: `,
            )
          ).trim();
          if (!secret) throw new UsageError('Nothing was entered: nothing was saved');
          if (auth === 'apikey' && !API_KEY.test(secret))
            throw new UsageError('Not a Company API Key: it is wsk-v1- and 93 letters and digits. Nothing was saved.');
          if (auth === 'token' && /\s/.test(secret)) throw new UsageError('A token has no spaces. Nothing was saved.');
          const access = {
            host,
            port,
            auth,
            ...(auth === 'basic'
              ? {username: values.user ?? 'admin', password: secret}
              : auth === 'apikey'
                ? {key: secret}
                : {token: secret}),
          };
          // Checked with one read of the PBX before it is kept: nothing is saved (and an access saved before stays) when
          // the PBX refuses it. The check uses this new access only, never WILDIX_PBX_API_KEY or a saved one.
          if (!values['no-check']) {
            const client = await pbxClient(ctx, {access});
            await client.call('GET', '/Dictionaries');
            // the serial, so that --pbx can name the PBX by it too (null when this access may not read it)
            access.serial = await readSerial(client);
          }
          saveAccess(access, ctx.env);
          return {host, port, auth, serial: access.serial ?? null, checked: !values['no-check']};
        },
        text: (r) =>
          `Saved access to ${r.host}${r.serial ? ` (serial ${r.serial})` : ''} (${r.auth})${r.checked ? ', checked' : ''}. Use it with --pbx ${r.host}, or make it the default: wx-admin pbx use ${r.host}`,
      },
      list: {
        summary: 'the PBX with saved access and the PBX of the x-bees login; * marks the default one',
        usage: 'wx-admin pbx list',
        options: {},
        args: [0, 0],
        run(ctx) {
          const saved = savedPbxs(ctx.env);
          const login = loginTarget(ctx);
          return {
            pbxs: saved,
            login: login ?? null,
            default: saved.find((p) => p.default)?.host ?? (login ? `login:${login.host}` : null),
          };
        },
        text(r, ctx) {
          const c = paint(ctx);
          const rows = r.pbxs.map((p) => [
            p.default ? '*' : ' ',
            p.host + (p.port !== 443 ? `:${p.port}` : ''),
            p.serial ?? '',
            p.auth,
          ]);
          if (r.login)
            rows.push([
              r.pbxs.some((p) => p.default) ? ' ' : '*',
              r.login.host,
              r.login.serial ?? '',
              c.dim('the x-bees login'),
            ]);
          return rows.length
            ? table(rows)
            : 'No PBX: add one (wx-admin pbx add <host>) or log in (wx-admin login <e-mail>)';
        },
      },
      use: {
        summary: 'make a PBX with saved access the default one; --login goes back to the PBX of the x-bees login',
        usage: 'wx-admin pbx use (<host> | --login)',
        options: {login: {type: 'boolean', description: 'no default PBX: the PBX of the x-bees login'}},
        args: [0, 1],
        complete: 'pbxs',
        run(ctx) {
          if (ctx.values.login) {
            if (ctx.positionals.length) throw new UsageError('Give a host or --login, not both', ctx.usage());
            setDefaultPbx(undefined, ctx.env);
            return {defaultPbx: null};
          }
          if (!ctx.positionals.length) throw new UsageError('Give a host or --login', ctx.usage());
          const host = pbxHostOf(ctx.positionals[0], ctx);
          if (!savedAccess(host, ctx.env))
            throw new UsageError(`No access saved for ${host}: wx-admin pbx add ${host}`);
          setDefaultPbx(host, ctx.env);
          return {defaultPbx: host};
        },
        text: (r) => (r.defaultPbx ? `Default PBX: ${r.defaultPbx}` : 'Default PBX: the one of the x-bees login'),
      },
      remove: {
        summary: 'forget the saved access to a PBX (on this computer only)',
        usage: 'wx-admin pbx remove <host>',
        options: {},
        args: [1, 1],
        complete: 'pbxs',
        run(ctx) {
          const host = pbxHostOf(ctx.positionals[0], ctx);
          if (!removeAccess(host, ctx.env)) throw new UsageError(`No access saved for ${host}`);
          return {removed: host};
        },
        text: (r) => `Removed the access to ${r.removed}`,
      },
      check: {
        readOnly: true,
        summary: 'which PBX a command would use, and whether it accepts the access (one read)',
        usage: 'wx-admin pbx check',
        options: {},
        args: [0, 0],
        async run(ctx) {
          const target = await resolvePbx(ctx);
          const client = await pbxClient(ctx);
          await client.call('GET', '/Dictionaries');
          // A saved access without its serial (added before wx-admin kept it) gets it now: --pbx can then use it.
          const saved =
            target.auth !== 'login' && !target.fromEnvironment ? savedAccess(target.host, ctx.env) : undefined;
          let serial = saved?.serial ?? (target.auth === 'login' ? loginPbxOf(ctx)?.serial : null) ?? null;
          if (saved && !saved.serial) {
            serial = await readSerial(client);
            if (serial) saveAccess({...saved, serial}, ctx.env);
          }
          return {host: target.host, port: target.port, serial, auth: target.auth, by: target.by, accepted: true};
        },
        text: (r) =>
          `${r.host}${r.serial ? ` (serial ${r.serial})` : ''}: the access (${r.auth === 'login' ? 'x-bees login' : r.auth}) is accepted · ${{option: 'chosen with --pbx', default: 'the default PBX', login: 'the PBX of the x-bees login', environment: 'WILDIX_PBX_API_KEY for WILDIX_PBX_HOST'}[r.by]}`,
      },
    },
  },
};

// Used by completion: the hosts with saved access.
export const pbxHosts = (env) => savedPbxs(env).map((p) => p.host);
