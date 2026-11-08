// wx-admin kite: Kite, the chat widgets x-bees puts on websites, and the customer messaging channels of the company
// (SMS, WhatsApp, Messenger, RCS) with the PBX's CPA token: where their conversations go (a service, a colleague or a
// bot) and the services they can go to. A widget by id or exact name; a channel by its number or sender id. Routing
// beyond the default target (work hours, actions) is edited as JSON: export or get, change, then --from.
// Operations (xbees-kite, https://api[-stable|-stage].x-bees.com): ListServices; ListWidgets, GetWidget, CreateWidget,
// UpdateWidget, DeleteWidget; ListSmsNumbers, ListSmsConfigurations, GetSmsNumberConfiguration,
// PutSmsNumberConfiguration; the same for WhatsApp, and ListWhatsAppTemplates; ListMessagingSenders,
// GetMessagingSenderConfiguration, PutMessagingSenderConfiguration (messenger, rcs). Bots by name: ListBots of
// xbees-users (/v2/users/bots). Not here: what the visitors of a widget use (calendar, agents, config, preview).
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload} from 'wldx-core/files';
import {apiPath} from 'wldx-core/http';
import {localTime} from 'wldx-core/format';
import {cloudClient} from '../cloud/client.mjs';
import {MASK, maskCloud} from '../cloud/mask.mjs';
import {pickByName} from '../match.mjs';
import {checkNewFile, writeNewFile} from './records.mjs';

const KITE = '/v2/kite';
const kiteClient = (ctx) => cloudClient(ctx, 'kite');
const line = (...parts) => parts.filter((p) => p !== undefined && p !== null && p !== '' && p !== false).join(' · ');
const SHOW = {'show-secrets': {type: 'boolean', description: 'show keys and tokens in the answer (masked otherwise)'}};
const masked = (ctx, data) => (ctx.values['show-secrets'] ? data : maskCloud(data));

// ---- services and targets --------------------------------------------------------------------------------------

export const listServices = async (client) => (await client.call('GET', `${KITE}/services`))?.services ?? [];
const listBots = async (client) => (await client.call('GET', '/v2/users/bots'))?.bots ?? [];

function findService(services, ref) {
  const want = String(ref);
  return (
    services.find((s) => String(s.id) === want || s.uri === want) ??
    pickByName(services, ref, (s) => s.title, 'service', 'wx-admin kite services')
  );
}

const TARGET_HELP = 'service:SERVICE (id, title or uri), agent:EMAIL or bot:BOT (id or name)';

// A target as given: service:…, agent:…, bot:… → {service: {id, uri}} | {agent: {email}} | {bot: {id}}.
async function targetOf(client, spec, cache = {}) {
  const at = String(spec).indexOf(':');
  const kind = at > 0 ? spec.slice(0, at) : '';
  const ref = at > 0 ? spec.slice(at + 1) : '';
  if (!ref || !['service', 'agent', 'bot'].includes(kind)) throw new UsageError(`--target is ${TARGET_HELP}: ${spec}`);
  if (kind === 'agent') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref)) throw new UsageError(`Not an e-mail: ${ref}`);
    return {agent: {email: ref}};
  }
  if (kind === 'service') {
    cache.services ??= await listServices(client);
    const s = findService(cache.services, ref);
    return {service: {id: s.id, uri: s.uri}};
  }
  cache.bots ??= await listBots(client);
  const bot = cache.bots.find((b) => b.id === ref) ?? pickByName(cache.bots, ref, (b) => b.name, 'bot');
  return {bot: {id: bot.id}};
}

// A target for people: the title of a service, the e-mail of a colleague, the name of a bot when known.
function targetText(target, names = {}) {
  if (!target) return 'no target';
  if (target.service)
    return `service ${names.services?.find((s) => s.id === target.service.id)?.title ?? target.service.uri}`;
  if (target.agent) return `agent ${target.agent.email}`;
  if (target.bot) return `bot ${names.bots?.find((b) => b.id === target.bot.id)?.name ?? target.bot.id}`;
  return Object.keys(target)[0] ?? 'no target';
}

// A JSON file, or stdin with "-"; refused when it holds the mask.
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UsageError(`${from} is not a JSON object`);
  if (text.includes(MASK))
    throw new UsageError(`${from} holds masked values (${MASK}): export it again with --show-secrets`);
  return data;
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const servicesCommand = {
  summary: 'the services of the company conversations can go to: id, title, uri, extensions, numbers',
  usage: 'wx-admin kite services [--search TEXT]',
  options: {search: {type: 'string', placeholder: 'TEXT', description: 'services whose title holds this text'}},
  args: [0, 0],
  async run(ctx) {
    const services = await listServices(await kiteClient(ctx));
    const q = ctx.values.search?.toLowerCase();
    return {services: q ? services.filter((s) => String(s.title).toLowerCase().includes(q)) : services};
  },
  text: (r) =>
    r.services.length
      ? r.services.map((s) =>
          line(
            `${s.id}  ${s.title}`,
            s.uri,
            s.extensions?.length ? `${s.extensions.length} extension${s.extensions.length === 1 ? '' : 's'}` : '',
            s.settings?.phoneNumber && `phone ${s.settings.phoneNumber}`,
            s.settings?.messagingNumber && `messaging ${s.settings.messagingNumber}`,
          ),
        )
      : 'No services',
};

// ---- widgets ---------------------------------------------------------------------------------------------------

// What CreateWidget and UpdateWidget take (UpdateWidget replaces the widget with it).
const WIDGET_FIELDS = [
  'name',
  'target',
  'appearance',
  'routes',
  'welcomeMessages',
  'actions',
  'anonymousSessionsEnabled',
  'anonymousSessionsOnly',
  'anonymousSessionsRandomNameEnabled',
  'widgetRestrictions',
  'skipWelcomeScreen',
];
const listWidgets = async (client) => (await client.call('GET', `${KITE}/widgets`))?.widgets ?? [];
const widgetPath = (id) => `${KITE}${apiPath`/widgets/${id}`}`;
async function findWidget(client, ref) {
  const all = await listWidgets(client);
  const w =
    all.find((x) => x.id === String(ref)) ?? pickByName(all, ref, (x) => x.name, 'widget', 'wx-admin kite widget list');
  return (await client.call('GET', widgetPath(w.id)))?.widget ?? w;
}
const access = (w) =>
  w.anonymousSessionsOnly ? 'anonymous only' : w.anonymousSessionsEnabled ? 'anonymous allowed' : 'signed-in guests';
const widgetLine = (w) =>
  line(
    `${w.name} (${w.id})`,
    w.targetText ?? targetText(w.target),
    access(w),
    w.routes?.length ? `${w.routes.length} routes` : '',
    `updated ${localTime(w.updatedAt ?? w.createdAt)}`,
  );
async function namesOf(client) {
  const [services, bots] = await Promise.all([listServices(client), listBots(client).catch(() => [])]);
  return {services, bots};
}

const ANON = {
  type: 'string',
  choices: ['off', 'allowed', 'only'],
  description: 'anonymous visitors: off (signed-in guests only), allowed, only',
};
const anonFields = (v) =>
  v === undefined ? {} : {anonymousSessionsEnabled: v !== 'off', anonymousSessionsOnly: v === 'only'};

const widgetCommands = {
  list: {
    summary: 'the Kite widgets: name, where conversations go, who may chat, last change',
    usage: 'wx-admin kite widget list',
    options: {},
    args: [0, 0],
    async run(ctx) {
      const client = await kiteClient(ctx);
      const [widgets, names] = await Promise.all([listWidgets(client), namesOf(client)]);
      return {widgets: widgets.map((w) => ({...w, targetText: targetText(w.target, names)}))};
    },
    text: (r) => (r.widgets.length ? r.widgets.map(widgetLine) : 'No widgets'),
  },
  get: {
    summary: 'one widget with its routing, appearance and welcome messages',
    usage: 'wx-admin kite widget get <widget> [--show-secrets]',
    options: {...SHOW},
    args: [1, 1],
    async run(ctx) {
      const client = await kiteClient(ctx);
      const w = await findWidget(client, ctx.positionals[0]);
      return {...masked(ctx, w), targetText: targetText(w.target, await namesOf(client))};
    },
    text: (w) => [
      `${w.name} (${w.id}) · ${w.targetText} · ${access(w)}`,
      '',
      JSON.stringify(pick(w, WIDGET_FIELDS), null, 2),
    ],
  },
  export: {
    summary: 'a widget as JSON that create --from and update --from take (to stdout, or to a new file)',
    usage: 'wx-admin kite widget export <widget> [--to FILE] [--show-secrets]',
    options: {to: {type: 'string', placeholder: 'FILE', description: 'write it to this new file'}, ...SHOW},
    args: [1, 1],
    async run(ctx) {
      if (ctx.values.to) checkNewFile(ctx, ctx.values.to);
      const w = await findWidget(await kiteClient(ctx), ctx.positionals[0]);
      const out = masked(ctx, {id: w.id, ...pick(w, WIDGET_FIELDS)});
      if (!ctx.values.to) return out;
      return {file: writeNewFile(ctx, ctx.values.to, `${JSON.stringify(out, null, 2)}\n`), id: w.id, name: w.name};
    },
    text: (r) => (r.file ? `Wrote the widget ${r.name} (${r.id}) to ${r.file}` : JSON.stringify(r, null, 2)),
  },
  create: {
    summary: 'a widget: its name and where conversations go, or everything from an export',
    usage: 'wx-admin kite widget create (--name NAME --target TARGET [--anonymous off|allowed|only] | --from FILE|-)',
    options: {
      name: {type: 'string', placeholder: 'NAME', description: 'the name of the widget'},
      target: {type: 'string', placeholder: 'TARGET', description: `where conversations go: ${TARGET_HELP}`},
      anonymous: ANON,
      from: {type: 'string', placeholder: 'FILE', description: 'the widget from an export, a JSON file or - for stdin'},
    },
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      const client = await kiteClient(ctx);
      let body;
      if (v.from !== undefined) body = pick(await jsonFrom(ctx, v.from), WIDGET_FIELDS);
      else {
        if (!v.name || !v.target) throw new UsageError('Give --name and --target, or --from FILE', ctx.usage());
        body = {name: v.name, target: await targetOf(client, v.target)};
      }
      if (v.from !== undefined && v.name) body.name = v.name;
      Object.assign(body, anonFields(v.anonymous));
      if (!body.name || !body.target) throw new UsageError('A widget needs a name and a target');
      return (await client.call('POST', `${KITE}/widgets`, {json: body}))?.widget ?? body;
    },
    text: (w) => `Created the widget ${w.name}${w.id ? ` (${w.id})` : ''}`,
  },
  update: {
    summary: 'change a widget: name, target, anonymous visitors, or everything from an export',
    usage:
      'wx-admin kite widget update <widget> [--name NAME] [--target TARGET] [--anonymous off|allowed|only] [--from FILE|-]',
    options: {
      name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
      target: {type: 'string', placeholder: 'TARGET', description: `where conversations go: ${TARGET_HELP}`},
      anonymous: ANON,
      from: {type: 'string', placeholder: 'FILE', description: 'the widget from its export (replaces it)'},
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      if (v.name === undefined && v.target === undefined && v.anonymous === undefined && v.from === undefined)
        throw new UsageError('Nothing to change', ctx.usage());
      const client = await kiteClient(ctx);
      const w = await findWidget(client, ctx.positionals[0]);
      // UpdateWidget replaces the widget: what it has is sent back with the changes.
      let body = pick(w, WIDGET_FIELDS);
      if (v.from !== undefined) {
        const file = await jsonFrom(ctx, v.from);
        if (file.id && file.id !== w.id)
          throw new UsageError(`${v.from} is the export of the widget ${file.id}, not of ${w.name} (${w.id})`);
        body = pick(file, WIDGET_FIELDS);
      }
      if (v.name !== undefined) body.name = v.name;
      if (v.target !== undefined) body.target = await targetOf(client, v.target);
      Object.assign(body, anonFields(v.anonymous));
      return (await client.call('PUT', widgetPath(w.id), {json: body}))?.widget ?? {...w, ...body};
    },
    text: (w) => `Updated the widget ${w.name} (${w.id})`,
  },
  delete: {
    summary: 'delete widgets: on the websites that embed them they stop working (needs --yes)',
    usage: 'wx-admin kite widget delete <widget>... --yes',
    options: {yes: {type: 'boolean', description: 'yes, delete them'}},
    args: [1, 50],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError(
          'A deleted widget stops working on the websites that embed it: confirm with --yes',
          ctx.usage(),
        );
      const client = await kiteClient(ctx);
      const all = await listWidgets(client);
      const found = ctx.positionals.map(
        (ref) =>
          all.find((x) => x.id === String(ref)) ??
          pickByName(all, ref, (x) => x.name, 'widget', 'wx-admin kite widget list'),
      );
      for (const w of found) await client.call('DELETE', widgetPath(w.id));
      return {deleted: found.map(({id, name}) => ({id, name}))};
    },
    text: (r) => `Deleted ${r.deleted.map((w) => `${w.name} (${w.id})`).join(', ')}`,
  },
};

// ---- messaging channels ----------------------------------------------------------------------------------------

// What a Put…Configuration takes: the service conversations are linked to, the default target, the routes (work
// hours) and the actions.
const CHANNEL_FIELDS = ['serviceUri', 'target', 'routes', 'actions'];

// One kind of channel: SMS and WhatsApp by service number, Messenger and RCS by sender id.
function channelCommands(kind) {
  const {name, label, noun, list, configs, item, idOf, nameOf} = kind;
  const notFound = (e) => e?.status === 404;
  async function config(client, id) {
    try {
      return (await client.call('GET', item(id)))?.configuration ?? null;
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }
  const head = (r) =>
    line(
      `${r.id}${r.name && r.name !== r.id ? ` (${r.name})` : ''}`,
      r.service ? `service ${r.service.title}` : 'no linked service',
      r.configuration ? `→ ${r.targetText}` : 'not configured',
      r.configuration?.routes?.length ? `${r.configuration.routes.length} routes` : '',
    );
  const commands = {
    list: {
      summary: `the ${label} ${noun}s of the company: linked service, where conversations go`,
      usage: `wx-admin kite ${name} list`,
      options: {},
      args: [0, 0],
      async run(ctx) {
        const client = await kiteClient(ctx);
        const [items, cfgs, names] = await Promise.all([list(client), configs(client), namesOf(client)]);
        const byId = new Map(cfgs.map((c) => [idOf(c), c]));
        return {
          [`${noun}s`]: items.map((x) => {
            const configuration = byId.get(idOf(x)) ?? null;
            return {
              id: idOf(x),
              name: nameOf(x),
              service: x.service ?? null,
              configuration,
              targetText: configuration ? targetText(configuration.target, names) : null,
            };
          }),
        };
      },
      text: (r) => {
        const rows = r[`${noun}s`];
        return rows.length ? rows.map(head) : `No ${label} ${noun}s`;
      },
    },
    get: {
      summary: `the configuration of one ${label} ${noun}: service, target, routes, actions`,
      usage: `wx-admin kite ${name} get <${noun}>`,
      options: {...SHOW},
      args: [1, 1],
      async run(ctx) {
        const client = await kiteClient(ctx);
        const c = await config(client, ctx.positionals[0]);
        if (!c)
          throw new UsageError(
            `The ${label} ${noun} ${ctx.positionals[0]} is not configured (wx-admin kite ${name} set)`,
          );
        return {...masked(ctx, c), targetText: targetText(c.target, await namesOf(client))};
      },
      text: (c) => [
        `${idOf(c)} → ${c.targetText} · service ${c.serviceUri}`,
        '',
        JSON.stringify(pick(c, CHANNEL_FIELDS), null, 2),
      ],
    },
    set: {
      summary: `where the conversations of a ${label} ${noun} go (its work-hours routes stay), or all of it from a file (--yes)`,
      usage: `wx-admin kite ${name} set <${noun}> (--target TARGET [--service SERVICE] | --from FILE|- --yes)`,
      details: [
        `--target is the default target: ${TARGET_HELP}.`,
        '--service is the service conversations are linked to (default: the target service, the one set, or the one of the number).',
        `--from replaces the whole configuration (serviceUri, target, routes, actions): wx-admin kite ${name} get <${noun}> --output json.`,
      ].join('\n'),
      options: {
        target: {type: 'string', placeholder: 'TARGET', description: 'where conversations go when no route matches'},
        service: {type: 'string', placeholder: 'SERVICE', description: 'the service conversations are linked to'},
        from: {type: 'string', placeholder: 'FILE', description: 'the whole configuration, a JSON file or - for stdin'},
        yes: {type: 'boolean', description: 'yes, replace the whole configuration'},
      },
      args: [1, 1],
      async run(ctx) {
        const v = ctx.values;
        const id = ctx.positionals[0];
        if (v.from === undefined && v.target === undefined && v.service === undefined)
          throw new UsageError('Give --target (and --service), or --from FILE', ctx.usage());
        if (v.from !== undefined && (v.target !== undefined || v.service !== undefined))
          throw new UsageError('--from holds the whole configuration: give it alone');
        if (v.from !== undefined && !v.yes)
          throw new UsageError('--from replaces the whole configuration: confirm with --yes', ctx.usage());
        const client = await kiteClient(ctx);
        const cache = {};
        let body;
        if (v.from !== undefined) body = pick(await jsonFrom(ctx, v.from), CHANNEL_FIELDS);
        else {
          const old = await config(client, id);
          body = old ? pick(old, CHANNEL_FIELDS) : {};
          if (v.target !== undefined) body.target = await targetOf(client, v.target, cache);
          if (v.service !== undefined) {
            cache.services ??= await listServices(client);
            body.serviceUri = findService(cache.services, v.service).uri;
          } else if (!body.serviceUri) {
            cache.services ??= await listServices(client);
            const own = kind.serviceOfNumber?.(cache.services, id);
            body.serviceUri = body.target?.service?.uri ?? own?.uri;
          }
        }
        if (!body.target) throw new UsageError('A configuration needs a target: --target');
        if (!body.serviceUri)
          throw new UsageError(
            `Which service are the conversations linked to? --service SERVICE (wx-admin kite services)`,
          );
        await client.call('PUT', item(id), {json: body});
        return {id, ...body};
      },
      text: (r) => `Set ${r.id} → ${targetText(r.target)} · service ${r.serviceUri}`,
    },
  };
  return commands;
}

const byNumber = (base) => ({
  list: async (client) => (await client.call('GET', `${KITE}/${base}/numbers`))?.numbers ?? [],
  configs: async (client) => (await client.call('GET', `${KITE}/${base}/configurations`))?.configurations ?? [],
  item: (n) => `${KITE}/${base}${apiPath`/configurations/${n}`}`,
  idOf: (x) => x.number ?? x.serviceNumber,
  nameOf: () => '',
  noun: 'number',
  // A number with no configuration is linked to the service that has it as its messaging number (as the console does).
  serviceOfNumber: (services, n) => services.find((s) => s.settings?.messagingNumber === n),
});
const bySender = (channel) => ({
  list: async (client) => (await client.call('GET', `${KITE}${apiPath`/messaging/${channel}/senders`}`))?.senders ?? [],
  // No list of configurations: each sender's is read.
  configs: async (client) => {
    const senders = (await client.call('GET', `${KITE}${apiPath`/messaging/${channel}/senders`}`))?.senders ?? [];
    const out = [];
    for (const s of senders) {
      try {
        const c = (
          await client.call('GET', `${KITE}${apiPath`/messaging/${channel}/senders/${s.senderId}/configuration`}`)
        )?.configuration;
        if (c) out.push(c);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return out;
  },
  item: (id) => `${KITE}${apiPath`/messaging/${channel}/senders/${id}/configuration`}`,
  idOf: (x) => x.senderId,
  nameOf: (x) => x.name || '',
  noun: 'sender',
});

const whatsappTemplates = {
  summary: 'the message templates a WhatsApp number may start a conversation with',
  usage: 'wx-admin kite whatsapp templates <number>',
  options: {},
  args: [1, 1],
  async run(ctx) {
    const client = await kiteClient(ctx);
    const n = ctx.positionals[0];
    // An unknown number makes the service fail (500): the numbers of the company first.
    const numbers = (await client.call('GET', `${KITE}/whatsapp/numbers`))?.numbers ?? [];
    if (!numbers.some((x) => x.number === n))
      throw new UsageError(`${n} is not a WhatsApp number of the company (wx-admin kite whatsapp list)`);
    const r = await client.call('GET', `${KITE}/whatsapp${apiPath`/templates/${n}`}`);
    return {templates: r?.templates ?? []};
  },
  text: (r) =>
    r.templates.length
      ? r.templates.map((t) => line(t.name ?? t.id, t.language, t.category, t.status))
      : 'No templates',
};

export const groups = {
  kite: {
    summary: 'Kite chat widgets and the messaging channels (SMS, WhatsApp, Messenger, RCS): where conversations go',
    commands: {
      services: servicesCommand,
      widget: {summary: 'the chat widgets of websites', commands: widgetCommands},
      sms: {summary: 'the SMS numbers', commands: channelCommands({name: 'sms', label: 'SMS', ...byNumber('sms')})},
      whatsapp: {
        summary: 'the WhatsApp numbers and their templates',
        commands: {
          ...channelCommands({name: 'whatsapp', label: 'WhatsApp', ...byNumber('whatsapp')}),
          templates: whatsappTemplates,
        },
      },
      messenger: {
        summary: 'the Facebook pages of Messenger',
        commands: channelCommands({name: 'messenger', label: 'Messenger', ...bySender('messenger')}),
      },
      rcs: {summary: 'the RCS brands', commands: channelCommands({name: 'rcs', label: 'RCS', ...bySender('rcs')})},
    },
  },
};
