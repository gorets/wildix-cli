// wx-admin integration: the integrations of the WIM console (its Integrations page) for the company of the PBX,
// with the PBX's CPA token (../integration/api.mjs): webhooks, the iframe apps of x-bees, the settings of the CRM
// connectors, logs and traces, and the integrations hub. An integration is given by id or by its label in the list.
// Installing an OAuth connector (HubSpot, Salesforce, Zoho, Gong, Microsoft 365) needs a browser: the WIM console.
// Operations (https://wim[-stable|-stage].wildix.com):
//   GET, POST, PATCH, DELETE /console/integrations; GET /console/integration-logs;
//   GET /v2/traces/completed, /v2/traces/{traceId}, /v2/traces/{integrationId}/stats;
//   GET, POST, PUT, DELETE /v2/integrations-hub/manage/company; GET, POST /v2/integrations-hub/manage/users,
//   GET, PUT, DELETE /v2/integrations-hub/manage/users/{extension}
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload} from 'wldx-core/files';
import {apiPath} from 'wldx-core/http';
import {localTime, oneLine, table} from 'wldx-core/format';
import {MASK, maskCloud} from '../cloud/mask.mjs';
import {
  consoleCall,
  consoleState,
  EVENTS,
  findIntegration,
  FULL,
  integrationsClient,
  labelOf,
  newSecret,
  ownerOfWebhook,
  SERVICES,
  SHOW_SECRETS,
  shown,
  statusOf,
  WEBHOOK_EVENTS,
} from '../integration/api.mjs';
import {hubCommands} from '../integration/hub.mjs';
import {wholeNumber} from '../wilma/api.mjs';

const CONSOLE = '/console/integrations';
const line = (...parts) => parts.filter((p) => p !== undefined && p !== null && p !== '' && p !== false).join(' · ');
const ms = (n) => (Number.isFinite(n) ? (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`) : '');
const itemLine = (i) => line(`${i.integrationId}  ${i.service}`, statusOf(i), labelOf(i));

// The integration a command works on, with the state of the company it was found in.
async function target(ctx, ref = ctx.positionals[0]) {
  const client = await integrationsClient(ctx);
  const state = await consoleState(client);
  const installed = state.installed ?? [];
  return {client, state, installed, item: findIntegration(installed, ref)};
}

function refuseOwned(client, installed, item, what) {
  const owner = item.service === 'webhook' && ownerOfWebhook(client, installed, item);
  if (owner)
    throw new UsageError(`${item.integrationId} is the webhook of ${owner}: ${what} it would break that integration`);
}

const patch = (client, body) => consoleCall(client, 'PATCH', CONSOLE, {json: body});

// A JSON file, or stdin with "-"; refused when it holds the mask (it would be written over a secret).
async function jsonFrom(ctx, from) {
  let text;
  if (from === '-') {
    const chunks = [];
    for await (const c of ctx.stdin) chunks.push(Buffer.from(c));
    text = Buffer.concat(chunks).toString('utf8');
  } else text = readForUpload(path.resolve(ctx.cwd ?? process.cwd(), from), ctx.env).toString('utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UsageError(`${from} is not JSON`);
  }
  if (text.includes(MASK))
    throw new UsageError(`${from} holds masked values (${MASK}): sending it would write the mask over a secret`);
  return data;
}

// ---- the integrations ------------------------------------------------------------------------------------------

const logLine = (l, full) =>
  line(
    `${localTime(l.createdAt, {seconds: true})}  ${l.eventType}`,
    l.status,
    l.warningCode && `warning ${l.warningCode}`,
    l.errorCode && `error ${l.errorCode}`,
    l.error && oneLine(l.error, 120),
    l.syncMode,
    l.usersCount !== undefined && `${l.usersCount} users`,
    full ? l.email : undefined,
  );

const traceLine = (t) =>
  line(`${localTime(t.start, {seconds: true})}  ${t.status}`, ms(t.duration), t.params?.name ?? t.params?.type, t.id);

const commonCommands = {
  list: {
    summary: 'the integrations of the company: id, service, status, what it connects',
    usage: 'wx-admin integration list [--service S] [--show-secrets] [--full]',
    options: {
      service: {type: 'string', choices: SERVICES, description: 'only integrations of this service'},
      ...SHOW_SECRETS,
      ...FULL,
    },
    args: [0, 0],
    async run(ctx) {
      const state = await consoleState(await integrationsClient(ctx));
      const installed = (state.installed ?? []).filter((i) => !ctx.values.service || i.service === ctx.values.service);
      return {
        license: state.license,
        allowed: state.allowed ?? [],
        integrations: installed.map((i) => shown(ctx, i)),
      };
    },
    text: (r) => (r.integrations.length ? r.integrations.map(itemLine) : 'No integrations'),
  },
  get: {
    summary: 'one integration with its settings (secrets masked, people only with --full)',
    usage: 'wx-admin integration get <integration> [--show-secrets] [--full]',
    options: {...SHOW_SECRETS, ...FULL},
    args: [1, 1],
    async run(ctx) {
      return shown(ctx, (await target(ctx)).item);
    },
    text: (i) => [
      ...table([
        ['Id', i.integrationId],
        ['Service', i.service],
        ['Status', statusOf(i)],
        ['What', labelOf(i)],
        ...(i.warningInfo ? [['Warning', line(i.warningInfo.code, i.warningInfo.error)]] : []),
        ...(i.errorInfo ? [['Error', line(i.errorInfo.code, i.errorInfo.error)]] : []),
      ]),
      '',
      JSON.stringify(i.data ?? {}, null, 2),
    ],
  },
  logs: {
    summary: 'the log of an integration, newest first: 30 entries, or all of them',
    usage: 'wx-admin integration logs <integration> [--all] [--full]',
    options: {all: {type: 'boolean', description: 'every entry, not only the last 30'}, ...FULL},
    args: [1, 1],
    async run(ctx) {
      const {client, item} = await target(ctx);
      const logs = [];
      // 30 a page by offset; the service answers nothing beyond 9500.
      for (let offset = 0; offset <= 9500; offset += 30) {
        const page =
          (
            await consoleCall(client, 'GET', '/console/integration-logs', {
              query: {integrationId: item.integrationId, offset},
            })
          )?.logs ?? [];
        logs.push(...page);
        if (!ctx.values.all || page.length < 30) break;
      }
      const full = ctx.values.full;
      return {
        integrationId: item.integrationId,
        logs: logs.map((l) => (full ? l : Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'email')))),
      };
    },
    text: (r, ctx) => (r.logs.length ? r.logs.map((l) => logLine(l, ctx?.values?.full)) : 'No log entries'),
  },
  enable: {
    summary: 'switch an integration on',
    usage: 'wx-admin integration enable <integration>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const {client, item} = await target(ctx);
      return shown(ctx, await patch(client, {integrationId: item.integrationId, status: 'enabled'}));
    },
    text: (i) => `Enabled ${itemLine(i)}`,
  },
  disable: {
    summary: 'switch an integration off: it stops working until enabled (needs --yes)',
    usage: 'wx-admin integration disable <integration> --yes',
    options: {yes: {type: 'boolean', description: 'yes, switch it off'}},
    args: [1, 1],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError('A disabled integration stops working until enabled: confirm with --yes', ctx.usage());
      const {client, installed, item} = await target(ctx);
      refuseOwned(client, installed, item, 'disabling');
      return shown(ctx, await patch(client, {integrationId: item.integrationId, status: 'disabled'}));
    },
    text: (i) => `Disabled ${itemLine(i)}`,
  },
  delete: {
    summary: 'remove an integration (needs --yes; --force: Salesforce Omni even if its org was not prepared)',
    usage: 'wx-admin integration delete <integration> --yes [--force]',
    options: {
      yes: {type: 'boolean', description: 'yes, remove it'},
      force: {
        type: 'boolean',
        description: 'Salesforce Omni: remove it although the Salesforce org could not be prepared for the uninstall',
      },
    },
    args: [1, 1],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError('Removing an integration cannot be undone: confirm with --yes', ctx.usage());
      const {client, installed, item} = await target(ctx);
      refuseOwned(client, installed, item, 'removing');
      if (ctx.values.force && item.service !== 'salesforce_omni')
        throw new UsageError('--force is for Salesforce Omni only');
      await consoleCall(client, 'DELETE', CONSOLE, {
        query: {integrationId: item.integrationId, ...(ctx.values.force ? {force: 'true'} : {})},
      });
      return {deleted: {integrationId: item.integrationId, service: item.service, label: labelOf(item)}};
    },
    text: (r) => `Removed ${line(`${r.deleted.integrationId}  ${r.deleted.service}`, r.deleted.label)}`,
  },
  settings: {
    summary: 'the settings of a connector (call, chat, conference logging…), or replace them from a file (--yes)',
    usage: 'wx-admin integration settings <integration> [--from FILE|- --yes]',
    details: [
      'Without --from: the settings, as JSON (save them with --output json, change them, send them back).',
      'With --from: the file replaces every setting of the integration.',
    ].join('\n'),
    options: {
      from: {type: 'string', placeholder: 'FILE', description: 'the settings to write, a JSON file or - for stdin'},
      yes: {type: 'boolean', description: 'yes, replace the settings'},
    },
    args: [1, 1],
    async run(ctx) {
      const {client, item} = await target(ctx);
      if (ctx.values.from === undefined) {
        if (item.data?.settings === undefined)
          throw new UsageError(`${item.integrationId} (${item.service}) has no settings`);
        return item.data.settings;
      }
      if (!ctx.values.yes)
        throw new UsageError('--from replaces every setting of the integration: confirm with --yes', ctx.usage());
      const settings = await jsonFrom(ctx, ctx.values.from);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        throw new UsageError(`${ctx.values.from} is not an object of settings`);
      const saved = await patch(client, {integrationId: item.integrationId, data: {settings}});
      return saved?.data?.settings ?? settings;
    },
    text: (s) => JSON.stringify(s, null, 2),
  },
  traces: {
    summary: 'the traces of an integration (what it sent and got), newest first',
    usage: 'wx-admin integration traces <integration> [--status S] [--search TEXT] [--limit N] [--offset N]',
    options: {
      status: {
        type: 'string',
        choices: ['complete', 'complete_with_errors', 'error', 'pending'],
        description: 'only traces with this status',
      },
      search: {type: 'string', placeholder: 'TEXT', description: 'traces that hold this text'},
      limit: {type: 'string', placeholder: 'N', description: 'at most N traces, 1 to 100 (default 20)'},
      offset: {type: 'string', placeholder: 'N', description: 'skip the first N traces'},
    },
    args: [1, 1],
    async run(ctx) {
      const {client, item} = await target(ctx);
      const v = ctx.values;
      const query = {
        integration: item.integrationId,
        limit: wholeNumber(v.limit, 'limit', {max: 100, fallback: 20}),
        offset: wholeNumber(v.offset, 'offset', {min: 0, fallback: 0}),
        ...(v.status ? {status: v.status} : {}),
        ...(v.search ? {search: v.search} : {}),
      };
      const r = await client.call('GET', '/v2/traces/completed', {query});
      return {count: r?.count ?? 0, traces: maskCloud(r?.traces ?? [])};
    },
    text: (r) => [...(r.traces.length ? r.traces.map(traceLine) : ['No traces']), `${r.count} in all`],
  },
  trace: {
    summary: 'one trace with its steps; what each step sent and got only with --full',
    usage: 'wx-admin integration trace <trace-id> [--full] [--show-secrets]',
    options: {...FULL, ...SHOW_SECRETS},
    args: [1, 1],
    async run(ctx) {
      const client = await integrationsClient(ctx);
      const t = (await client.call('GET', apiPath`/v2/traces/${ctx.positionals[0]}`))?.trace ?? {};
      const segments = (t.segments ?? []).map((s) =>
        ctx.values.full ? s : Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'input' && k !== 'result')),
      );
      const out = {...t, segments};
      return ctx.values['show-secrets'] ? out : maskCloud(out);
    },
    text: (t) => {
      const byParent = new Map();
      for (const s of t.segments ?? []) byParent.set(s.parentId ?? '', [...(byParent.get(s.parentId ?? '') ?? []), s]);
      const rows = [];
      const walk = (parent, depth) => {
        for (const s of byParent.get(parent) ?? []) {
          rows.push(`${'  '.repeat(depth)}${line(s.name, s.status, ms(s.duration))}`);
          walk(s.id, depth + 1);
        }
      };
      walk('', 1);
      return [traceLine(t), ...rows];
    },
  },
  stats: {
    summary: 'the traces of an integration per day: complete, with errors, failed',
    usage: 'wx-admin integration stats <integration>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const {client, item} = await target(ctx);
      const r = await client.call('GET', apiPath`/v2/traces/${item.integrationId}/stats`);
      return {integrationId: item.integrationId, statistics: r?.statistics ?? []};
    },
    text: (r) =>
      r.statistics.length
        ? r.statistics.map(
            (d) =>
              `${String(d.date).slice(0, 10)}  ${d.complete ?? 0} complete · ${d.completeWithErrors ?? 0} with errors · ${d.error ?? 0} failed`,
          )
        : 'No traces',
  },
};

// ---- webhooks --------------------------------------------------------------------------------------------------

function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new UsageError(`Not a URL: ${url}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new UsageError(`The URL of a webhook is http(s): ${url}`);
  return url;
}
// Checked here, not as `choices`: the help would print the 54 events at every option.
const EVENT_OPTION = {type: 'string', multiple: true, placeholder: 'EVENT'};
function checkEvents(events = []) {
  const unknown = events.filter((e) => !EVENTS.includes(e));
  if (unknown.length)
    throw new UsageError(
      `Not an event a webhook sends: ${unknown.join(', ')} (the events: wx-admin integration webhook events)`,
    );
  return events;
}
const eventsOf = (i) => (i.data?.events ?? []).map((e) => e.value ?? e);

const webhookCommands = {
  events: {
    summary: 'the events a webhook can send, by group',
    usage: 'wx-admin integration webhook events',
    options: {},
    args: [0, 0],
    run: () => ({groups: WEBHOOK_EVENTS}),
    text: (r) => Object.entries(r.groups).map(([g, events]) => `${g}: ${events.join(' ')}`),
  },
  create: {
    summary: 'a webhook: the URL and its events; the signing secret is made here and printed once',
    usage: 'wx-admin integration webhook create --url URL --event EVENT...',
    options: {
      url: {type: 'string', placeholder: 'URL', description: 'where the events are sent'},
      event: {...EVENT_OPTION, description: 'an event to send (wx-admin integration webhook events)'},
    },
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      if (!v.url) throw new UsageError('Give the URL: --url URL', ctx.usage());
      if (!v.event?.length) throw new UsageError('Give its events: --event EVENT', ctx.usage());
      checkEvents(v.event);
      const secret = newSecret();
      const client = await integrationsClient(ctx);
      const data = {
        type: 'webhook',
        url: checkUrl(v.url),
        key: '',
        secret,
        events: [...new Set(v.event)].map((value) => ({value})),
      };
      const created = await consoleCall(client, 'POST', CONSOLE, {json: {service: 'webhook', data}});
      // The secret is shown once, unmasked: the receiver needs it to check the signatures.
      return {...shown(ctx, created), secret};
    },
    text: (r) => [
      `Created the webhook ${r.integrationId} → ${r.data?.url ?? ''}`,
      `Signing secret (shown once; later: get --show-secrets): ${r.secret}`,
    ],
  },
  update: {
    summary: 'change a webhook: URL, events; --rotate-secret makes a new signing secret (needs --yes)',
    usage:
      'wx-admin integration webhook update <webhook> [--url URL] [--event EVENT]... [--add-event EVENT]... [--remove-event EVENT]... [--rotate-secret --yes]',
    options: {
      url: {type: 'string', placeholder: 'URL', description: 'the new URL'},
      event: {...EVENT_OPTION, description: 'its events (replaces them all)'},
      'add-event': {...EVENT_OPTION, description: 'an event to add'},
      // Any event: a webhook may hold events the console no longer offers.
      'remove-event': {type: 'string', multiple: true, placeholder: 'EVENT', description: 'an event to remove'},
      'rotate-secret': {type: 'boolean', description: 'a new signing secret, printed once'},
      yes: {type: 'boolean', description: 'yes, rotate the secret (the receiver must get the new one)'},
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      if (!v.url && !v.event && !v['add-event'] && !v['remove-event'] && !v['rotate-secret'])
        throw new UsageError('Nothing to change: give --url, --event, --add-event, --remove-event or --rotate-secret');
      if (v.event && (v['add-event'] || v['remove-event']))
        throw new UsageError('--event replaces the events: give it, or --add-event/--remove-event, not both');
      if (v['rotate-secret'] && !v.yes)
        throw new UsageError('A new secret breaks the receiver until it gets it: confirm with --yes', ctx.usage());
      checkEvents(v.event);
      checkEvents(v['add-event']);
      const {client, installed, item} = await target(ctx);
      if (item.service !== 'webhook')
        throw new UsageError(`${item.integrationId} is not a webhook but ${item.service}`);
      refuseOwned(client, installed, item, 'changing');
      if (v['rotate-secret'] && item.data?.type !== 'webhook')
        throw new UsageError('Only an HTTP webhook has a signing secret to rotate');
      // The console merges `data` into what is stored: only the fields that change are sent.
      const data = {};
      if (v.url) data.url = checkUrl(v.url);
      if (v.event || v['add-event'] || v['remove-event']) {
        let events = v.event ? [...v.event] : eventsOf(item);
        events = [...events, ...(v['add-event'] ?? [])].filter((e) => !(v['remove-event'] ?? []).includes(e));
        events = [...new Set(events)];
        if (!events.length) throw new UsageError('A webhook needs at least one event');
        data.events = events.map((value) => ({value}));
      }
      const secret = v['rotate-secret'] ? newSecret() : undefined;
      if (secret) data.secret = secret;
      const saved = await patch(client, {integrationId: item.integrationId, data});
      return {...shown(ctx, saved), ...(secret ? {secret} : {})};
    },
    text: (r) => [
      `Updated the webhook ${r.integrationId} → ${r.data?.url ?? ''} (${(r.data?.events ?? []).length} events)`,
      ...(r.secret ? [`New signing secret (shown once): ${r.secret}`] : []),
    ],
  },
};

// ---- iframe apps -----------------------------------------------------------------------------------------------

// The two places an app shows in x-bees: `info` (the panel next to a conversation) and `tab` (a tab of its own).
const VIEWS = ['info', 'tab'];
const appsOf = (installed) =>
  installed
    .filter((i) => i.service === 'iframe_integration')
    .sort((a, b) => (a.data?.position ?? 0) - (b.data?.position ?? 0));
const appLine = (i) => {
  const d = i.data ?? {};
  const views = VIEWS.filter((k) => d.tabs?.[k]?.enabled).join('+') || 'hidden';
  let host = d.iframeUrl ?? '';
  try {
    host = new URL(d.iframeUrl).host;
  } catch {
    // as it is
  }
  return line(`${d.position ?? 0}. ${d.title} (${i.integrationId})`, d.templateId, views, host);
};

const appOptions = {
  title: {type: 'string', placeholder: 'TITLE', description: 'its title in x-bees'},
  url: {type: 'string', placeholder: 'URL', description: 'the page x-bees opens'},
  description: {type: 'string', placeholder: 'TEXT', description: 'its description'},
  view: {
    type: 'string',
    multiple: true,
    choices: VIEWS,
    placeholder: 'VIEW',
    description: 'where it shows: info (next to a conversation), tab (a tab of its own); default both',
  },
  'pbx-token': {
    type: 'string',
    choices: ['on', 'off'],
    description: 'hand the PBX token to the page (default off)',
  },
  access: {
    type: 'string',
    multiple: true,
    placeholder: 'EMAIL',
    description: 'only these users see it (replaces the list)',
  },
  deny: {
    type: 'string',
    multiple: true,
    placeholder: 'EMAIL',
    description: 'these users do not see it (replaces the list)',
  },
};

// The tabs of an app from its views and the PBX token, over what it has.
function tabsOf(old = {}, views, pbxToken) {
  const base = {
    info: {enabled: true, isMandatoryToUse: false, usePbxToken: false, platforms: 'all', showForColleagues: false},
    tab: {enabled: true, isMandatoryToUse: false, usePbxToken: false, icon: 'chart-crm'},
  };
  const tabs = {info: {...base.info, ...old.info}, tab: {...base.tab, ...old.tab}};
  if (views) for (const k of VIEWS) tabs[k].enabled = views.includes(k);
  if (pbxToken) for (const k of VIEWS) tabs[k].usePbxToken = pbxToken === 'on';
  return tabs;
}

const appCommands = {
  list: {
    summary: 'the iframe apps of x-bees, in their order: title, template, where they show, host',
    usage: 'wx-admin integration app list',
    options: {},
    args: [0, 0],
    async run(ctx) {
      const state = await consoleState(await integrationsClient(ctx));
      return {apps: appsOf(state.installed ?? [])};
    },
    text: (r) => (r.apps.length ? r.apps.map(appLine) : 'No apps'),
  },
  create: {
    summary: 'an iframe app of x-bees: a page shown next to conversations or in a tab (at most 12 apps)',
    usage:
      'wx-admin integration app create --title TITLE --url URL [--description TEXT] [--view info|tab]... [--pbx-token on|off] [--access EMAIL]... [--deny EMAIL]...',
    options: appOptions,
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      if (!v.title || !v.url) throw new UsageError('Give its title and URL: --title TITLE --url URL', ctx.usage());
      const tabs = tabsOf({}, v.view, v['pbx-token']);
      const data = {
        title: v.title,
        iframeUrl: checkUrl(v.url),
        description: v.description ?? '',
        usePbxToken: v['pbx-token'] === 'on',
        isMandatoryToUse: false,
        platforms: 'all',
        accessEmails: v.access ?? [],
        deniedEmails: v.deny ?? [],
        type: 'info_view',
        tabs,
        icon: 'chart-crm',
        position: 0,
        templateId: '',
        isPreparedIntegration: false,
        isNew: true,
      };
      const client = await integrationsClient(ctx);
      return consoleCall(client, 'POST', CONSOLE, {json: {service: 'iframe_integration', data}});
    },
    text: (i) => `Created the app ${i.data?.title} (${i.integrationId})`,
  },
  update: {
    summary: 'change an iframe app: title, URL, description, views, PBX token, who sees it',
    usage:
      'wx-admin integration app update <app> [--title TITLE] [--url URL] [--description TEXT] [--view info|tab]... [--pbx-token on|off] [--access EMAIL]... [--deny EMAIL]...',
    options: appOptions,
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      if (Object.keys(appOptions).every((k) => v[k] === undefined))
        throw new UsageError('Nothing to change', ctx.usage());
      const {client, item} = await target(ctx);
      if (item.service !== 'iframe_integration')
        throw new UsageError(`${item.integrationId} is not an app but ${item.service}`);
      // The service rebuilds the whole app from what it gets: everything it has is sent back, with the changes.
      const {timestamp, ...old} = item.data ?? {};
      const data = {
        ...old,
        ...(v.title !== undefined ? {title: v.title} : {}),
        ...(v.url !== undefined ? {iframeUrl: checkUrl(v.url)} : {}),
        ...(v.description !== undefined ? {description: v.description} : {}),
        ...(v.access ? {accessEmails: v.access} : {}),
        ...(v.deny ? {deniedEmails: v.deny} : {}),
        ...(v['pbx-token'] ? {usePbxToken: v['pbx-token'] === 'on'} : {}),
        tabs: tabsOf(old.tabs, v.view, v['pbx-token']),
        isNew: false,
        integrationId: item.integrationId,
      };
      return consoleCall(client, 'POST', CONSOLE, {json: {service: 'iframe_integration', data}});
    },
    text: (i) => `Updated the app ${i.data?.title ?? ''} (${i.integrationId})`,
  },
  swap: {
    summary: 'swap the places of two iframe apps in x-bees',
    usage: 'wx-admin integration app swap <app> <app>',
    options: {},
    args: [2, 2],
    async run(ctx) {
      const {client, installed, item: a} = await target(ctx, ctx.positionals[0]);
      const b = findIntegration(installed, ctx.positionals[1]);
      for (const x of [a, b])
        if (x.service !== 'iframe_integration')
          throw new UsageError(`${x.integrationId} is not an app but ${x.service}`);
      if (a.integrationId === b.integrationId) throw new UsageError('Give two different apps');
      await consoleCall(client, 'POST', CONSOLE, {
        json: {
          service: 'iframe_integration',
          data: {currentIntegrationId: a.integrationId, targetIntegrationId: b.integrationId},
        },
      });
      return {apps: appsOf((await consoleState(client)).installed ?? [])};
    },
    text: (r) => r.apps.map(appLine),
  },
};

export const groups = {
  integration: {
    summary: 'the integrations of the WIM console: webhooks, x-bees apps, CRM connectors, logs, traces, hub',
    commands: {
      ...commonCommands,
      webhook: {summary: 'webhooks: the events of the company sent to a URL', commands: webhookCommands},
      app: {summary: 'the iframe apps of x-bees (pages next to conversations or in a tab)', commands: appCommands},
      hub: {summary: 'the integrations hub: its company and users', commands: hubCommands},
    },
  },
};
