// wx-admin key: the Company API Keys of the company of the PBX (the keys other tools sign in to the PBX API with, and
// `wx-admin login --api-key`), made and managed in the Auth API Keys service (src/keys/auth.mjs: only the root admin
// may, with a token minted from the access wx-admin already has to the PBX; a key login cannot).
// Operations (auth-api-keys, https://auth[-stable|-stage].wildix.com/api/v3): CreateApiKey (POST /api-keys/),
// ListApiKeys, GetApiKey, UpdateApiKey (PUT /api-keys/{id}: only the name), DeleteApiKey, ListScopes (GET /scopes).
// The service returns the key value (wsk-v1-…) only in the answer to the creation and keeps a hash: the value goes to
// a new 0600 file (--to), becomes the login of the PBX (--login) or is printed (--show-secrets), and `create` refuses
// to start without one of the three (a key nobody can read is useless).
import {UsageError} from 'wldx-core/errors';
import {localTime, table} from 'wldx-core/format';
import {select} from 'wldx-core/select';
import {keysClient} from '../keys/auth.mjs';
import {pickByName} from '../match.mjs';
import {saveAccess, savedAccess} from '../pbx.mjs';
import {checkNewFile, writeNewFile} from './records.mjs';

const ID = /^[0-9a-zA-Z-]{40}$/;
const SCOPE = /^[0-9a-zA-Z_*]+:[0-9a-zA-Z-_*]+$/;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const UNITS = {m: 60_000, h: HOUR, d: DAY, w: 7 * DAY, y: 365 * DAY};
const terminal = (ctx) => Boolean(ctx.stdin?.isTTY && typeof ctx.stdin.setRawMode === 'function');
const byId = (id) => `/api-keys/${encodeURIComponent(id)}`;

// --expires: a duration (90m, 12h, 30d, 2w, 1y = 365 days) or an ISO date; the service takes 1 hour to 1 year from now.
// Exactly 1 hour is moved a minute past the minimum: the service counts from a later "now".
export function expiresAt(value, now) {
  const text = String(value);
  const d = /^(\d+)([mhdwy])$/.exec(text);
  let ms;
  if (d) ms = Number(d[1]) * UNITS[d[2]];
  else if (/^\d{4}-\d\d-\d\d/.test(text) && !Number.isNaN(Date.parse(text))) ms = Date.parse(text) - now;
  else throw new UsageError(`--expires is a duration (90m, 12h, 30d, 1y) or an ISO date, not ${JSON.stringify(text)}`);
  if (ms < HOUR) throw new UsageError('--expires must be at least 1 hour from now');
  if (ms > UNITS.y) throw new UsageError('--expires must be at most 1 year from now');
  return {at: new Date(now + Math.max(ms, HOUR + 60_000)).toISOString(), ms};
}

// The picker's groups from the catalog of scopes.
export function scopeGroups(scopes) {
  const groups = new Map();
  for (const s of scopes) {
    const id = s.group || 'Other';
    if (!groups.has(id)) groups.set(id, {id, label: id, items: []});
    groups.get(id).items.push({
      id: s.scope,
      label: s.scope,
      note: s.description,
      ...(s.status ? {badge: s.status} : {}),
      // The service refuses these when a key is made.
      ...(['future', 'deprecated'].includes(s.status)
        ? {disabled: `${s.status}: the service does not give it to a key`}
        : {}),
    });
  }
  return [...groups.values()];
}

async function resolveId(client, ref) {
  if (ID.test(ref)) return {id: ref};
  const keys = (await client.call('GET', '/api-keys/')).apiKeys ?? [];
  const k = pickByName(keys, ref, (x) => x.name, 'key', 'wx-admin key list');
  return {id: k.id, name: k.name};
}

const scopesText = (k) => (k.scopes ?? []).join(', ');
const keyLines = (k) => [
  `${k.name}  ${k.id}`,
  `  scopes: ${scopesText(k)}`,
  `  expires: ${localTime(k.expiresAt)}${k.userExtension ? `  · bound to extension ${k.userExtension}` : ''}`,
  `  created: ${localTime(k.createdAt)}`,
];

export const groups = {
  key: {
    summary: 'Company API Keys of the company: create, list, rename, delete (the root admin, with the password login)',
    commands: {
      scopes: {
        summary: 'the scopes a key can have',
        usage: 'wx-admin key scopes [--group NAME]',
        options: {
          group: {type: 'string', placeholder: 'NAME', description: 'only the scopes of this group (case ignored)'},
        },
        args: [0, 0],
        async run(ctx) {
          const client = await keysClient(ctx);
          const all = (await client.call('GET', '/scopes')).scopes ?? [];
          const want = ctx.values.group?.toLowerCase();
          return {scopes: want ? all.filter((s) => String(s.group).toLowerCase() === want) : all};
        },
        text: (r) =>
          r.scopes.length
            ? table(r.scopes.map((s) => [s.scope, s.group, s.status ?? '', s.description ?? '']))
            : 'No scopes.',
      },
      list: {
        summary: 'the keys of the company (name, scopes, expiry; the key values are never shown again)',
        usage: 'wx-admin key list',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return {apiKeys: (await (await keysClient(ctx)).call('GET', '/api-keys/')).apiKeys ?? []};
        },
        text: (r) =>
          r.apiKeys.length
            ? table(r.apiKeys.map((k) => [k.name, k.id, localTime(k.expiresAt), scopesText(k), k.userExtension ?? '']))
            : 'No keys.',
      },
      get: {
        summary: 'one key by id or name',
        usage: 'wx-admin key get <id|name>',
        options: {},
        args: [1, 1],
        async run(ctx) {
          const client = await keysClient(ctx);
          const {id} = await resolveId(client, ctx.positionals[0]);
          return client.call('GET', byId(id));
        },
        text: (r) => keyLines(r.apiKey),
      },
      create: {
        summary: 'make a key; its value is shown once and goes to a file, to the login of the PBX, or to the screen',
        usage:
          'wx-admin key create --name NAME [--scope SCOPE ...] [--expires 30d|DATE] [--user EXT] (--to FILE | --login --yes | --show-secrets)',
        details: [
          'The key value (wsk-v1-…) exists only in the answer to this command: the service keeps a hash. So `create`',
          'needs a place for it, and never prints it unless you say so:',
          '  --to FILE         a new file, mode 0600 (never overwrites)',
          '  --login --yes     becomes the login of this PBX (replaces the saved access; a key login cannot manage keys,',
          '                    sign in again with wx-admin login --password to do that)',
          '  --show-secrets    printed',
          'Scopes: --scope is repeatable ({resource}:read for GET, {resource}:* for the rest, pbx:read, pbx:*); in a',
          'terminal without --scope a picker offers the catalog (wx-admin key scopes). --expires: 90m, 12h, 30d, 1y or an',
          'ISO date, from 1 hour to 1 year (default 30d). *:* is full access for development: --yes and 7 days at most.',
          '--user EXT binds the key to a PBX user; else it acts as the admin. Only the root admin may make keys.',
        ].join('\n'),
        options: {
          name: {type: 'string', placeholder: 'NAME', description: 'the name of the key, 3 to 100 characters'},
          scope: {type: 'string', multiple: true, placeholder: 'SCOPE', description: 'a scope (repeatable)'},
          expires: {
            type: 'string',
            placeholder: 'WHEN',
            description: 'a duration (12h, 30d, 1y) or an ISO date; default 30d',
          },
          user: {type: 'string', placeholder: 'EXT', description: 'bind the key to the PBX user with this extension'},
          to: {type: 'string', placeholder: 'FILE', description: 'write the key value to a new file (0600)'},
          login: {type: 'boolean', description: 'make the key the login of this PBX (with --yes)'},
          'show-secrets': {type: 'boolean', description: 'print the key value'},
          yes: {type: 'boolean', description: 'yes: replace the login of the PBX (--login), or make a *:* key'},
        },
        args: [0, 0],
        async run(ctx) {
          const {values} = ctx;
          const now = ctx.clock?.() ?? Date.now();
          const name = values.name?.trim();
          if (!name) throw new UsageError('Give --name', ctx.usage());
          if (name.length < 3 || name.length > 100) throw new UsageError('--name is 3 to 100 characters');
          const places = ['to', 'login', 'show-secrets'].filter((o) => values[o]);
          if (!places.length)
            throw new UsageError(
              'Say where the key goes, it is shown only once: --to FILE, --login or --show-secrets',
              ctx.usage(),
            );
          if (places.length > 1) throw new UsageError('Give only one of --to FILE, --login, --show-secrets');
          if (values.login && !values.yes)
            throw new UsageError(
              '--login replaces the saved login of this PBX: add --yes (a key login cannot manage keys)',
            );
          let scopes = [...new Set(values.scope ?? [])];
          for (const s of scopes)
            if (!SCOPE.test(s)) throw new UsageError(`Not a scope: ${s} (resource:action, e.g. pbx:read)`);
          if (!scopes.length && !terminal(ctx))
            throw new UsageError('Give --scope SCOPE (repeatable): without a terminal there is no picker', ctx.usage());
          const {at, ms} = expiresAt(values.expires ?? '30d', now);
          if (values.user !== undefined && !/^[0-9]{1,64}$/.test(values.user))
            throw new UsageError('--user is the extension: digits only');
          const file = values.to ? checkNewFile(ctx, values.to) : undefined;

          const client = await keysClient(ctx);
          if (!scopes.length) {
            const catalog = (await client.call('GET', '/scopes')).scopes ?? [];
            const chosen = await select(ctx, {
              title: `Scopes of the key ${name} (space: tick, enter: done)`,
              groups: scopeGroups(catalog),
            });
            scopes = [...chosen];
            if (!scopes.length) throw new UsageError('No scope chosen: nothing was made');
          }
          if (scopes.includes('*:*')) {
            if (!values.yes) throw new UsageError('*:* is full access, for development: add --yes');
            if (ms > 7 * DAY) throw new UsageError('A *:* key lasts 7 days at most: --expires 7d');
            ctx.info('*:* is full access: for development only, delete the key when you are done.');
          }
          const created = (
            await client.call('POST', '/api-keys/', {
              json: {name, scopes, expiresAt: at, ...(values.user === undefined ? {} : {userExtension: values.user})},
            })
          ).apiKey;
          const {key: value, ...apiKey} = created;
          const out = {apiKey};
          try {
            if (typeof value !== 'string' || !value) throw new Error('The service made the key but returned no value');
            if (file) out.savedTo = writeNewFile(ctx, values.to, `${value}\n`, {mode: 0o600});
            if (values.login) {
              const old = savedAccess(client.pbxHost, ctx.env);
              saveAccess(
                {
                  host: client.pbxHost,
                  port: client.pbxPort,
                  auth: 'apikey',
                  key: value,
                  ...(old?.serial ? {serial: old.serial} : {}),
                },
                ctx.env,
              );
              out.loginOf = client.pbxHost;
            }
          } catch (e) {
            // Nobody can read this key any more: it is deleted again rather than left behind.
            let again = ' (the key was deleted again)';
            try {
              await client.call('DELETE', byId(created.id));
            } catch {
              again = ` (the key ${created.id} could not be deleted again: wx-admin key delete ${created.id} --yes)`;
            }
            e.message += again;
            throw e;
          }
          if (values['show-secrets']) out.key = value;
          return out;
        },
        text(r) {
          return [
            `Made the key ${r.apiKey.name}  ${r.apiKey.id}`,
            ...keyLines(r.apiKey).slice(1),
            r.savedTo
              ? `The key value is in ${r.savedTo} (0600); it is not shown again.`
              : r.loginOf
                ? `The key is now the login of ${r.loginOf}. It cannot manage keys: wx-admin login ${r.loginOf} --password does.`
                : `Key (shown once): ${r.key}`,
          ];
        },
      },
      rename: {
        summary: 'change the name of a key (nothing else of a key can change)',
        usage: 'wx-admin key rename <id|name> <new name>',
        options: {},
        args: [2, 2],
        async run(ctx) {
          const [ref, name] = ctx.positionals;
          if (name.trim().length < 3 || name.trim().length > 100) throw new UsageError('A name is 3 to 100 characters');
          const client = await keysClient(ctx);
          const {id} = await resolveId(client, ref);
          return client.call('PUT', byId(id), {json: {name: name.trim()}});
        },
        text: (r) => `Renamed: ${r.apiKey.name}  ${r.apiKey.id}`,
      },
      delete: {
        summary: 'delete a key: whatever signs in with it stops working',
        usage: 'wx-admin key delete <id|name> --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete it (it cannot be undone)'}},
        args: [1, 1],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError('Deleting a key stops whatever uses it, for good: add --yes', ctx.usage());
          const client = await keysClient(ctx);
          const {id, name} = await resolveId(client, ctx.positionals[0]);
          await client.call('DELETE', byId(id));
          return {deleted: id, ...(name ? {name} : {})};
        },
        text: (r) => `Deleted the key ${r.name ? `${r.name} ` : ''}${r.deleted}.`,
      },
    },
  },
};
