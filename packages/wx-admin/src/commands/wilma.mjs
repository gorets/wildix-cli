// wx-admin wilma: Wilma, the agent platform of the Wildix cloud, for the company of the PBX, with the PBX's CPA token
// (../cloud): agents (draft, versions, deployment, API keys), skills (with their files), tools, connectors and their
// catalog, secrets (never their values), connections, the audit log, traces and usage. Objects by id or exact name; a
// name several share asks for the id. Everything else (assistant and copilot runtime, voice, sandbox, the copilot
// library, running tools): `wx-admin cloud wilma <operation>`.
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload} from 'wldx-core/files';
import {apiPath} from 'wldx-core/http';
import {duration, localTime, oneLine, table, toText} from 'wldx-core/format';
import {readSecret} from 'wldx-core/secret';
import {pickByName} from '../match.mjs';
import {
  dateOption,
  findObject,
  getObject,
  keyValues,
  KINDS,
  listAll,
  listOf,
  masked,
  SHOW_SECRETS,
  wholeNumber,
  wilmaClient,
} from '../wilma/api.mjs';
import {checkSkillFrom, skillCreate, skillExport} from '../wilma/skills.mjs';
import {versionedCommands} from '../wilma/versioned.mjs';

const kindOf = (o) => Object.keys(o ?? {})[0] ?? '';
const updated = (o) => ((o.updatedAt ?? o.createdAt) ? `updated ${localTime(o.updatedAt ?? o.createdAt)}` : '');
const latest = (o) => (o.latestVersion ? `v${o.latestVersion}` : 'unpublished');
const line = (...parts) => parts.filter((p) => p !== undefined && p !== null && p !== '').join(' · ');
const versionsRow = (o) =>
  o.latestVersion
    ? `latest v${o.latestVersion}${o.draftBaseVersion ? `, the draft from v${o.draftBaseVersion}` : ''}`
    : 'none published';

// Text of a file option, or of stdin with "-".
async function textOf(ctx, from) {
  if (from === '-') {
    const chunks = [];
    for await (const c of ctx.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
  }
  return readForUpload(path.resolve(ctx.cwd ?? process.cwd(), from), ctx.env).toString('utf8');
}

// ---- agents ----------------------------------------------------------------------------------------------------

const engineText = (e) => {
  const k = kindOf(e);
  if (k === 'ai') {
    const ai = e.ai;
    const caps = (ai.capabilities ?? []).map(kindOf);
    return line(
      `ai, model ${ai.model ?? 'default'}`,
      `${(ai.skills ?? []).length} skill${(ai.skills ?? []).length === 1 ? '' : 's'}`,
      caps.length ? `capabilities ${[...new Set(caps)].join(', ')}` : '',
    );
  }
  if (k === 'webhook' || k === 'sqs') return `${k} ${e[k].url ?? ''}`.trim();
  return k;
};
const deploymentText = (d) =>
  d?.length ? d.map((x) => `v${x.version} ${x.percentage}%`).join(', ') : 'nothing deployed';

const agentSpec = {
  listWhat: 'name, channels, engine, status, latest version, last change',
  listUsage: ' [--channel voice|chat|assistant]',
  listOptions: {channel: {type: 'string', choices: ['voice', 'chat', 'assistant'], description: 'only agents with it'}},
  listQuery: (v) => ({channel: v.channel}),
  line: (a) =>
    line(
      `${a.name} (${a.id})`,
      Object.keys(a.channels ?? {}).join('+') || 'no channels',
      kindOf(a.engine),
      a.status,
      latest(a),
      updated(a),
    ),
  more: async (client, a) => ({
    deployment: (await client.call('GET', `${KINDS.agents.item(a.id)}/deployment`))?.deployment ?? [],
  }),
  details: (a, all) => [
    ['Name', `${a.name} (${a.id})`],
    ['Status', a.status ?? ''],
    ['Category', a.category ?? ''],
    ['Description', oneLine(a.description ?? '', 100)],
    ['Channels', Object.keys(a.channels ?? {}).join(', ') || 'none'],
    ['Engine', engineText(a.engine)],
    ['Versions', versionsRow(a)],
    ...(all.deployment ? [['Deployment', deploymentText(all.deployment)]] : []),
    ['Updated', localTime(a.updatedAt)],
  ],
  updateUsage: ' [--name NAME] [--description TEXT] [--instructions FILE|-]',
  updateOptions: {
    name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
    description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
    instructions: {
      type: 'string',
      placeholder: 'FILE',
      description: 'the instructions of an AI agent, from a text file (or - for stdin)',
    },
  },
  async applyUpdate(ctx, body) {
    const v = ctx.values;
    if (v.name !== undefined) body.name = v.name;
    if (v.description !== undefined) body.description = v.description;
    if (v.instructions !== undefined) {
      if (!body.engine?.ai)
        throw new UsageError(
          `--instructions is for an AI agent; this one's engine is ${kindOf(body.engine) || 'none'}`,
        );
      body.engine = {...body.engine, ai: {...body.engine.ai, instructions: await textOf(ctx, v.instructions)}};
    }
  },
  publishUsage: ' [--name TEXT]',
  publishOptions: {name: {type: 'string', placeholder: 'TEXT', description: 'a name for the version'}},
  publishBody: (v) => ({name: v.name}),
  publishNote: ' (it serves nothing until deployed)',
  publishAfter: '; it serves nothing until deployed (wx-admin wilma agent deploy)',
};

// "3" or "3=80" → {version, percentage?}
function deployEntry(s) {
  const m = /^(\d+)(?:=(\d+))?$/.exec(String(s));
  if (!m) throw new UsageError(`A deployment is VERSION or VERSION=PERCENT: ${s}`);
  return {version: Number(m[1]), percentage: m[2] === undefined ? undefined : Number(m[2])};
}

const agentExtras = {
  deploy: {
    summary: 'which published versions serve new sessions, and how many of them (changes live traffic: needs --yes)',
    usage: 'wx-admin wilma agent deploy <agent> <version>[=PERCENT]... --yes | --reset --yes',
    details:
      'One version serves every new session; several split them by percent (adding up to 100), e.g. 3=80 4=20.\n' +
      '--reset goes back to the default deployment of the service.',
    options: {
      reset: {type: 'boolean', description: 'back to the default deployment'},
      yes: {type: 'boolean', description: 'yes, change what serves new sessions'},
    },
    args: [1, 10],
    async run(ctx) {
      const [ref, ...entries] = ctx.positionals;
      if (ctx.values.reset && entries.length) throw new UsageError('Give versions or --reset, not both', ctx.usage());
      if (!ctx.values.reset && !entries.length)
        throw new UsageError('Give the versions to deploy, or --reset', ctx.usage());
      let deployment;
      if (!ctx.values.reset) {
        deployment = entries.map(deployEntry);
        if (deployment.length === 1 && deployment[0].percentage === undefined) deployment[0].percentage = 100;
        if (deployment.some((d) => d.percentage === undefined))
          throw new UsageError('Several versions need a percent each: VERSION=PERCENT', ctx.usage());
        if (new Set(deployment.map((d) => d.version)).size !== deployment.length)
          throw new UsageError('A version is given twice');
        const sum = deployment.reduce((n, d) => n + d.percentage, 0);
        if (sum !== 100) throw new UsageError(`The percents add up to ${sum}, not 100`);
      }
      if (!ctx.values.yes) throw new UsageError('A deployment changes live traffic: confirm with --yes', ctx.usage());
      const client = await wilmaClient(ctx);
      const a = await findObject(client, KINDS.agents, ref);
      const base = `${KINDS.agents.item(a.id)}/deployment`;
      const r = ctx.values.reset
        ? await client.call('POST', `${base}/reset`)
        : await client.call('PUT', base, {json: {deployment}});
      return {id: a.id, name: a.name, deployment: r?.deployment ?? deployment ?? []};
    },
    text: (r) => `The agent ${r.name} (${r.id}) serves ${deploymentText(r.deployment)}`,
  },
  keys: {
    summary: 'the API keys of an agent: name, prefix, created, expires, last used',
    usage: 'wx-admin wilma agent keys <agent>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      const a = await findObject(client, KINDS.agents, ctx.positionals[0]);
      return {keys: (await client.call('GET', `${KINDS.agents.item(a.id)}/keys`))?.keys ?? []};
    },
    text: (r) =>
      r.keys.length
        ? r.keys.map((k) =>
            line(
              `${k.name ?? '(no name)'} (${k.id})`,
              `${k.prefix}…`,
              `created ${localTime(k.createdAt)}`,
              k.expiresAt ? `expires ${localTime(k.expiresAt)}` : 'no expiry',
              k.lastUsedAt ? `last used ${localTime(k.lastUsedAt)}` : 'never used',
            ),
          )
        : 'No API keys',
  },
  'key-create': {
    summary: 'a new API key of an agent: its secret is printed once, here only',
    usage: 'wx-admin wilma agent key-create <agent> [--name NAME] [--expires DATE]',
    options: {
      name: {type: 'string', placeholder: 'NAME', description: 'a name for the key'},
      expires: {type: 'string', placeholder: 'DATE', description: 'when it stops working (YYYY-MM-DD or ISO-8601)'},
    },
    args: [1, 1],
    async run(ctx) {
      const expiresAt = dateOption(ctx.values.expires, 'expires');
      const client = await wilmaClient(ctx);
      const a = await findObject(client, KINDS.agents, ctx.positionals[0]);
      const r = await client.call('POST', `${KINDS.agents.item(a.id)}/keys`, {
        json: {name: ctx.values.name, expiresAt},
      });
      return {agent: {id: a.id, name: a.name}, key: r?.key, secret: r?.secret}; // the point: never masked
    },
    text: (r) => [
      `Created the key ${r.key?.name ?? ''} (${r.key?.id}) of the agent ${r.agent.name}`,
      `The secret, shown only now: ${r.secret}`,
    ],
  },
  'key-delete': {
    summary: 'delete API keys of an agent (needs --yes; what uses them stops working)',
    usage: 'wx-admin wilma agent key-delete <agent> <key>... --yes',
    options: {yes: {type: 'boolean', description: 'yes, delete them'}},
    args: [2, 50],
    async run(ctx) {
      if (!ctx.values.yes) throw new UsageError('Deleting a key cannot be undone: confirm with --yes', ctx.usage());
      const client = await wilmaClient(ctx);
      const a = await findObject(client, KINDS.agents, ctx.positionals[0]);
      const keys = (await client.call('GET', `${KINDS.agents.item(a.id)}/keys`))?.keys ?? [];
      const found = ctx.positionals
        .slice(1)
        .map(
          (ref) =>
            keys.find((k) => k.id === ref) ??
            pickByName(keys, ref, (k) => k.name, 'key', `wx-admin wilma agent keys ${a.id}`),
        );
      for (const k of found) await client.call('DELETE', `${KINDS.agents.item(a.id)}${apiPath`/keys/${k.id}`}`);
      return {agent: {id: a.id, name: a.name}, deleted: found.map(({id, name}) => ({id, name}))};
    },
    text: (r) => `Deleted ${r.deleted.map((k) => `${k.name ?? ''} (${k.id})`).join(', ')} of the agent ${r.agent.name}`,
  },
};

// ---- skills and tools ------------------------------------------------------------------------------------------

const skillSpec = {
  listWhat: 'name, visibility, files, status, latest version, last change',
  line: (s) =>
    line(
      `${s.name} (${s.id})`,
      s.access?.visibility,
      s.files?.length ? `${s.files.length} file${s.files.length === 1 ? '' : 's'}` : '',
      s.status,
      latest(s),
      updated(s),
    ),
  details: (s) => [
    ['Name', `${s.name} (${s.id})`],
    ['Status', s.status ?? ''],
    ['Description', oneLine(s.description ?? '', 100)],
    [
      'Access',
      line(
        s.access?.visibility,
        `${s.access?.editors?.length ?? 0} editors`,
        `${s.access?.viewers?.length ?? 0} viewers`,
      ),
    ],
    ['Content', `${String(s.content ?? '').split('\n').length} lines`],
    ['Files', (s.files ?? []).map((f) => f.path).join(', ') || 'none'],
    ['Tools', (s.tools ?? []).map(kindOf).join(', ') || 'none'],
    ['Versions', versionsRow(s)],
    ['Updated', localTime(s.updatedAt)],
  ],
  updateUsage: ' [--name NAME] [--description TEXT] [--content FILE|-]',
  updateOptions: {
    name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
    description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
    content: {
      type: 'string',
      placeholder: 'FILE',
      description: 'the instructions (SKILL.md body), from a file (- for stdin)',
    },
  },
  async applyUpdate(ctx, body) {
    const v = ctx.values;
    if (v.name !== undefined) body.name = v.name;
    if (v.description !== undefined) body.description = v.description;
    if (v.content !== undefined) body.content = await textOf(ctx, v.content);
  },
  checkFrom: checkSkillFrom,
  exportCommand: skillExport,
  createCommand: skillCreate,
};

const handlerText = (h) => {
  const k = kindOf(h);
  if (k === 'connector')
    return `connector ${h.connector?.definition?.key ?? ''}${h.connector?.toolId ? `.${h.connector.toolId}` : ''}`;
  if (k === 'mcp') return `mcp ${h.mcp?.serverUrl ?? ''}`.trim();
  return k;
};

const toolSpec = {
  listWhat: 'name, category, handler, status, latest version, last change',
  line: (t) => line(`${t.name} (${t.id})`, t.category, handlerText(t.handler), t.status, latest(t), updated(t)),
  details: (t) => [
    ['Name', `${t.name} (${t.id})`],
    ['Status', t.status ?? ''],
    ['Category', t.category ?? ''],
    ['Description', oneLine(t.description ?? '', 100)],
    ['Handler', handlerText(t.handler)],
    ['Input', Object.keys(t.input?.schema?.properties ?? {}).join(', ') || 'none'],
    ['Versions', versionsRow(t)],
    ['Updated', localTime(t.updatedAt)],
  ],
  updateUsage: ' [--name NAME] [--description TEXT] [--category TEXT]',
  updateOptions: {
    name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
    description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
    category: {type: 'string', placeholder: 'TEXT', description: 'the new category'},
  },
  async applyUpdate(ctx, body) {
    for (const k of ['name', 'description', 'category']) if (ctx.values[k] !== undefined) body[k] = ctx.values[k];
  },
};

// ---- connectors ------------------------------------------------------------------------------------------------

const authText = (auth, names = new Map()) => {
  if (auth?.shared) {
    const id = auth.shared.connection?.id;
    return `shared connection ${names.get(id) ?? id}${names.has(id) ? ` (${id})` : ''}`;
  }
  if (auth?.user) return 'per user';
  return 'no authorization';
};

// The agents whose draft lists a connector as a capability (the references of the audit do not track connectors).
async function agentsUsingConnector(client, c) {
  const agents = await listOf(client, KINDS.agents);
  return agents
    .filter((a) => (a.engine?.ai?.capabilities ?? []).some((cap) => cap.connector?.id === c.id))
    .map((a) => ({label: a.name, uri: `wilma://agents/${a.id}`}));
}

const connectionNames = async (client) =>
  new Map((await listOf(client, KINDS.connections)).map((c) => [c.id, c.name ?? c.provider]));

const connectorSpec = {
  listWhat: 'name, definition, grant, authorization',
  listMore: async (client) => ({connectionNames: Object.fromEntries(await connectionNames(client))}),
  line: (c, r) =>
    line(
      `${c.name} (${c.id})`,
      `${c.definition?.key}@${c.definition?.version}`,
      `grant ${kindOf(c.grant) || 'none'}`,
      authText(c.authorization, new Map(Object.entries(r?.connectionNames ?? {}))),
    ),
  details: (c) => [
    ['Name', `${c.name} (${c.id})`],
    ['Description', oneLine(c.description ?? '', 100)],
    ['Definition', `${c.definition?.key}@${c.definition?.version}`],
    ['Grant', kindOf(c.grant) || 'none'],
    ['Authorization', authText(c.authorization)],
    ['Configuration', Object.keys(c.configuration ?? {}).join(', ') || 'none'],
  ],
  updateUsage: ' [--name NAME] [--description TEXT]',
  updateOptions: {
    name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
    description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
  },
  async applyUpdate(ctx, body) {
    for (const k of ['name', 'description']) if (ctx.values[k] !== undefined) body[k] = ctx.values[k];
  },
  users: agentsUsingConnector,
};

const DEFS = '/v2/tools/connector-definitions';
const defLine = (d) =>
  line(
    `${d.ref?.key}@${d.ref?.version}`,
    d.metadata?.title,
    d.metadata?.category,
    d.authorization ? `authorization ${(d.authorization.modes ?? []).join('/')}` : 'no authorization',
    d.deprecated ? 'deprecated' : '',
  );

const connectorExtras = {
  catalog: {
    summary: 'the connector definitions a connector is made from (deprecated ones only with --all)',
    usage: 'wx-admin wilma connector catalog [--search TEXT] [--all]',
    options: {
      search: {type: 'string', placeholder: 'TEXT', description: 'definitions that match this text'},
      all: {type: 'boolean', description: 'deprecated definitions too'},
    },
    args: [0, 0],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      const defs = await listAll(client, DEFS, 'definitions', {query: ctx.values.search});
      // the catalog answers whole definitions (instructions, tool schemas): the list keeps what it shows
      return {
        definitions: defs
          .filter((d) => ctx.values.all || !d.deprecated)
          .map((d) => ({ref: d.ref, metadata: d.metadata, authorization: d.authorization, deprecated: d.deprecated})),
      };
    },
    text: (r) => (r.definitions.length ? r.definitions.map(defLine) : 'No connector definitions'),
  },
  definition: {
    summary: 'one connector definition: its configuration fields, tools and authorization',
    usage: 'wx-admin wilma connector definition <key> [--version V]',
    options: {version: {type: 'string', placeholder: 'V', description: 'its version (default: the newest)'}},
    args: [1, 1],
    async run(ctx) {
      const key = ctx.positionals[0];
      const client = await wilmaClient(ctx);
      let version = ctx.values.version;
      if (version === undefined) {
        const found = (await listAll(client, DEFS, 'definitions')).filter((d) => d.ref?.key === key);
        if (!found.length) throw new UsageError(`No connector definition ${key} (wx-admin wilma connector catalog)`);
        version = String(found.map((d) => d.ref.version).sort((a, b) => Number(b) - Number(a))[0]);
      }
      return masked(ctx, (await client.call('GET', `${DEFS}${apiPath`/${key}/versions/${version}`}`))?.definition);
    },
    text: (d) => {
      const schema = d.configuration?.schema ?? {};
      const required = new Set(schema.required ?? []);
      return table([
        ['Definition', `${d.ref?.key}@${d.ref?.version}${d.deprecated ? ' (deprecated)' : ''}`],
        ['Title', d.metadata?.title ?? ''],
        ['Category', d.metadata?.category ?? ''],
        ['Description', oneLine(d.metadata?.description ?? '', 100)],
        [
          'Configuration',
          Object.keys(schema.properties ?? {})
            .map((k) => `${k}${required.has(k) ? '*' : ''}`)
            .join(', ') || 'none',
        ],
        ['Tools', (d.tools ?? []).map((t) => t.id ?? t.name).join(', ') || 'none'],
        [
          'Authorization',
          d.authorization ? `${(d.authorization.modes ?? []).join('/')} (${d.authorization.provider})` : 'none',
        ],
      ]);
    },
  },
};

// ---- secrets and connections -----------------------------------------------------------------------------------

const SECRET_NAME = /^[a-zA-Z0-9_.-]+$/;
const secretLine = (s) => line(`${s.name} (${s.id})`, s.description, s.status, updated(s));

async function secretValue(ctx, name) {
  const value = await readSecret(ctx, `The value of ${name} (hidden): `);
  if (!value) throw new UsageError('No value: type it, or pipe it in (first line of stdin)');
  return value;
}

const secretCommands = {
  list: {
    summary: 'the secrets of the company: name, description, status, last change (never their values)',
    usage: 'wx-admin wilma secret list [--search TEXT]',
    options: {search: {type: 'string', placeholder: 'TEXT', description: 'secrets whose name holds this text'}},
    args: [0, 0],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      return {secrets: masked(ctx, await listOf(client, KINDS.secrets, {search: ctx.values.search}))};
    },
    text: (r) => (r.secrets.length ? r.secrets.map(secretLine) : 'No secrets'),
  },
  get: {
    summary: 'one secret: its metadata (never its value)',
    usage: 'wx-admin wilma secret get <secret>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      const s = await findObject(client, KINDS.secrets, ctx.positionals[0]);
      return masked(ctx, {...(await getObject(client, KINDS.secrets, s.id)), uri: `wilma://secrets/${s.id}`});
    },
    text: (s) =>
      table([
        ['Name', `${s.name} (${s.id})`],
        ['Description', s.description ?? ''],
        ['Status', s.status ?? ''],
        [
          'Attributes',
          Object.entries(s.attributes ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(', ') || 'none',
        ],
        ['Updated', localTime(s.updatedAt ?? s.createdAt)],
        ['URI', s.uri],
      ]),
  },
  create: {
    summary: 'a new secret: its value typed hidden or piped in (first line of stdin), never an option',
    usage: 'wx-admin wilma secret create <name> [--description TEXT] [--attribute KEY=VALUE]...',
    options: {
      description: {type: 'string', placeholder: 'TEXT', description: 'what it is for'},
      attribute: {type: 'string', multiple: true, placeholder: 'KEY=VALUE', description: 'an attribute (repeatable)'},
    },
    args: [1, 1],
    async run(ctx) {
      const name = ctx.positionals[0];
      if (!SECRET_NAME.test(name)) throw new UsageError(`A secret name is letters, digits, _ . and -: ${name}`);
      const attributes = keyValues(ctx.values.attribute, 'attribute');
      const value = await secretValue(ctx, name);
      const client = await wilmaClient(ctx);
      const body = {name, description: ctx.values.description, value};
      if (attributes.length) body.attributes = Object.fromEntries(attributes);
      const r = await client.call('POST', KINDS.secrets.base, {json: body});
      return masked(ctx, r?.secret ?? {name});
    },
    text: (s) => `Created the secret ${s.name}${s.id ? ` (${s.id})` : ''}`,
  },
  rotate: {
    summary: 'a new value for a secret, typed hidden or piped in (what uses it takes the new one)',
    usage: 'wx-admin wilma secret rotate <secret>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      const s = await findObject(client, KINDS.secrets, ctx.positionals[0]);
      const value = await secretValue(ctx, s.name);
      const r = await client.call('POST', `${KINDS.secrets.item(s.id)}/rotate`, {json: {value}});
      return masked(ctx, r?.secret ?? s);
    },
    text: (s) => `Rotated the secret ${s.name} (${s.id})`,
  },
  update: {
    summary: 'change the name or description of a secret (its value: secret rotate)',
    usage: 'wx-admin wilma secret update <secret> [--name NAME] [--description TEXT]',
    options: {
      name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
      description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      if (v.name === undefined && v.description === undefined)
        throw new UsageError('Nothing to change: give --name or --description', ctx.usage());
      if (v.name !== undefined && !SECRET_NAME.test(v.name))
        throw new UsageError(`A secret name is letters, digits, _ . and -: ${v.name}`);
      const client = await wilmaClient(ctx);
      const found = await findObject(client, KINDS.secrets, ctx.positionals[0]);
      const s = await getObject(client, KINDS.secrets, found.id);
      const body = {name: v.name ?? s.name, description: v.description ?? s.description, attributes: s.attributes};
      const r = await client.call('PUT', KINDS.secrets.item(s.id), {json: body});
      return masked(ctx, r?.secret ?? {...s, ...body});
    },
    text: (s) => `Updated the secret ${s.name} (${s.id})`,
  },
  delete: {
    summary: 'delete secrets (needs --yes; what uses them stops working)',
    usage: 'wx-admin wilma secret delete <secret>... --yes',
    options: {yes: {type: 'boolean', description: 'yes, delete them'}},
    args: [1, 50],
    async run(ctx) {
      if (!ctx.values.yes) throw new UsageError('Deleting a secret cannot be undone: confirm with --yes', ctx.usage());
      const client = await wilmaClient(ctx);
      const found = [];
      for (const ref of ctx.positionals) found.push(await findObject(client, KINDS.secrets, ref));
      for (const s of found) await client.call('DELETE', KINDS.secrets.item(s.id));
      return {deleted: found.map(({id, name}) => ({id, name}))};
    },
    text: (r) => `Deleted ${r.deleted.map((s) => `${s.name} (${s.id})`).join(', ')}`,
  },
};

// The owner of a user connection is personal data: without --full only its id.
const privateConn = (ctx, c) => (ctx.values.full || !c.actor ? c : {...c, actor: {id: c.actor.id}});
const connLine = (c) =>
  line(
    `${c.name ?? '(per user)'} (${c.id})`,
    c.type,
    c.provider,
    c.status,
    c.lastUsedAt ? `last used ${localTime(c.lastUsedAt)}` : '',
    c.actor?.name ? `of ${c.actor.name}` : '',
  );
const FULL = {full: {type: 'boolean', description: 'the owner of a user connection by name'}};

const connectionCommands = {
  list: {
    summary: 'the connections (OAuth and credentials) of the company: name, type, provider, status, last use',
    usage: 'wx-admin wilma connection list [--type shared|user] [--provider P] [--search TEXT] [--full]',
    details: 'A connection is authorized in a browser (OAuth): the WIM console does it.',
    options: {
      type: {type: 'string', choices: ['shared', 'user'], description: 'only connections of this type'},
      provider: {type: 'string', placeholder: 'P', description: 'only connections to this provider'},
      search: {type: 'string', placeholder: 'TEXT', description: 'connections whose name holds this text'},
      ...FULL,
    },
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      const client = await wilmaClient(ctx);
      const list = await listOf(client, KINDS.connections, {type: v.type, provider: v.provider, search: v.search});
      return {
        connections: masked(
          ctx,
          list.map((c) => privateConn(ctx, c)),
        ),
      };
    },
    text: (r) => (r.connections.length ? r.connections.map(connLine) : 'No connections'),
  },
  get: {
    summary: 'one connection',
    usage: 'wx-admin wilma connection get <connection> [--full]',
    options: {...FULL},
    args: [1, 1],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      const c = await findObject(client, KINDS.connections, ctx.positionals[0]);
      return masked(ctx, privateConn(ctx, await getObject(client, KINDS.connections, c.id)));
    },
    text: (c) =>
      table([
        ['Name', `${c.name ?? '(per user)'} (${c.id})`],
        ['Type', c.type ?? ''],
        ['Provider', c.provider ?? ''],
        ['Status', c.status ?? ''],
        ...(c.actor?.name ? [['Owner', c.actor.name]] : []),
        ['Last used', c.lastUsedAt ? localTime(c.lastUsedAt) : 'never'],
        ['Updated', localTime(c.updatedAt ?? c.createdAt)],
      ]),
  },
  verify: {
    summary: 'ask the provider whether a connection works',
    usage: 'wx-admin wilma connection verify <connection>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      const c = await findObject(client, KINDS.connections, ctx.positionals[0]);
      const r = await client.call('POST', `${KINDS.connections.item(c.id)}/verify`);
      return {id: c.id, name: c.name, ...r};
    },
    text: (r) =>
      `${r.name ?? '(per user)'} (${r.id}): ${r.working ? 'works' : 'does not work'}${r.status ? ` · ${r.status}` : ''}${r.reason ? ` · ${r.reason}` : ''}`,
  },
  delete: {
    summary: 'delete connections (needs --yes; what uses them stops working)',
    usage: 'wx-admin wilma connection delete <connection>... --yes',
    options: {yes: {type: 'boolean', description: 'yes, delete them'}},
    args: [1, 50],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError('Deleting a connection cannot be undone: confirm with --yes', ctx.usage());
      const client = await wilmaClient(ctx);
      const found = [];
      for (const ref of ctx.positionals) found.push(await findObject(client, KINDS.connections, ref));
      for (const c of found) await client.call('DELETE', KINDS.connections.item(c.id));
      return {deleted: found.map(({id, name}) => ({id, name}))};
    },
    text: (r) => `Deleted ${r.deleted.map((c) => `${c.name ?? '(per user)'} (${c.id})`).join(', ')}`,
  },
};

// ---- audit, traces, usage --------------------------------------------------------------------------------------

const URI = /^[a-z][a-z0-9+.-]*:\/\/.+$/;
const checkUri = (u, name) => {
  if (u !== undefined && !URI.test(u)) throw new UsageError(`${name} is a URI such as wilma://agents/<id>: ${u}`);
  return u;
};
const LIMIT = {type: 'string', placeholder: 'N', description: 'at most N (default 50)'};
const SINCE = {type: 'string', placeholder: 'DATE', description: 'from this time on (YYYY-MM-DD or ISO-8601)'};
const UNTIL = {type: 'string', placeholder: 'DATE', description: 'before this time (YYYY-MM-DD or ISO-8601)'};
const FILTER = {
  type: 'string',
  multiple: true,
  placeholder: 'KEY=VALUE',
  description: 'an attribute filter, e.g. agent.id=a_123 or channel=voice (repeatable)',
};
const filters = (v) => keyValues(v.filter, 'filter').map(([k, val]) => `${k}=${val}`);
const actorText = (a) => (a ? `${a.type ? `${a.type} ` : ''}${a.id ?? ''}` : '');
const show = (v) => (v === undefined ? '—' : oneLine(typeof v === 'string' ? v : JSON.stringify(v), 70));

const auditCommands = {
  list: {
    summary: 'the audit log of Wilma objects, newest first: time, action, object, who',
    usage:
      'wx-admin wilma audit list [--uri URI | --prefix URI] [--action A] [--actor ID] [--since DATE] [--until DATE] [--limit N]',
    options: {
      uri: {type: 'string', placeholder: 'URI', description: 'the events of one object (wilma://agents/<id>)'},
      prefix: {
        type: 'string',
        placeholder: 'URI',
        description: 'the events of objects under this URI (wilma://skills/)',
      },
      action: {
        type: 'string',
        placeholder: 'A',
        description: 'only this action (created, updated, deleted, executed…)',
      },
      actor: {type: 'string', placeholder: 'ID', description: 'only what this actor did'},
      since: SINCE,
      until: UNTIL,
      limit: LIMIT,
    },
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      if (v.uri !== undefined && v.prefix !== undefined) throw new UsageError('Give --uri or --prefix, not both');
      const params = {
        uri: checkUri(v.uri, '--uri'),
        uriPrefix: checkUri(v.prefix, '--prefix'),
        action: v.action,
        actorId: v.actor,
        from: dateOption(v.since, 'since'),
        to: dateOption(v.until, 'until'),
      };
      const max = wholeNumber(v.limit, 'limit', {max: 1000, fallback: 50});
      const client = await wilmaClient(ctx);
      return {events: masked(ctx, await listAll(client, '/v2/audit/events', 'events', params, {max}))};
    },
    text: (r) =>
      r.events.length
        ? r.events.map((e) =>
            line(localTime(e.timestamp), e.action, e.resource, actorText(e.actor), e.attributes?.name, e.eventId),
          )
        : 'No events',
  },
  get: {
    summary: 'one audit event with its changes',
    usage: 'wx-admin wilma audit get <event>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      return masked(ctx, (await client.call('GET', apiPath`/v2/audit/events/${ctx.positionals[0]}`))?.event);
    },
    text: (e) => [
      ...table([
        ['Event', e.eventId],
        ['Time', localTime(e.timestamp)],
        ['Action', e.action],
        ['Object', `${e.resource}${e.attributes?.name ? ` (${e.attributes.name})` : ''}`],
        ['Who', actorText(e.actor)],
      ]),
      ...(e.changes ?? []).map((c) => `${c.path}: ${show(c.before)} → ${show(c.after)}`),
    ],
  },
  uses: {
    summary: 'who uses an object (the agents that use a skill or a tool, their drafts too)',
    usage: 'wx-admin wilma audit uses <uri>',
    details: 'The URI of an object is in the text of its get, e.g. wilma://skills/<id>.',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const uri = checkUri(ctx.positionals[0], 'The argument');
      const client = await wilmaClient(ctx);
      return {uri, references: await listAll(client, '/v2/audit/references', 'references', {uri})};
    },
    text: (r) => (r.references.length ? r.references.map((x) => `${x.label}  ${x.uri}`) : `Nothing uses ${r.uri}`),
  },
};

const traceWho = (t) => {
  const a = t.attributes ?? {};
  return a['agent.name'] ?? a['profile.name'] ?? a['agent.id'] ?? a['profile.id'] ?? '';
};
const seconds = (from, to) => (from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : undefined);
const dur = (from, to) => {
  const s = seconds(from, to);
  return s === undefined ? 'running' : s < 60 ? `${s.toFixed(1)}s` : duration(Math.round(s));
};

const traceCommands = {
  list: {
    summary: 'the traces of Wilma sessions (voice, chat, assistant, copilot, tools, workflow), newest first',
    usage:
      'wx-admin wilma trace list [--service S] [--status S] [--since DATE] [--until DATE] [--search TEXT] [--filter KEY=VALUE]... [--limit N]',
    options: {
      service: {type: 'string', placeholder: 'S', description: 'voice, chat, assistant, copilot, tools, workflow…'},
      status: {type: 'string', placeholder: 'S', description: 'pending, complete, error…'},
      since: SINCE,
      until: UNTIL,
      search: {type: 'string', placeholder: 'TEXT', description: 'in the trace id, session, conversation…'},
      filter: FILTER,
      limit: LIMIT,
    },
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      const params = {
        service: v.service,
        status: v.status,
        from: dateOption(v.since, 'since'),
        to: dateOption(v.until, 'until'),
        search: v.search,
        filter: filters(v),
      };
      const max = wholeNumber(v.limit, 'limit', {max: 1000, fallback: 50});
      const client = await wilmaClient(ctx);
      return {traces: masked(ctx, await listAll(client, '/v2/traces', 'traces', params, {max}))};
    },
    text: (r) =>
      r.traces.length
        ? r.traces.map((t) =>
            line(localTime(t.startTime), t.service, t.status, dur(t.startTime, t.endTime), traceWho(t), t.traceId),
          )
        : 'No traces',
  },
  get: {
    summary: 'one trace and its spans as a timeline',
    usage: 'wx-admin wilma trace get <trace>',
    options: {...SHOW_SECRETS},
    args: [1, 1],
    async run(ctx) {
      const client = await wilmaClient(ctx);
      return masked(ctx, (await client.call('GET', apiPath`/v2/traces/items/${ctx.positionals[0]}`))?.trace);
    },
    text: (t) => {
      const start = Date.parse(t.startTime);
      const spans = [...(t.spans ?? [])].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
      return [
        ...table([
          ['Trace', t.traceId],
          ['Service', t.service ?? ''],
          ['Status', t.status ?? ''],
          ['Started', localTime(t.startTime)],
          ['Duration', dur(t.startTime, t.endTime)],
          ['Who', traceWho(t)],
        ]),
        ...spans.map((s) =>
          line(
            `+${((Date.parse(s.startTime) - start) / 1000).toFixed(1)}s`,
            s.kind,
            s.attributes?.name ?? s.attributes?.['tool.name'] ?? s.attributes?.['model.id'],
            s.status,
            dur(s.startTime, s.endTime),
            s.spanId,
          ),
        ),
      ];
    },
  },
  'model-call': {
    summary: 'one model call of a trace: model, settings, tokens, messages',
    usage: 'wx-admin wilma trace model-call <trace> <span>',
    options: {...SHOW_SECRETS},
    args: [2, 2],
    async run(ctx) {
      const [trace, span] = ctx.positionals;
      const client = await wilmaClient(ctx);
      return masked(ctx, (await client.call('GET', apiPath`/v2/traces/items/${trace}/model-calls/${span}`))?.modelCall);
    },
    text: (m) => toText(m),
  },
};

const number = (n) =>
  typeof n === 'number' ? (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)) : String(n);
const metricsText = (m = {}) =>
  Object.keys(m)
    .sort()
    .map((k) => `${k} ${number(m[k])}`)
    .join(' · ');

const usage = {
  summary: 'usage of Wilma over a time window: tokens, call seconds, spans, errors… by service, agent or channel',
  usage:
    'wx-admin wilma usage [--service S] [--since DATE] [--until DATE] [--interval hour|day|week|month|total] [--group-by KEY]... [--filter KEY=VALUE]...',
  options: {
    service: {type: 'string', placeholder: 'S', description: 'voice, chat, assistant, copilot, tools, workflow…'},
    since: SINCE,
    until: UNTIL,
    interval: {type: 'string', choices: ['hour', 'day', 'week', 'month', 'total'], description: 'one row per period'},
    'group-by': {
      type: 'string',
      multiple: true,
      placeholder: 'KEY',
      description: 'a trace attribute to group by, e.g. agent.id or channel (repeatable)',
    },
    filter: FILTER,
  },
  args: [0, 0],
  async run(ctx) {
    const v = ctx.values;
    const params = {
      service: v.service,
      from: dateOption(v.since, 'since'),
      to: dateOption(v.until, 'until'),
      interval: v.interval,
      groupBy: v['group-by'],
      filter: filters(v),
    };
    const client = await wilmaClient(ctx);
    const rows = [];
    let total;
    let cursor;
    for (let page = 0; page < 50; page++) {
      const r = (await client.call('GET', '/v2/traces/usage', {query: {...params, limit: 100, cursor}})) ?? {};
      rows.push(...(r.rows ?? []));
      total ??= r.total;
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return {rows, total};
  },
  text: (r) => [
    ...r.rows.map((row) => {
      const dims = Object.entries(row.dimensions ?? {})
        .map(([k, val]) => `${k}=${val}`)
        .join(' ');
      const when = row.start ?? row.time ?? row.bucket;
      return `${[when ? localTime(when) : '', dims || 'all'].filter(Boolean).join(' ')}: ${metricsText(row.metrics)}`;
    }),
    ...(r.total && Object.keys(r.total).length ? [`total: ${metricsText(r.total.metrics ?? r.total)}`] : []),
  ],
};

export const groups = {
  wilma: {
    summary: 'Wilma, the agent platform of the cloud: agents, skills, tools, connectors, secrets, audit, traces',
    commands: {
      agent: {
        summary: 'the agents: draft, versions, deployment, API keys',
        commands: {...versionedCommands(KINDS.agents, agentSpec), ...agentExtras},
      },
      skill: {summary: 'the skills agents use, with their files', commands: versionedCommands(KINDS.skills, skillSpec)},
      tool: {summary: 'the tools agents use', commands: versionedCommands(KINDS.tools, toolSpec)},
      connector: {
        summary: 'the connectors of the company (HubSpot, Google Drive, e-mail…) and their catalog',
        commands: {...versionedCommands(KINDS.connectors, connectorSpec), ...connectorExtras},
      },
      secret: {summary: 'the secrets agents and tools use (never their values)', commands: secretCommands},
      connection: {
        summary: 'the connections (OAuth, credentials) of connectors and tools',
        commands: connectionCommands,
      },
      audit: {summary: 'who changed what in Wilma, and who uses an object', commands: auditCommands},
      trace: {summary: 'the traces of Wilma sessions', commands: traceCommands},
      usage,
    },
  },
};
