// Kite in the config transfer: the chat widgets and the configurations of the messaging channels (SMS, WhatsApp,
// Messenger, RCS). Paths and fields as `wx-admin kite` uses them (src/commands/kite.mjs). A widget is known by its
// name and written whole (UpdateWidget replaces it). A channel is a number or a sender the company owns,
// `sms:<number>`, `whatsapp:<number>`, `messenger:<sender id>`, `rcs:<sender id>`: only its configuration travels
// (PUT), to a number or sender the target owns (another one: --map).
//
// Where conversations go (a target, the target of a work-hours route, the task of an action) points at the company:
// a service (the x-bees service of a call group) becomes {$ref: 'xbees-services/<title>', as: 'object'} (the
// target's {id, uri}), a colleague's e-mail and a task's users xbees-users, a bot xbees-bots by name. The service a
// channel's conversations are linked to (serviceUri, "<id>@<pbx host>:<port>") is that service too.
import {CHANNEL_FIELDS, CHANNELS, listWidgets, WIDGET_FIELDS, widgetPath} from '../../commands/kite.mjs';
import {StageError} from '../stage-error.mjs';
import {stageFailure} from './versioned.mjs';

const PLAIN = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isRef = (v) => PLAIN(v) && typeof v.$ref === 'string';
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
// The fields of a widget or a configuration that say where conversations go.
const ROUTING = ['target', 'routes', 'actions'];

const serviceRef = (id, path, h) => {
  const r = h.ref(String(id), 'xbees-services', path, ['id']);
  return isRef(r) ? {$ref: r.$ref, as: 'object'} : undefined;
};
const userByEmail = (email, path, h) => {
  const r = h.ref(email.toLowerCase(), 'xbees-users', path, ['name']);
  return isRef(r) ? r : email;
};

// What points at the company, by the field that holds it, wherever it is in the routing (targets, routes, the tasks
// of actions): a field of these names holding the shape below is a reference; anything else is walked.
const FIELDS = {
  service(holder, v, at, h) {
    if (PLAIN(v) && v.id !== undefined && v.id !== null) holder.service = serviceRef(v.id, `${at}.id`, h) ?? v;
  },
  agent(holder, v, at, h) {
    if (PLAIN(v) && typeof v.email === 'string') v.email = userByEmail(v.email, `${at}.email`, h);
  },
  bot(holder, v, at, h) {
    if (PLAIN(v) && typeof v.id === 'string') v.id = h.ref(v.id, 'xbees-bots', `${at}.id`, ['id']);
  },
  botId(holder, v, at, h) {
    if (typeof v === 'string') holder.botId = h.ref(v, 'xbees-bots', at, ['id']);
  },
  userId(holder, v, at, h) {
    if (typeof v === 'string') holder.userId = h.ref(v, 'xbees-users', at, ['id']);
  },
  emails(holder, v, at, h) {
    if (Array.isArray(v))
      holder.emails = v.map((e, i) => (typeof e === 'string' ? userByEmail(e, `${at}[${i}]`, h) : e));
  },
  // A conversation of the source company: kept as it is, noted.
  channelId(holder, v, at, h) {
    if (typeof v === 'string') holder.channelId = h.external(at, 'x-bees conversation', v);
  },
};
function routingRefs(value, at, h) {
  if (Array.isArray(value)) for (const [i, v] of value.entries()) routingRefs(v, `${at}[${i}]`, h);
  if (!PLAIN(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const where = at ? `${at}.${k}` : k;
    if (Object.hasOwn(FIELDS, k)) FIELDS[k](value, v, where, h);
    else routingRefs(v, where, h);
  }
}
const portableRouting = (data, h) => {
  for (const k of ROUTING) if (data[k] !== undefined) routingRefs(data[k], k, h);
};

// What the routing points at (FIELDS): the `refers` of widgets and channels.
const ROUTING_REFERS = ['xbees-services', 'xbees-users', 'xbees-bots'];

// The users the routing names: by id (what the source reads of xbees-users) and by e-mail.
function usersOf(value, out = {ids: new Set(), emails: new Set()}) {
  if (Array.isArray(value)) for (const v of value) usersOf(v, out);
  else if (PLAIN(value))
    for (const [k, v] of Object.entries(value)) {
      if (k === 'userId' && typeof v === 'string') out.ids.add(v);
      else if (k === 'agent' && typeof v?.email === 'string') out.emails.add(v.email.toLowerCase());
      else if (k === 'emails' && Array.isArray(v)) {
        for (const e of v) if (typeof e === 'string') out.emails.add(e.toLowerCase());
      } else usersOf(v, out);
    }
  return out;
}
const userIds = (data) => [...usersOf(pick(data, ROUTING)).ids];
const userEmails = (data) => [...usersOf(pick(data, ROUTING)).emails];

// A configuration's service: the target's uri ({id, uri} once resolved).
const uriOf = (v) => (PLAIN(v) ? v.uri : v);
const SERVICE_ID = /^(\d+)@/;

export const KITE_KINDS = {
  'kite-widgets': {
    group: 'kite',
    label: 'Kite widget',
    side: 'cloud',
    service: 'kite',
    refers: ROUTING_REFERS,
    nameField: 'name',
    async read(client) {
      const out = [];
      for (const listed of await listWidgets(client)) {
        if (typeof listed.name !== 'string' || listed.name === '') continue;
        const w = (await client.call('GET', widgetPath(listed.id)))?.widget ?? listed;
        out.push({id: String(listed.id), name: String(w.name ?? listed.name), data: pick(w, WIDGET_FIELDS)});
      }
      return out;
    },
    portable: portableRouting,
    // New: CreateWidget. Existing: UpdateWidget, which replaces the widget with what it gets.
    async write(client, item, data, {existing}) {
      if (existing === undefined) {
        let made;
        try {
          made = await client.call('POST', '/v2/kite/widgets', {json: data});
        } catch (e) {
          throw stageFailure('create', e);
        }
        const id = made?.widget?.id;
        if (id === undefined) throw new Error(`Kite did not answer the id of the new widget ${item.name}`);
        return {id: String(id), steps: ['create']};
      }
      try {
        await client.call('PUT', widgetPath(existing), {json: data});
      } catch (e) {
        throw stageFailure('update', e, existing);
      }
      return {id: String(existing), steps: ['update']};
    },
    userIds,
    userEmails,
  },

  'kite-channels': {
    group: 'kite',
    label: 'Kite channel',
    side: 'cloud',
    service: 'kite',
    refers: ROUTING_REFERS,
    noCreate: '{name} is not a number or sender of {host}: map it with --map',
    mapsMissing: true, // a number or sender the target lacks is mapped to one it owns (the plan's `missing`)
    // Every number and sender the company owns, with its configuration ({} when it has none).
    async read(client) {
      const out = [];
      for (const [channel, c] of Object.entries(CHANNELS)) {
        const configs = new Map((await c.configs(client)).map((x) => [String(c.idOf(x)), x]));
        for (const x of await c.list(client)) {
          const name = `${channel}:${c.idOf(x)}`;
          out.push({id: name, name, data: pick(configs.get(String(c.idOf(x))), CHANNEL_FIELDS)});
        }
      }
      return out;
    },
    portable(data, h) {
      // One not configured on the source has nothing to carry.
      if (!Object.keys(data).length) {
        h.bound('target', 'unconfigured', 'not configured on the source: nothing to carry');
        return;
      }
      const id = typeof data.serviceUri === 'string' ? SERVICE_ID.exec(data.serviceUri)?.[1] : undefined;
      if (id !== undefined) data.serviceUri = serviceRef(id, 'serviceUri', h) ?? data.serviceUri;
      else if (typeof data.serviceUri === 'string') h.unresolved('serviceUri', data.serviceUri);
      portableRouting(data, h);
    },
    async write(client, item, data, {existing}) {
      const at = item.name.indexOf(':');
      const channel = CHANNELS[item.name.slice(0, at)];
      if (at < 0 || !channel) throw new Error(`${item.name} is not a Kite channel (sms:, whatsapp:, messenger:, rcs:)`);
      if (!PLAIN(data.target))
        throw new StageError('configure', 'not configured on the source: nothing to write', {id: existing});
      const body = {...data, ...(data.serviceUri !== undefined ? {serviceUri: uriOf(data.serviceUri)} : {})};
      try {
        await client.call('PUT', channel.item(item.name.slice(at + 1)), {json: body});
      } catch (e) {
        throw stageFailure('configure', e, existing);
      }
      return {id: item.name, steps: ['configure']};
    },
    userIds,
    userEmails,
  },
};
