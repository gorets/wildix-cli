// Wilma agents in the config transfer: published and draft, deployed on the target when the source agent has a
// deployment of its own. What an agent points at: its capabilities (in engine.ai.capabilities and in the steps of its
// workflow: tools, connectors, knowledge bases, other agents, services, dialplans), its skills, the secrets of its
// engine and of its voices, the ACL group of the PBX and the users and groups it is granted to. Agents point at each
// other (in cycles too): a new agent is first made as a placeholder, then written whole. Paths and fields as
// `wx-admin wilma agent` uses them (src/commands/wilma.mjs).
import {KINDS} from '../../wilma/api.mjs';
import {readVersioned, versionedWrite} from './versioned.mjs';
import {
  accessRefs,
  CAPABILITY_REFERS,
  capabilityRefs,
  draftSecretsShared,
  PLAIN,
  pin,
  refAt,
  transferRefs,
  userIdsOf,
} from './wilma.mjs';

// The agents of the service on every company: never carried.
const BUILT_IN = new Set(['wilma-system', 'wms-00000000']);
// A company's own speech provider key in a voice URI: a reference to a Wilma secret (apiKey=secrets:<id>).
const VOICE_KEY = /[?&]apiKey=secrets:([A-Za-z0-9_-]+)/g;
// The instructions of a placeholder whose source has none (an agent with a webhook or SQS engine).
const PLACEHOLDER = 'Being written by wx-admin config import';

// Every string of the channels, where a voice URI may name a secret: {$template} with the secret as its argument.
function voiceKeys(value, at, h) {
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    const where = Array.isArray(value) ? `${at}[${k}]` : `${at}.${k}`;
    if (typeof v === 'string') value[k] = h.template(v, where, VOICE_KEY, 'wilma-secrets', ['id']);
    else voiceKeys(v, where, h);
  }
}

// A SecretRef ({id}) is a reference to a Wilma secret; a string in its place is the secret itself.
function secretField(obj, key, at, h) {
  if (typeof obj[key]?.id === 'string') obj[key].id = h.ref(obj[key].id, 'wilma-secrets', `${at}.id`, ['id']);
  else h.secret(obj, key, at);
}

// The references of one definition (the published one, or the draft with prefix 'draft.').
function agentRefs(def, prefix, h) {
  if (!PLAIN(def)) return;
  const at = (p) => `${prefix}${p}`;
  if (PLAIN(def.settings) && typeof def.settings.pbxGroupId === 'string')
    def.settings.pbxGroupId = h.ref(def.settings.pbxGroupId, 'acl-groups', at('settings.pbxGroupId'), ['id', 'name']);
  accessRefs(def.access, at('access'), h);

  // Where a voice call goes when the caller stays silent or the call lasts too long.
  for (const k of ['silenceTimeout', 'maxDuration'])
    transferRefs(def.channels?.voice?.[k]?.action?.transfer, at(`channels.voice.${k}.action.transfer`), h);
  const sound = def.channels?.voice?.backgroundSound;
  if (PLAIN(sound) && typeof sound.sound === 'string')
    h.ref(sound.sound, 'moh', at('channels.voice.backgroundSound.sound')); // checked on the target, kept as it is
  voiceKeys(def.channels, at('channels'), h);

  const engine = def.engine ?? {};
  if (PLAIN(engine.ai)) {
    for (const [i, s] of (Array.isArray(engine.ai.skills) ? engine.ai.skills : []).entries()) {
      if (!PLAIN(s)) continue;
      const where = at(`engine.ai.skills[${i}]`);
      refAt(s, 'id', 'wilma-skills', where, h);
      pin(s, 'skillVersion', 'wilma-skills', s.id, where, h);
      accessRefs(s.access, `${where}.access`, h);
    }
    capabilityRefs(engine.ai.capabilities, at('engine.ai.capabilities'), h);
    capabilityRefs(engine.ai.workflow, at('engine.ai.workflow'), h);
  }
  if (PLAIN(engine.webhook) && engine.webhook.secret !== undefined)
    secretField(engine.webhook, 'secret', at('engine.webhook.secret'), h);
  if (PLAIN(engine.sqs)) {
    h.secret(engine.sqs, 'key', at('engine.sqs.key'));
    if (engine.sqs.secret !== undefined) secretField(engine.sqs, 'secret', at('engine.sqs.secret'), h);
  }
}

export const WILMA_AGENT_KINDS = {
  'wilma-agents': {
    group: 'wilma',
    label: 'Wilma agent',
    side: 'cloud',
    service: 'wilma',
    refers: [...CAPABILITY_REFERS, 'wilma-skills', 'wilma-secrets'],
    nameField: 'name',
    // The secrets of an SQS engine (and a webhook secret given as a value) and of sandbox environments: without a
    // value the agent is skipped.
    secrets: [
      {path: /^(?:draft\.)?engine\.(?:sqs\.(?:key|secret)|webhook\.secret)$/, empty: 'skip'},
      {path: /\.env\[\d+\]\.value$/, empty: 'skip'},
    ],
    // deploy: the source serves a deployment of its own (GET <agent>/deployment not empty); then the version
    // published on the target is deployed at 100%. An agent never published has none.
    async read(client) {
      const agents = await readVersioned(client, KINDS.agents, {skip: (a) => BUILT_IN.has(String(a.id))});
      for (const a of agents) {
        if (a.version === undefined) continue;
        const routes = (await client.call('GET', `${KINDS.agents.item(a.id)}/deployment`))?.deployment;
        a.data.deploy = Array.isArray(routes) && routes.length > 0;
      }
      return agents;
    },
    portable(data, h) {
      agentRefs(data, '', h);
      agentRefs(data.draft, 'draft.', h);
      draftSecretsShared(data);
    },
    write: versionedWrite(KINDS.agents, {deploy: (data) => data.deploy === true}),
    // The first pass makes a new agent as a placeholder, never published: its name, its description and its
    // instructions, no channel and no capability (none that points at an agent, nor any other: references and
    // secrets are put in only by the second pass, which writes the whole definition and publishes it).
    twoPass: {
      bare(data) {
        const instructions = data.engine?.ai?.instructions;
        return {
          name: data.name,
          ...(typeof data.description === 'string' ? {description: data.description} : {}),
          channels: {},
          engine: {ai: {instructions: typeof instructions === 'string' && instructions ? instructions : PLACEHOLDER}},
        };
      },
    },
    // The x-bees users the agent grants something to (read on the source to find them on the target by e-mail).
    userIds: (data) => [...userIdsOf(data)],
  },
};
