// The Wilma kinds of the config transfer. Secrets and shared connections (what agents and connectors authorize with)
// come before the knowledge base; connectors, tools and skills after it (agents: wilma-agents.mjs). The value of a
// secret is write-only on its company: it travels as {$secret: 'value'}, given with --secrets, and reaches the target
// only in the body of the create or of POST <secret>/rotate. Paths and fields as `wx-admin wilma secret`,
// `connection`, `connector`, `tool` and `skill` use them (src/commands/wilma.mjs, src/wilma/skills.mjs).
import crypto from 'node:crypto';
import path from 'node:path';
import {apiPath} from 'wldx-core/http';
import {StageError} from '../stage-error.mjs';
import {KINDS, listAll, listOf, pickFields} from '../../wilma/api.mjs';
import {isSkillFilePath} from '../../wilma/skills.mjs';
import {readVersioned, stageFailure, versionedWrite} from './versioned.mjs';

const present = (v) => v !== undefined && v !== null && v !== '';
export const PLAIN = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const filled = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => present(v)));

export const WILMA_SECRET_KINDS = {
  'wilma-secrets': {
    group: 'wilma',
    label: 'Wilma secret',
    side: 'cloud',
    service: 'wilma',
    refers: [],
    nameField: 'name',
    secrets: [{path: 'value', empty: 'pending'}],
    async read(client) {
      return (await listOf(client, KINDS.secrets)).map((s) => ({
        id: String(s.id),
        name: String(s.name),
        data: filled({
          name: s.name,
          description: s.description,
          attributes: s.attributes && Object.keys(s.attributes).length ? s.attributes : undefined,
        }),
      }));
    },
    portable(data) {
      data.value = {$secret: 'value'};
    },
    // A new secret takes its value (when given) in the create; an existing one gets its metadata by PUT, and its
    // value, when given, by rotate: the PUT never carries it. A failed step names its HTTP status only: an answer may
    // echo the body, and the body holds the value (in any encoding).
    async write(client, item, data, {existing}) {
      const {value, ...meta} = data;
      const step = async (stage, id, call) => {
        try {
          return await call();
        } catch (e) {
          throw stageFailure(stage, e, id);
        }
      };
      if (existing === undefined) {
        const json = {...meta, ...(present(value) ? {value} : {})};
        const r = await step('create', undefined, () => client.call('POST', KINDS.secrets.base, {json}));
        const id = r?.secret?.id;
        if (id === undefined) throw new Error(`Wilma did not answer the id of the new secret ${item.name}`);
        return {id: String(id), steps: [present(value) ? 'create with value' : 'create']};
      }
      await step('update', existing, () => client.call('PUT', KINDS.secrets.item(existing), {json: meta}));
      const steps = ['update'];
      if (present(value)) {
        // The metadata is already overwritten: the failure names the stage and the id.
        await step('rotate', existing, () =>
          client.call('POST', `${KINDS.secrets.item(existing)}/rotate`, {json: {value}}),
        );
        steps.push('rotate');
      }
      return {id: String(existing), steps};
    },
  },

  // Only SHARED connections (the company's own): a USER connection belongs to one person's authorization. A
  // connection starts PENDING on the target: it is authorized there (OAuth) or by its config.
  'wilma-connections': {
    group: 'wilma',
    label: 'Wilma connection',
    side: 'cloud',
    service: 'wilma',
    refers: [],
    nameField: 'name',
    immutable: ['provider', 'connectionConfig'],
    async read(client) {
      const list = await listAll(client, KINDS.connections.base, KINDS.connections.listKey, {type: 'shared'});
      return list
        .filter((c) => c.type === 'shared' && present(c.name))
        .map((c) => ({
          id: String(c.id),
          name: String(c.name),
          data: filled({
            name: c.name,
            description: c.description,
            provider: c.provider,
            scopes: c.scopes?.length ? c.scopes : undefined,
            connectionConfig:
              c.connectionConfig && Object.keys(c.connectionConfig).length ? c.connectionConfig : undefined,
          }),
        }));
    },
    async create(client, data) {
      const r = await client.call('POST', KINDS.connections.base, {json: data});
      const id = r?.connection?.id;
      if (id === undefined) throw new Error(`Wilma did not answer the id of the new connection ${data.name}`);
      return String(id);
    },
    // An update takes name, description and scopes only; a provider or config of a connection cannot change.
    async update(client, id, data) {
      const {name, description, scopes} = data;
      await client.call('PUT', KINDS.connections.item(id), {json: {name, description, scopes}});
    },
  },
};

// The references of a handler (a tool's) or of a connector's configuration and authorization, anywhere in `value`: a
// connection ({connection: {id}}, shared or MCP) → wilma-connections, a SecretRef ({secret: {id}}, an MCP API key; or
// a plain `secretId`, the auth of the webhook connector's configuration) → wilma-secrets, the MCP server of an MCP
// tool (mcpToolId) → wilma-tools. The value of every custom header is a
// secret ($secret at its path), asked at import. twin: the same place in the published definition, when `value` is
// the draft: a header it already holds as a secret is that secret (one value asked, used for both).
function handlerRefs(value, path, h, twin) {
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    const at = Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`;
    if (k === 'customHeaders' && v && typeof v === 'object' && !Array.isArray(v))
      for (const name of Object.keys(v)) {
        const published = twin?.[k]?.[name]?.$secret;
        if (typeof published === 'string' && typeof v[name] === 'string' && v[name] !== '')
          v[name] = {$secret: published};
        else h.secret(v, name, `${at}.${name}`);
      }
    else if ((k === 'connection' || k === 'secret') && typeof v?.id === 'string')
      v.id = h.ref(v.id, k === 'connection' ? 'wilma-connections' : 'wilma-secrets', `${at}.id`, ['id']);
    else if (k === 'secretId' && typeof v === 'string') value[k] = h.ref(v, 'wilma-secrets', at, ['id']);
    else if (k === 'mcpToolId' && typeof v === 'string') value[k] = h.ref(v, 'wilma-tools', at, ['id']);
    else handlerRefs(v, at, h, twin?.[k]);
  }
}
// What handlerRefs points at (the `refers` of tools and connectors).
const HANDLER_REFERS = ['wilma-connections', 'wilma-secrets', 'wilma-tools'];
// The custom headers of a tool or a connector (in a draft, those the published definition lacks): without a value
// the object is skipped.
const HEADERS = [{path: /customHeaders\./, empty: 'skip'}];

// What an agent or a skill can do: a capability is a union ({<type>: {…}}), in an agent's engine.ai.capabilities and
// workflow steps and in a skill's tools. Each type points at its own kind; a version pin (toolVersion, agentVersion)
// is kept only when it is the latest published version of what it points at (else dropped with a warning).
export const pin = (c, field, target, ref, at, h) => {
  if (c[field] === undefined || c[field] === null || c[field] === '' || typeof ref?.$ref !== 'string') return;
  const v = h.version(target, ref.$ref.slice(target.length + 1), c[field], `${at}.${field}`);
  if (v === undefined) delete c[field];
  else c[field] = v;
};
// c[field], an id of an object of `target`: a $ref (a value pointing at nothing is kept, noted unresolved).
export const refAt = (c, field, target, at, h, order = ['id']) => {
  if (typeof c[field] === 'string') c[field] = h.ref(c[field], target, `${at}.${field}`, order);
};
// The value of every sandbox environment variable is a secret ($secret at its path).
function envSecrets(value, at, h) {
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    const where = Array.isArray(value) ? `${at}[${k}]` : `${at}.${k}`;
    if (k !== 'env' || !Array.isArray(v)) envSecrets(v, where, h);
    else for (const [i, e] of v.entries()) if (PLAIN(e)) h.secret(e, 'value', `${where}[${i}].value`);
  }
}
// A transfer (a capability, or the target a voice call goes to after a silence or its maximum duration) goes to a
// dialplan of the PBX by name; an extension means the same on any PBX (a soft need).
export function transferRefs(c, at, h) {
  if (!PLAIN(c)) return;
  refAt(c, 'context', 'dialplans', at, h, ['name']);
  if (typeof c.extension === 'string' && c.extension !== '') h.soft(`users/${c.extension}`);
}
// What the capabilities and the access of an agent or a skill point at (capabilityRefs, accessRefs): the `refers` of
// skills, and of agents with what else they name.
export const CAPABILITY_REFERS = [
  'wilma-tools',
  'wilma-connectors',
  'kb-bases',
  'wilma-agents',
  'xbees-services',
  'dialplans',
  'xbees-users',
  'acl-groups',
];
const CAPABILITIES = {
  tool(c, at, h) {
    refAt(c, 'id', 'wilma-tools', at, h);
    pin(c, 'toolVersion', 'wilma-tools', c.id, at, h);
  },
  connector: (c, at, h) => refAt(c, 'id', 'wilma-connectors', at, h),
  kb: (c, at, h) => refAt(c, 'knowledgeBaseId', 'kb-bases', at, h),
  agent(c, at, h) {
    refAt(c, 'agentId', 'wilma-agents', at, h);
    pin(c, 'agentVersion', 'wilma-agents', c.agentId, at, h);
    accessRefs(c.access, `${at}.access`, h);
  },
  handover(c, at, h) {
    refAt(c, 'agent', 'wilma-agents', at, h);
    pin(c, 'agentVersion', 'wilma-agents', c.agent, at, h);
    refAt(c, 'service', 'xbees-services', at, h);
  },
  delegation(c, at, h) {
    refAt(c, 'id', 'wilma-agents', at, h);
    pin(c, 'agentVersion', 'wilma-agents', c.id, at, h);
  },
  transfer: (c, at, h) => transferRefs(c, at, h),
  // A snapshot is an image of the sandbox service of the source company: kept as it is, noted.
  sandbox(c, at, h) {
    if (typeof c.snapshot?.snapshotId === 'string') h.unresolved(`${at}.snapshot.snapshotId`, c.snapshot.snapshotId);
    envSecrets(c, at, h);
  },
};
// The capabilities anywhere in `value` (a list of them, a workflow and its steps): every object holding a capability
// type is a capability; anything else is walked.
export function capabilityRefs(value, at, h) {
  if (Array.isArray(value)) for (const [i, v] of value.entries()) capabilityRefs(v, `${at}[${i}]`, h);
  if (!PLAIN(value)) return;
  const types = Object.keys(value).filter((k) => Object.hasOwn(CAPABILITIES, k) && PLAIN(value[k]));
  if (types.length) for (const k of types) CAPABILITIES[k](value[k], `${at}.${k}`, h);
  else for (const [k, v] of Object.entries(value)) capabilityRefs(v, `${at}.${k}`, h);
}

// Who may use an agent (access.grants) or edit and see a skill (access.editors, viewers): a user of x-bees by id
// (found by e-mail on the target), an ACL group of the PBX by id (by name on the target); a department is a name. An
// entry that is no user or group of the source (a user of another company, a group deleted) is dropped with a
// warning: written as it is, its id could name someone else on the target.
const GRANTS = ['grants', 'editors', 'viewers'];
const MEMBERS = [
  ['userId', 'xbees-users', ['id']],
  ['groupId', 'acl-groups', ['id', 'name']],
];
export const DROPPED = 'is not a user or group of the source, dropped';
export function accessRefs(access, at, h) {
  if (!PLAIN(access)) return;
  for (const list of GRANTS) {
    if (!Array.isArray(access[list])) continue;
    access[list] = access[list].filter((g, i) => {
      if (!PLAIN(g)) return true;
      for (const [field, target, order] of MEMBERS) {
        if (typeof g[field] !== 'string') continue;
        const where = `${at}.${list}[${i}].${field}`;
        const ref = h.ref(g[field], target, where, order, 'drop');
        if (ref === undefined) {
          h.warn(where, `${g[field]} ${DROPPED}`);
          return false;
        }
        g[field] = ref;
      }
      return true;
    });
  }
}
// The ids of the x-bees users an object grants something to (what the source reads of xbees-users).
export function userIdsOf(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) userIdsOf(v, out);
  else if (PLAIN(value))
    for (const [k, v] of Object.entries(value)) {
      if (GRANTS.includes(k) && Array.isArray(v))
        for (const g of v) if (typeof g?.userId === 'string') out.add(g.userId);
      userIdsOf(v, out);
    }
  return out;
}

// A secret of the draft at the same place as one of the published definition is that secret: one value asked, used
// for both (the draft's own secrets keep their draft.… path).
export function draftSecretsShared(data) {
  if (!PLAIN(data.draft)) return;
  const published = new Set();
  const collect = (v) => {
    if (PLAIN(v) && typeof v.$secret === 'string') published.add(v.$secret);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
  };
  for (const [k, v] of Object.entries(data)) if (k !== 'draft') collect(v);
  const share = (v) => {
    if (PLAIN(v) && typeof v.$secret === 'string') {
      if (v.$secret.startsWith('draft.') && published.has(v.$secret.slice(6))) v.$secret = v.$secret.slice(6);
    } else if (v && typeof v === 'object') for (const x of Object.values(v)) share(x);
  };
  share(data.draft);
}

// Skill files. In an export each file is a marker {$file, sha256, path, name?, executable?}: its bytes are at $file in
// the folder (files/wilma-skills/<skill>/<path>; a draft's file that differs from the published one at
// <skill>@draft/<path>). The folder of a skill is its name with what a file name cannot hold (and % and @) as %XX and
// a leading dot as %2E: two skills never share one.
const hex = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
const folderOf = (name) =>
  `files/wilma-skills/${String(name)
    .replace(/[%@/\\:*?"<>|\p{Cc}]/gu, hex)
    .replace(/^\./, '%2E')}`;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function download(client, skill, f) {
  const link = await client.call('GET', apiPath`/v2/skills/files/items/${f.id}/download`);
  if (!link?.url) throw new Error(`no download link for ${f.path} of the skill ${skill}`);
  const res = await client.raw('GET', link.url);
  if (!res.ok) throw new Error(`the download of ${f.path} of the skill ${skill} failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// The skills with their files as markers; `files` holds the bytes ({[$file]: Buffer}), `value.files` the files of
// the skill on this company ({id, path, sha256}): on the target, what an import does not upload again.
async function readSkills(client) {
  const objects = await readVersioned(client, KINDS.skills);
  const bytesOf = new Map(); // file id → bytes: each content downloaded once
  for (const o of objects) {
    const dir = folderOf(o.name);
    const files = {};
    const known = [];
    const markers = async (list, at, twin = []) => {
      if (!Array.isArray(list)) return list;
      const out = [];
      for (const f of list) {
        if (!isSkillFilePath(f?.path)) throw new Error(`${o.name}: Not a path of a skill file: ${f?.path}`);
        if (!bytesOf.has(f.id)) bytesOf.set(f.id, await download(client, o.name, f));
        const bytes = bytesOf.get(f.id);
        const hash = sha256(bytes);
        const same = twin.find((m) => m.path === f.path && m.sha256 === hash);
        const $file = same?.$file ?? `${at}/${f.path}`;
        files[$file] = bytes;
        known.push({id: String(f.id), path: f.path, sha256: hash});
        out.push({
          $file,
          sha256: hash,
          path: f.path,
          ...(f.name !== undefined ? {name: f.name} : {}),
          ...(f.executable !== undefined ? {executable: f.executable} : {}),
        });
      }
      return out;
    };
    if (o.data.files) o.data.files = await markers(o.data.files, dir);
    if (o.data.draft?.files) o.data.draft.files = await markers(o.data.draft.files, `${dir}@draft`, o.data.files);
    if (Object.keys(files).length) o.files = files;
    o.value = {files: known};
  }
  return objects;
}

// Each file is uploaded (POST /v2/skills/files, then the bytes to the presigned link) before the skill is written,
// unless the target's skill has a file at that path with the same sha256; the ids go into files[].
const writeVersionedSkill = versionedWrite(KINDS.skills);
async function writeSkill(client, item, data, opts) {
  const {existing, resolve} = opts;
  const at = existing === undefined ? {} : {id: String(existing)};
  const theirs =
    existing === undefined ? [] : (resolve?.({kind: item.kind, name: item.name, as: 'object'})?.files ?? []);
  const ids = new Map(); // $file → the id of its content on the target
  let uploaded = 0;
  for (const m of [...(data.files ?? []), ...(data.draft?.files ?? [])]) {
    if (typeof m?.$file !== 'string' || ids.has(m.$file)) continue;
    if (!isSkillFilePath(m.path)) throw new StageError('upload', `not a path of a skill file: ${m.path}`, at);
    const same = theirs.find((f) => f.path === m.path && f.sha256 === m.sha256);
    if (same) {
      ids.set(m.$file, same.id);
      continue;
    }
    const bytes = item.files?.[m.$file];
    if (!bytes) throw new StageError('upload', `no bytes for ${m.$file}`, at);
    let link;
    let res;
    try {
      const name = m.name ?? path.posix.basename(m.path);
      link = await client.call('POST', '/v2/skills/files', {json: {name, size: bytes.length}});
      if (!link?.fileId || !link?.uploadUrl) throw new StageError('upload', 'upload answered no link', at);
      res = await client.raw('PUT', link.uploadUrl, {body: bytes});
    } catch (e) {
      throw e instanceof StageError ? e : stageFailure('upload', e, existing);
    }
    if (!res.ok) throw new StageError('upload', `upload was refused (HTTP ${res.status})`, at);
    ids.set(m.$file, String(link.fileId));
    uploaded += 1;
  }
  const withIds = (list) =>
    list?.map((f) =>
      typeof f?.$file === 'string'
        ? {
            id: ids.get(f.$file),
            path: f.path,
            ...(f.name !== undefined ? {name: f.name} : {}),
            ...(f.executable !== undefined ? {executable: f.executable} : {}),
          }
        : f,
    );
  const body = {...data, ...(data.files ? {files: withIds(data.files)} : {})};
  if (data.draft) body.draft = {...data.draft, ...(data.draft.files ? {files: withIds(data.draft.files)} : {})};
  const answer = await writeVersionedSkill(client, item, body, opts);
  return {...answer, steps: [...(uploaded ? [`upload ${uploaded}`] : []), ...answer.steps]};
}

export const WILMA_KINDS = {
  // Connectors have no versions: edited in place (PUT with the revision read).
  'wilma-connectors': {
    group: 'wilma',
    label: 'Wilma connector',
    side: 'cloud',
    service: 'wilma',
    refers: HANDLER_REFERS,
    nameField: 'name',
    secrets: HEADERS,
    async read(client) {
      return (await listOf(client, KINDS.connectors)).map((c) => ({
        id: String(c.id),
        name: String(c.name),
        data: pickFields(c, KINDS.connectors.createFields),
      }));
    },
    // The definition ({key, version}) names a catalog entry, the same on every company: kept as it is.
    portable(data, h) {
      for (const k of ['configuration', 'authorization']) handlerRefs(data[k], k, h);
    },
    write: versionedWrite(KINDS.connectors),
  },

  // Tools: published and draft. An MCP tool runs on another tool (its MCP server), written before it.
  'wilma-tools': {
    group: 'wilma',
    label: 'Wilma tool',
    side: 'cloud',
    service: 'wilma',
    refers: HANDLER_REFERS,
    nameField: 'name',
    secrets: HEADERS,
    read: (client) => readVersioned(client, KINDS.tools),
    portable(data, h) {
      handlerRefs(data.handler, 'handler', h);
      if (data.draft) handlerRefs(data.draft.handler, 'draft.handler', h, data.handler);
    },
    write: versionedWrite(KINDS.tools),
  },

  // Skills: published and draft, with their files. A skill's tools are capabilities (the shapes of an agent's).
  'wilma-skills': {
    group: 'wilma',
    label: 'Wilma skill',
    side: 'cloud',
    service: 'wilma',
    refers: CAPABILITY_REFERS,
    nameField: 'name',
    // The value of a sandbox environment variable of its tools: without one the skill is skipped (as an agent).
    secrets: [{path: /\.env\[\d+\]\.value$/, empty: 'skip'}],
    read: readSkills,
    portable(data, h) {
      for (const [def, prefix] of [
        [data, ''],
        [data.draft, 'draft.'],
      ]) {
        if (!PLAIN(def)) continue;
        capabilityRefs(def.tools, `${prefix}tools`, h);
        accessRefs(def.access, `${prefix}access`, h);
      }
      draftSecretsShared(data);
    },
    write: writeSkill,
    userIds: (data) => [...userIdsOf(data)],
  },
};
