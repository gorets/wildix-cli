// wx-admin integration hub: the integrations hub of WIM for the company of the PBX (the Red Cactus integration of
// the CRMs): its company and its users. The hub gets the events of the company by a webhook to
// <WIM host>/v2/integrations-hub/events/wildix: as the WIM console does, `company-set` makes it when it is missing
// (also a repair) and `company-delete` removes it. A user of the hub is a Red Cactus user: creating an active one takes a
// license, deleting the company frees them all. A password is typed hidden or piped, never an option, never shown.
// Operations (wim-integrations-hub, https://wim[-stable|-stage].wildix.com): GetCompany, CreateCompany,
// UpdateCompany, DeleteCompany (/v2/integrations-hub/manage/company); ListUsers, CreateUser, GetUser, UpdateUser,
// DeleteUser (/v2/integrations-hub/manage/users[/{extension}]).
import {jwtClaims} from 'wldx-core/auth';
import {UsageError} from 'wldx-core/errors';
import {apiPath} from 'wldx-core/http';
import {localTime, table} from 'wldx-core/format';
import {readSecret} from 'wldx-core/secret';
import {cloudToken} from '../cloud/token.mjs';
import {
  consoleCall,
  consoleState,
  HUB_WEBHOOK_EVENTS,
  hubWebhookOf,
  hubWebhookUrl,
  integrationsClient,
  newSecret,
} from './api.mjs';

const COMPANY = '/v2/integrations-hub/manage/company';
const USERS = '/v2/integrations-hub/manage/users';
const userPath = (ext) => `${USERS}${apiPath`/${ext}`}`;
const onOff = (description) => ({type: 'string', choices: ['on', 'off'], description});
const client = (ctx) => integrationsClient(ctx);
const bool = (v, fallback) => (v === undefined ? fallback : v === 'on');

// The webhook of the hub: made when missing, with the events the WIM console gives it; {integrationId, created}.
async function ensureHubWebhook(c) {
  const found = hubWebhookOf(c, (await consoleState(c)).installed ?? []);
  if (found) return {integrationId: found.integrationId, created: false};
  const data = {
    type: 'webhook',
    url: hubWebhookUrl(c),
    key: '',
    secret: newSecret(),
    events: HUB_WEBHOOK_EVENTS.map((value) => ({value})),
  };
  const made = await consoleCall(c, 'POST', '/console/integrations', {json: {service: 'webhook', data}});
  return {integrationId: made?.integrationId, created: true};
}

async function companyOrNull(client) {
  try {
    return await client.call('GET', COMPANY);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

const companyRows = (c) =>
  table([
    ['Company', c.companyId],
    ['Red Cactus customer', c.customerId],
    ['Active', c.active ? 'yes' : 'no'],
    ['Trial', c.isTrial ? 'yes' : 'no'],
    ['Call summary to CRMs', c.sendCallSummary ? 'yes' : 'no'],
    ['Address', [c.address, c.postalCode, c.city, c.countryCode].filter(Boolean).join(', ')],
    ['Time zone', c.timezone],
    ['Updated', localTime(c.updatedAt)],
  ]);

const COMPANY_FIELDS = {
  address: {type: 'string', placeholder: 'TEXT', description: 'the address (default: the name of the company)'},
  'postal-code': {type: 'string', placeholder: 'CODE', description: 'the postal code'},
  city: {type: 'string', placeholder: 'CITY', description: 'the city'},
  country: {type: 'string', placeholder: 'CC', description: 'the country, ISO 3166 code: FR, US, DE…'},
  timezone: {type: 'string', placeholder: 'TZ', description: 'the IANA time zone: Europe/Paris, UTC…'},
  active: onOff('the company is active (default on)'),
  'call-summary': onOff('send the summary of calls to the CRMs (default off)'),
};

const companyCommands = {
  get: {
    summary: 'the company of the hub: Red Cactus customer, address, time zone, call summary',
    usage: 'wx-admin integration hub company',
    options: {},
    args: [0, 0],
    async run(ctx) {
      const c = await companyOrNull(await client(ctx));
      if (!c)
        throw new UsageError('The company is not in the integrations hub: wx-admin integration hub company-set …');
      return c;
    },
    text: companyRows,
  },
  set: {
    summary:
      'put the company into the hub or change it (putting it in needs --yes); makes the webhook of the hub if missing',
    usage:
      'wx-admin integration hub company-set [--postal-code CODE] [--city CITY] [--country CC] [--timezone TZ] [--address TEXT] [--active on|off] [--call-summary on|off] [--yes]',
    options: {...COMPANY_FIELDS, yes: {type: 'boolean', description: 'yes, put the company into the hub'}},
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      const c = await client(ctx);
      const old = await companyOrNull(c);
      const address = v.address ?? old?.address;
      const body = {
        ...(address ? {address} : {}),
        postalCode: v['postal-code'] ?? old?.postalCode,
        city: v.city ?? old?.city,
        countryCode: v.country?.toUpperCase() ?? old?.countryCode,
        timezone: v.timezone ?? old?.timezone,
        active: bool(v.active, old?.active ?? true),
        sendCallSummary: bool(v['call-summary'], old?.sendCallSummary ?? false),
      };
      if (old) return {...(await c.call('PUT', COMPANY, {json: body})), webhook: await ensureHubWebhook(c)};
      const missing = [
        ['postal-code', body.postalCode],
        ['city', body.city],
        ['country', body.countryCode],
        ['timezone', body.timezone],
      ].filter(([, x]) => !x);
      if (missing.length)
        throw new UsageError(`To put the company into the hub give ${missing.map(([k]) => `--${k}`).join(', ')}`);
      if (!v.yes)
        throw new UsageError(
          'Putting the company into the hub makes it a Red Cactus customer: confirm with --yes',
          ctx.usage(),
        );
      return {...(await c.call('POST', COMPANY, {json: body})), webhook: await ensureHubWebhook(c)};
    },
    text: (r) => [
      ...companyRows(r),
      r.webhook?.created
        ? `Made the webhook of the hub: ${r.webhook.integrationId}`
        : `The webhook of the hub: ${r.webhook?.integrationId}`,
    ],
  },
  delete: {
    summary: 'take the company out of the hub: its users, their licenses and its webhook go too (needs --yes)',
    usage: 'wx-admin integration hub company-delete --yes',
    options: {yes: {type: 'boolean', description: 'yes, take it out'}},
    args: [0, 0],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError(
          'Taking the company out of the hub deletes its users and frees their licenses: confirm with --yes',
          ctx.usage(),
        );
      const c = await client(ctx);
      const r = await c.call('DELETE', COMPANY);
      const hook = hubWebhookOf(c, (await consoleState(c)).installed ?? []);
      if (hook) await consoleCall(c, 'DELETE', '/console/integrations', {query: {integrationId: hook.integrationId}});
      return {message: r?.message, webhookRemoved: hook?.integrationId ?? null};
    },
    text: (r) => [
      r.message ?? 'The company is out of the integrations hub',
      ...(r.webhookRemoved ? [`Removed the webhook of the hub: ${r.webhookRemoved}`] : []),
    ],
  },
};

const userLine = (u) =>
  [
    `${u.extension}  ${u.firstName} ${u.lastName}`,
    u.email,
    u.active ? 'active' : 'inactive',
    u.isAdmin ? 'admin' : '',
    u.online ? 'online' : u.lastSeen ? `seen ${localTime(u.lastSeen)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

const USER_FIELDS = {
  'first-name': {type: 'string', placeholder: 'NAME', description: 'the first name'},
  'last-name': {type: 'string', placeholder: 'NAME', description: 'the last name'},
  email: {type: 'string', placeholder: 'EMAIL', description: 'the e-mail (one user per e-mail)'},
  'pbx-serial': {type: 'string', placeholder: 'SERIAL', description: 'the PBX of the extension (default: this PBX)'},
  password: {type: 'boolean', description: 'set a password: typed hidden, or the first line of stdin'},
};

// What a user's write sends; the password only when asked for (the service never gives it back).
async function password(ctx) {
  const value = await readSecret(ctx, 'The password of the user (hidden): ');
  const length = [...(value ?? '')].length;
  if (length < 8 || length > 40) throw new UsageError('A password of the hub has 8 to 40 characters');
  // The rules of the WIM console: Red Cactus refuses a weaker password with an error 500.
  const rules = [
    [/\p{Lu}/u, 'an uppercase letter'],
    [/\p{Ll}/u, 'a lowercase letter'],
    [/\p{N}/u, 'a digit'],
    [/[\p{P}\p{S}]/u, 'a symbol'],
  ];
  const missing = rules.filter(([re]) => !re.test(value)).map(([, what]) => what);
  if (missing.length) throw new UsageError(`A password of the hub needs ${missing.join(', ')}`);
  return value;
}

const userCommands = {
  list: {
    summary: 'the users of the hub: extension, name, e-mail, active, admin, online',
    usage: 'wx-admin integration hub user-list',
    options: {},
    args: [0, 0],
    async run(ctx) {
      const c = await client(ctx);
      const users = [];
      let start;
      for (let page = 0; page < 50; page++) {
        const r = await c.call('GET', USERS, {query: {count: 100, ...(start ? {start} : {})}});
        users.push(...(r?.users ?? []));
        start = r?.nextPage;
        if (!start) break;
      }
      return {users};
    },
    text: (r) => (r.users.length ? r.users.map(userLine) : 'No users'),
  },
  get: {
    summary: 'one user of the hub by extension',
    usage: 'wx-admin integration hub user-get <extension>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      return (await client(ctx)).call('GET', userPath(ctx.positionals[0]));
    },
    text: userLine,
  },
  create: {
    summary: 'a user of the hub for an extension; an active one takes a Red Cactus license (needs --yes)',
    usage:
      'wx-admin integration hub user-create <extension> --first-name NAME --last-name NAME --email EMAIL [--pbx-serial SERIAL] [--password] [--inactive] [--welcome] --yes',
    options: {
      ...USER_FIELDS,
      inactive: {type: 'boolean', description: 'create it inactive (no license taken)'},
      welcome: {type: 'boolean', description: 'send the welcome e-mail'},
      yes: {type: 'boolean', description: 'yes, create it'},
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      const missing = ['first-name', 'last-name', 'email'].filter((k) => !v[k]);
      if (missing.length) throw new UsageError(`Give ${missing.map((k) => `--${k}`).join(', ')}`, ctx.usage());
      if (!v.yes)
        throw new UsageError(
          `Creating a user of the hub ${v.inactive ? 'makes a Red Cactus user' : 'takes a Red Cactus license'}: confirm with --yes`,
          ctx.usage(),
        );
      const c = await client(ctx);
      const body = {
        firstName: v['first-name'],
        lastName: v['last-name'],
        email: v.email,
        extension: ctx.positionals[0],
        pbxSerial: v['pbx-serial'] ?? jwtClaims((await cloudToken(ctx)).token)['cognito:username'],
        active: !v.inactive,
        ...(v.password ? {password: await password(ctx)} : {}),
      };
      return c.call('POST', USERS, {json: body, query: v.welcome ? {sendWelcomeEmail: 'true'} : undefined});
    },
    text: (u) => `Created ${userLine(u)}`,
  },
  update: {
    summary: 'change a user of the hub: name, e-mail, PBX, active, admin, password',
    usage:
      'wx-admin integration hub user-update <extension> [--first-name NAME] [--last-name NAME] [--email EMAIL] [--pbx-serial SERIAL] [--active on|off] [--admin on|off] [--password]',
    options: {
      ...USER_FIELDS,
      active: onOff('the user is active (on takes a license)'),
      admin: onOff('the user has the admin role of Red Cactus'),
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      if (Object.keys({...USER_FIELDS, active: 1, admin: 1}).every((k) => v[k] === undefined))
        throw new UsageError('Nothing to change', ctx.usage());
      const c = await client(ctx);
      const old = await c.call('GET', userPath(ctx.positionals[0]));
      const body = {
        firstName: v['first-name'] ?? old.firstName,
        lastName: v['last-name'] ?? old.lastName,
        email: v.email ?? old.email,
        pbxSerial: v['pbx-serial'] ?? old.pbxSerial,
        active: bool(v.active, old.active),
        isAdmin: bool(v.admin, old.isAdmin),
        ...(v.password ? {password: await password(ctx)} : {}),
      };
      return c.call('PUT', userPath(ctx.positionals[0]), {json: body});
    },
    text: (u) => `Updated ${userLine(u)}`,
  },
  delete: {
    summary: 'delete users of the hub: their Red Cactus users and licenses go too (needs --yes)',
    usage: 'wx-admin integration hub user-delete <extension>... --yes',
    options: {yes: {type: 'boolean', description: 'yes, delete them'}},
    args: [1, 50],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError('Deleting a user of the hub cannot be undone: confirm with --yes', ctx.usage());
      const c = await client(ctx);
      // Every user first: one that is missing stops the command before anything is deleted.
      for (const ext of ctx.positionals) await c.call('GET', userPath(ext));
      for (const ext of ctx.positionals) await c.call('DELETE', userPath(ext));
      return {deleted: ctx.positionals};
    },
    text: (r) => `Deleted the users ${r.deleted.join(', ')}`,
  },
};

// Flat (the router takes three levels): `wx-admin integration hub company-set`, `… hub user-list`.
export const hubCommands = {
  company: companyCommands.get,
  'company-set': companyCommands.set,
  'company-delete': companyCommands.delete,
  ...Object.fromEntries(Object.entries(userCommands).map(([k, c]) => [`user-${k}`, c])),
};
