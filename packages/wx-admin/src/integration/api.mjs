// The integrations of the WIM console for the company of the PBX, with its CPA token (../cloud): the console API
// (/console/integrations, /console/integration-logs), the traces of an integration (/v2/traces) and the
// integrations hub (/v2/integrations-hub/manage), all on the WIM host. The console API has no OpenAPI: paths and
// shapes come from the sources of the WIM console and backend. Its answers are wrapped: {success, result | message}.
import crypto from 'node:crypto';
import {cloudClient} from '../cloud/client.mjs';
import {maskCloud} from '../cloud/mask.mjs';
import {pickByName} from '../match.mjs';

export const integrationsClient = (ctx) => cloudClient(ctx, 'integrations');

export const SHOW_SECRETS = {
  'show-secrets': {
    type: 'boolean',
    description:
      'show the secrets in the answer: webhook signing secrets, keys, Nango connection ids (masked otherwise)',
  },
};
export const FULL = {
  full: {type: 'boolean', description: 'with the people: who connected or created it, e-mails in logs and traces'},
};

// The services the console installs or shows; `allowed` of the company may name more (apps of the x-bees client).
export const SERVICES = [
  'webhook',
  'iframe_integration',
  'google_calendar',
  'microsoft_calendar',
  'microsoft_presence',
  'hubspot_backend',
  'salesforce_backend',
  'salesforce_omni',
  'salesforce_telephony',
  'salesforce_community',
  'zoho_desk_backend',
  'zoho_crm_backend',
  'gong',
];

// The events of a webhook, as the WIM console offers them (call:start, call:update and call:end are deprecated there
// and not offered here).
export const WEBHOOK_EVENTS = {
  calls: [
    'call:live:progress',
    'call:live:completed',
    'call:live:interrupted',
    'call:live:annotation',
    'call:live:transcription',
    'call:live:record:start',
    'call:live:record:stop',
    'call:live:record:pause',
    'call:live:record:unpause',
  ],
  services: ['service:call:live:progress', 'service:call:live:completed'],
  conferences: [
    'conference:live:progress',
    'conference:live:join',
    'conference:live:leave',
    'conference:live:completed',
    'conference:live:interrupted',
    'conference:live:annotation',
    'conference:live:transcription',
  ],
  chats: [
    'chat:channel:created',
    'chat:channel:updated',
    'chat:member:added',
    'chat:member:removed',
    'chat:message:new',
    'chat:message:updated',
    'chat:message:deleted',
    'chat:reaction:new',
    'chat:reaction:deleted',
    'chat:live:progress',
    'chat:live:completed',
    'chat:live:interrupted',
    'chat:live:annotation',
    'chat:manager:missed',
  ],
  analytics: [
    'call:completed',
    'call:transcription:completed',
    'call:transcription:text:completed',
    'call:annotations:completed',
    'call:insights:completed',
    'call:summary:completed',
    'conference:completed',
    'conference:transcription:completed',
    'conference:transcription:text:completed',
    'conference:annotations:completed',
    'conference:insights:completed',
    'conference:summary:completed',
    'chat:annotations:completed',
    'chat:insights:completed',
    'chat:completed',
  ],
  presence: ['presence:user', 'presence:telephony', 'presence:conference'],
  messaging: ['sms:status', 'whatsapp:status', 'messenger:status', 'rcs:status'],
};
export const EVENTS = Object.values(WEBHOOK_EVENTS).flat();

// A request of the console API, unwrapped: the `result`, or an error with the `message` of an answer that failed.
export async function consoleCall(client, method, path, options) {
  const answer = await client.call(method, path, options);
  if (answer && typeof answer === 'object' && answer.success === false) {
    const reason =
      answer.message ?? (typeof answer.result === 'string' ? answer.result : JSON.stringify(answer.result));
    const err = new Error(`the WIM console refused it: ${reason}`);
    err.exitCode = 1;
    throw err;
  }
  return answer?.result ?? answer;
}

export const consoleState = (client) => consoleCall(client, 'GET', '/console/integrations');

// What names an integration for people: no secret, no person.
export function labelOf(i) {
  const d = i.data ?? {};
  switch (i.service) {
    case 'webhook': {
      let where = d.url ?? '';
      try {
        const u = new URL(d.url);
        where = `${u.origin}${u.pathname}`;
      } catch {
        // not a URL: as it is
      }
      return `${d.type ?? 'webhook'} ${where}`.trim();
    }
    case 'iframe_integration':
      return [d.title, d.templateId ? `(${d.templateId})` : ''].filter(Boolean).join(' ');
    case 'google_calendar':
      return d.domain ?? '';
    case 'microsoft_calendar':
    case 'microsoft_presence':
      return [d.tenant ? `tenant ${d.tenant}` : '', d.syncMode].filter(Boolean).join(', ');
    case 'hubspot_backend':
      return d.hub_domain ?? '';
    case 'salesforce_backend':
    case 'salesforce_omni':
      return d.organizationId ? `org ${d.organizationId}` : '';
    case 'zoho_desk_backend':
    case 'zoho_crm_backend':
      return d.orgId ? `org ${d.orgId}` : '';
    case 'salesforce_telephony':
      return d.integrationName ?? '';
    default:
      return d.title ?? d.name ?? d.providerConfigKey ?? '';
  }
}

// No status: active, as the backend counts it.
export const statusOf = (i) => i.status ?? 'enabled';

// An integration by id or by its label; a label several share asks for the id.
export function findIntegration(installed, ref, hint = 'wx-admin integration list') {
  const want = String(ref);
  return (
    installed.find((i) => i.integrationId === want) ??
    pickByName(
      installed.map((i) => ({...i, id: i.integrationId})),
      ref,
      labelOf,
      'integration',
      hint,
    )
  );
}

// A signing secret as the console makes it: 30 letters and digits.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const newSecret = () => Array.from({length: 30}, () => ALNUM[crypto.randomInt(ALNUM.length)]).join('');

// The webhook the integrations hub gets the events of the company by: made with the hub, removed with it.
export const hubWebhookUrl = (client) => `${client.base}/v2/integrations-hub/events/wildix`;
export const HUB_WEBHOOK_EVENTS = [
  'call:live:progress',
  'call:live:completed',
  'call:live:interrupted',
  'service:call:live:progress',
  'service:call:live:completed',
  'call:summary:completed',
];
export const hubWebhookOf = (client, installed) =>
  installed.find((i) => i.service === 'webhook' && i.data?.url === hubWebhookUrl(client));

// What a webhook belongs to, when not to the administrator: a Salesforce Omni integration makes its own, the
// integrations hub too. Changing it would break that integration.
export function ownerOfWebhook(client, installed, webhook) {
  const omni = installed.find((i) => i.service !== 'webhook' && i.data?.webhookId === webhook.integrationId);
  if (omni) return `${omni.service} ${omni.integrationId}`;
  if (webhook.data?.url === hubWebhookUrl(client)) return 'the integrations hub (wx-admin integration hub)';
  return undefined;
}

const PERSONAL = new Set(['email', 'user', 'createdBy', 'userName', 'name']);
const CONNECTED_BY = new Set(['hubspot_backend', 'salesforce_backend', 'salesforce_omni', 'zoho_crm_backend']);

// What an answer shows: secrets masked unless --show-secrets; who connected a CRM or created a webhook only with --full.
export function shown(ctx, i) {
  if (!i || typeof i !== 'object') return i;
  let out = ctx.values['show-secrets'] ? i : maskCloud(i);
  if (!ctx.values.full && out.data) {
    const personal = (k) => PERSONAL.has(k) && (k !== 'name' || CONNECTED_BY.has(out.service));
    out = {...out, data: Object.fromEntries(Object.entries(out.data).filter(([k]) => !personal(k)))};
  }
  return out;
}
