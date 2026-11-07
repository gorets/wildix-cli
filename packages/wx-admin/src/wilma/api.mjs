// The Wilma layer of wx-admin: the client (the CPA token of the PBX, see ../cloud), the kinds of objects with their
// paths and the fields their create takes, paged lists, finding an object by id or name, who uses an object.
// Paths and shapes: the wilma-<area> OpenAPI of docs.wildix.com (agents, skills, tools, secrets, audit, traces).
import {UsageError} from 'wldx-core/errors';
import {apiPath} from 'wldx-core/http';
import {cloudClient} from '../cloud/client.mjs';
import {maskCloud} from '../cloud/mask.mjs';
import {pickByName} from '../match.mjs';

export const wilmaClient = (ctx) => cloudClient(ctx, 'wilma');
export const masked = (ctx, data) => (ctx.values['show-secrets'] ? data : maskCloud(data));
export const SHOW_SECRETS = {
  'show-secrets': {type: 'boolean', description: 'show keys, tokens and passwords in the answer (masked otherwise)'},
};

// The kinds of objects. `item(id)` is the path of one; `createFields` what its create takes (an update takes them
// and the `revision` read); `versioned`: a draft and published versions.
export const KINDS = {
  agents: {
    noun: 'agent',
    base: '/v2/agents/agents',
    item: (id) => apiPath`/v2/agents/agents/${id}`,
    listKey: 'agents',
    uri: 'agents',
    itemKey: 'agent',
    createFields: ['name', 'description', 'category', 'picture', 'channels', 'engine', 'settings', 'access'],
    versioned: true,
  },
  skills: {
    noun: 'skill',
    base: '/v2/skills',
    item: (id) => apiPath`/v2/skills/items/${id}`,
    listKey: 'skills',
    uri: 'skills',
    itemKey: 'skill',
    createFields: ['name', 'description', 'content', 'tools', 'files', 'access'],
    versioned: true,
  },
  tools: {
    noun: 'tool',
    base: '/v2/tools',
    item: (id) => apiPath`/v2/tools/items/${id}`,
    listKey: 'tools',
    uri: 'tools',
    itemKey: 'tool',
    createFields: ['name', 'category', 'description', 'input', 'handler'],
    versioned: true,
  },
  connectors: {
    noun: 'connector',
    base: '/v2/tools/connectors',
    item: (id) => apiPath`/v2/tools/connectors/items/${id}`,
    listKey: 'connectors',
    uri: 'tools/connectors',
    itemKey: 'connector',
    createFields: ['definition', 'configuration', 'authorization', 'name', 'description', 'grant'],
  },
  secrets: {
    noun: 'secret',
    base: '/v2/secrets',
    item: (id) => apiPath`/v2/secrets/items/${id}`,
    listKey: 'secrets',
    itemKey: 'secret',
  },
  connections: {
    noun: 'connection',
    base: '/v2/secrets/connections',
    item: (id) => apiPath`/v2/secrets/connections/${id}`,
    listKey: 'connections',
    uri: 'secrets/connections',
    itemKey: 'connection',
  },
};
for (const [key, kind] of Object.entries(KINDS)) {
  kind.key = key;
  kind.hint = `wx-admin wilma ${kind.noun} list`;
}

const PAGE = 100;
const MAX_PAGES = 50;

// Every item of a paged list (`limit` + `cursor` in, `nextCursor` out), at most `max` of them.
export async function listAll(client, path, key, params = {}, {max = Number.POSITIVE_INFINITY} = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES && items.length < max; page++) {
    const limit = Math.min(PAGE, max - items.length);
    const answer = (await client.call('GET', path, {query: {...params, limit, cursor}})) ?? {};
    items.push(...(answer[key] ?? []));
    cursor = answer.nextCursor;
    if (!cursor) break;
  }
  return items;
}

export const listOf = (client, kind, params) => listAll(client, kind.base, kind.listKey, params);

// An object of a kind by id or name: the id first, else the exact name, else the name without case; a name several
// objects share is an error that lists their ids.
export async function findObject(client, kind, ref) {
  const list = await listOf(client, kind);
  return list.find((x) => x.id === String(ref)) ?? pickByName(list, ref, (x) => x.name, kind.noun, kind.hint);
}

export async function getObject(client, kind, id) {
  return (await client.call('GET', kind.item(id)))?.[kind.itemKey];
}

// A published version: {<noun>Id, version, name?, changelog, definition, publishedAt, publishedBy}.
export async function getVersion(client, kind, id, version) {
  return (await client.call('GET', `${kind.item(id)}${apiPath`/versions/${version}`}`))?.version;
}

// The URI of an object in the audit log and its references (wilma://tools/connectors/<id> for a connector); a secret
// has none we know of.
export const uriOf = (kind, id) => `wilma://${kind.uri}/${id}`;

// Who uses an object (agents that use a skill or a tool, their draft too): one entry per user, the draft folded in.
export async function usedBy(client, uri) {
  const refs = await listAll(client, '/v2/audit/references', 'references', {uri});
  const seen = new Map();
  for (const r of refs) {
    const base = String(r.uri).replace(/\?draft$/, '');
    if (!seen.has(base)) seen.set(base, {label: String(r.label ?? '').replace(/ \(Draft\)$/, ''), uri: base});
  }
  return [...seen.values()];
}

// The fields of `obj` named in `fields`, those it has.
export const pickFields = (obj, fields) =>
  Object.fromEntries(fields.filter((f) => obj?.[f] !== undefined).map((f) => [f, obj[f]]));

// A date option: YYYY-MM-DD or an ISO-8601 instant, passed on as it is.
export function dateOption(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value)))
    throw new UsageError(`--${name} is a date: YYYY-MM-DD or an ISO-8601 time such as 2026-11-08T10:00:00Z: ${value}`);
  return value;
}

// KEY=VALUE options, checked: [[key, value], …].
export function keyValues(list = [], name) {
  return list.map((item) => {
    const at = String(item).indexOf('=');
    if (at < 1) throw new UsageError(`--${name} is KEY=VALUE: ${item}`);
    return [item.slice(0, at), item.slice(at + 1)];
  });
}

// A whole number option within limits.
export function wholeNumber(value, name, {min = 1, max = Number.POSITIVE_INFINITY, fallback} = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < min || n > max)
    throw new UsageError(
      `--${name} is a whole number from ${min}${max < Number.POSITIVE_INFINITY ? ` to ${max}` : ''}: ${value}`,
    );
  return n;
}
