// wx-admin pbx: the PBX the commands work on and the access saved for them.
import {UsageError} from 'wldx-core/errors';
import {table} from 'wldx-core/format';
import {
  accessLabel,
  pbxClient,
  pbxHostOf,
  readSerial,
  saveAccess,
  savedAccess,
  savedPbxs,
  setDefaultPbx,
} from '../pbx.mjs';

export const groups = {
  pbx: {
    summary: 'the PBX signed in to (wx-admin login): the list, the default one, a check',
    commands: {
      list: {
        summary: 'the PBX with saved access; * marks the default one',
        usage: 'wx-admin pbx list',
        options: {},
        args: [0, 0],
        run(ctx) {
          const saved = savedPbxs(ctx.env);
          return {
            pbxs: saved,
            default: saved.find((p) => p.default)?.host ?? (saved.length === 1 ? saved[0].host : null),
          };
        },
        text(r) {
          const rows = r.pbxs.map((p) => [
            p.host === r.default ? '*' : ' ',
            p.host + (p.port !== 443 ? `:${p.port}` : ''),
            p.serial ?? '',
            accessLabel(p),
          ]);
          return rows.length ? table(rows) : 'No PBX: wx-admin login <host>';
        },
      },
      use: {
        summary: 'make a PBX with saved access the default one (commands without --pbx go there)',
        usage: 'wx-admin pbx use <host>',
        options: {},
        args: [1, 1],
        complete: 'pbxs',
        run(ctx) {
          const host = pbxHostOf(ctx.positionals[0], ctx);
          if (!savedAccess(host, ctx.env)) throw new UsageError(`Not signed in to ${host}: wx-admin login ${host}`);
          setDefaultPbx(host, ctx.env);
          return {defaultPbx: host};
        },
        text: (r) => `Default PBX: ${r.defaultPbx}`,
      },
      check: {
        readOnly: true,
        summary: 'which PBX a command would use, and whether it accepts the access (one read)',
        usage: 'wx-admin pbx check',
        options: {},
        args: [0, 0],
        async run(ctx) {
          const client = await pbxClient(ctx);
          const {target} = client;
          await client.call('GET', '/Dictionaries');
          // Read after the calls: a password access may have moved between Basic and the WMS sign-in meanwhile.
          let saved = target.fromEnvironment ? undefined : savedAccess(target.host, ctx.env);
          // A saved access without its serial (signed in to before wx-admin kept it) gets it now: --pbx can use it.
          let serial = saved?.serial ?? null;
          if (saved && !saved.serial) {
            serial = await readSerial(client);
            saved = savedAccess(target.host, ctx.env);
            if (serial && saved) saveAccess({...saved, serial}, ctx.env);
          }
          return {
            host: target.host,
            port: target.port,
            serial,
            auth: target.auth,
            ...(saved?.auth === 'password' ? {mode: saved.mode, user: saved.username} : {}),
            by: target.by,
            accepted: true,
          };
        },
        text: (r) =>
          `${r.host}${r.serial ? ` (serial ${r.serial})` : ''}: the access (${accessLabel(r)}) is accepted · ${{option: 'chosen with --pbx', default: 'the default PBX', only: 'the only PBX signed in to', environment: 'WILDIX_PBX_API_KEY for WILDIX_PBX_HOST'}[r.by]}`,
      },
    },
  },
};

// Used by completion: the hosts with saved access.
export const pbxHosts = (env) => savedPbxs(env).map((p) => p.host);
