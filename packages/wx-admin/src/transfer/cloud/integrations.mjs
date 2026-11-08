// The integrations of the WIM console in the config transfer: webhooks, the iframe apps of x-bees and the settings of
// the CRM connectors. Paths and bodies as `wx-admin integration` makes them (src/commands/integration.mjs): the
// console state (GET /console/integrations), a create (POST {service, data}), an app written whole (POST with
// isNew false and its integrationId), a change (PATCH {integrationId, data}, merged into what is stored).
//
// A webhook is known by its URL. Only HTTP webhooks are carried: one made by another integration (Salesforce Omni,
// the integrations hub) is never read, an SQS webhook is left out. Its signing secret travels as {$secret: 'secret'}:
// without a value, a new webhook gets a generated one, and an overwrite sends only the fields that change (never the
// secret, unless one is given). A CRM connector is installed in the WIM console (OAuth): only its settings travel, to
// a connector of the same service on the target. A failed step names its HTTP status only: an answer of the console
// may echo the body, and a body may hold the secret.
import {consoleCall, consoleState, ownerOfWebhook, SERVICES} from '../../integration/api.mjs';
import {StageError} from '../stage-error.mjs';
import {stageFailure} from './versioned.mjs';
import {DROPPED} from './wilma.mjs';

const CONSOLE = '/console/integrations';
const PLAIN = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const present = (v) => v !== undefined && v !== null && v !== '';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const installedOf = async (client) => (await consoleState(client))?.installed ?? [];
const eventsOf = (data) => (Array.isArray(data?.events) ? data.events.map((e) => e?.value ?? e) : []);

// A step of a write: its failure is a StageError with the HTTP status only (a refused access stops the import).
async function step(stage, id, call) {
  try {
    return await call();
  } catch (e) {
    throw stageFailure(stage, e, id);
  }
}
// The integration on the target again (the write gets only its id), for what an overwrite keeps or compares.
async function current(client, id) {
  const found = (await step('read', id, () => installedOf(client))).find((i) => i.integrationId === String(id));
  if (!found) throw new StageError('read', `integration ${id} is no longer on the target`, {id});
  return found;
}
const madeId = (made, what) => {
  const id = made?.integrationId;
  if (id === undefined) throw new Error(`The WIM console did not answer the id of the new ${what}`);
  return String(id);
};

// What an app keeps of the source: not its place in x-bees, its stamp, nor who made it.
const APP_LEFT_OUT = new Set([
  'integrationId',
  'isNew',
  'position',
  'timestamp',
  'createdBy',
  'user',
  'email',
  'userName',
]);
const EMAIL_LISTS = ['accessEmails', 'deniedEmails'];
// The settings of a connector of these services travel (webhooks and apps are kinds of their own).
const CONNECTORS = SERVICES.filter((s) => s !== 'webhook' && s !== 'iframe_integration');

export const INTEGRATION_KINDS = {
  'integration-webhooks': {
    group: 'integrations',
    label: 'webhook',
    side: 'cloud',
    service: 'integrations',
    refers: [],
    nameField: 'url',
    immutable: ['type'],
    secrets: [{path: 'secret', empty: 'generate'}],
    async read(client) {
      const installed = await installedOf(client);
      return installed
        .filter((i) => i.service === 'webhook' && present(i.data?.url) && !ownerOfWebhook(client, installed, i))
        .map((i) => ({
          id: String(i.integrationId),
          name: String(i.data.url),
          // An SQS webhook keeps no key nor secret here: it is left out (portable).
          data:
            i.data.type === 'webhook'
              ? {
                  type: 'webhook',
                  url: i.data.url,
                  events: eventsOf(i.data),
                  ...(present(i.data.secret) ? {secret: i.data.secret} : {}),
                }
              : {type: i.data.type, url: i.data.url, events: eventsOf(i.data)},
        }));
    },
    portable(data, h) {
      if (data.type !== 'webhook') {
        h.bound('type', 'sqs', 'SQS webhooks are not carried');
        h.warn('type', 'SQS webhooks are not carried');
        return;
      }
      h.secret(data, 'secret', 'secret');
    },
    async write(client, item, data, {existing}) {
      const events = (data.events ?? []).map((value) => ({value}));
      if (existing === undefined) {
        const body = {service: 'webhook', data: {type: 'webhook', url: data.url, key: '', secret: data.secret, events}};
        const made = await step('create', undefined, () => consoleCall(client, 'POST', CONSOLE, {json: body}));
        return {id: madeId(made, 'webhook'), steps: ['create']};
      }
      // Only what changes: the console merges `data` into what it has; the secret only when one was given.
      const now = (await current(client, existing)).data ?? {};
      const change = {};
      if (now.url !== data.url) change.url = data.url;
      if (!same(eventsOf(now), data.events ?? [])) change.events = events;
      if (present(data.secret)) change.secret = data.secret;
      if (!Object.keys(change).length) return {id: String(existing), steps: ['nothing to change']};
      await step('update', existing, () =>
        consoleCall(client, 'PATCH', CONSOLE, {json: {integrationId: String(existing), data: change}}),
      );
      return {id: String(existing), steps: ['update']};
    },
  },

  'integration-apps': {
    group: 'integrations',
    label: 'iframe app',
    side: 'cloud',
    service: 'integrations',
    refers: ['xbees-users'],
    nameField: 'title',
    async read(client) {
      return (await installedOf(client))
        .filter((i) => i.service === 'iframe_integration' && present(i.data?.title))
        .map((i) => ({
          id: String(i.integrationId),
          name: String(i.data.title),
          data: Object.fromEntries(Object.entries(i.data).filter(([k]) => !APP_LEFT_OUT.has(k))),
        }));
    },
    // Who sees the app and who does not: x-bees users by e-mail (in lower case, as the directory knows them). An
    // e-mail that is no user of the source is dropped with a warning (as an entry of an access list of Wilma).
    portable(data, h) {
      for (const list of EMAIL_LISTS)
        if (Array.isArray(data[list]))
          data[list] = data[list].flatMap((e, i) => {
            if (typeof e !== 'string') return [e];
            const r = h.ref(e.toLowerCase(), 'xbees-users', `${list}[${i}]`, ['name'], 'drop');
            if (r === undefined) {
              h.warn(`${list}[${i}]`, `${e} ${DROPPED}`);
              return [];
            }
            return [PLAIN(r) ? r : e];
          });
    },
    // New: created at the first place, as `integration app create` does. Existing: the console rebuilds an app from
    // what it gets, so what the target has is sent back with the source's fields over it (its place stays).
    async write(client, item, data, {existing}) {
      if (existing === undefined) {
        const body = {service: 'iframe_integration', data: {...data, position: 0, isNew: true}};
        const made = await step('create', undefined, () => consoleCall(client, 'POST', CONSOLE, {json: body}));
        return {id: madeId(made, 'app'), steps: ['create']};
      }
      const {timestamp, ...old} = (await current(client, existing)).data ?? {};
      const body = {
        service: 'iframe_integration',
        data: {...old, ...data, isNew: false, integrationId: String(existing)},
      };
      await step('update', existing, () => consoleCall(client, 'POST', CONSOLE, {json: body}));
      return {id: String(existing), steps: ['update']};
    },
    // The e-mails of the users the app names (what the source reads of xbees-users).
    userEmails: (data) =>
      EMAIL_LISTS.flatMap((l) => (Array.isArray(data?.[l]) ? data[l] : []))
        .filter((e) => typeof e === 'string' && e !== '')
        .map((e) => e.toLowerCase()),
  },

  'integration-crm': {
    group: 'integrations',
    label: 'CRM settings',
    side: 'cloud',
    service: 'integrations',
    refers: [],
    noCreate: 'not installed on {host}: install it in the WIM console, then re-run',
    async read(client) {
      return (await installedOf(client))
        .filter((i) => CONNECTORS.includes(i.service) && PLAIN(i.data?.settings))
        .map((i) => ({id: String(i.integrationId), name: i.service, data: {settings: i.data.settings}}));
    },
    async write(client, item, data, {existing}) {
      if (existing === undefined) throw new Error(`${item.name} is not installed on the target`); // planned blocked
      await step('update', existing, () =>
        consoleCall(client, 'PATCH', CONSOLE, {
          json: {integrationId: String(existing), data: {settings: data.settings}},
        }),
      );
      return {id: String(existing), steps: ['update']};
    },
  },
};
