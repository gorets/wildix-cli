// The knowledge base kinds of the config transfer: data sources and the knowledge bases built from them. Paths and
// fields as `wx-admin kb` uses them (src/commands/kb.mjs): a data source has {name, description, type, config,
// syncSchedule}, its config is {<type>: {...}}; a knowledge base {name, description, dataSources: [source id]}.
// The Confluence API token is write-only on the target: it travels as {$secret: 'config.confluence.apiKey'}. A
// Google Drive source is a Nango connection of the source company: it is bound, never carried.
import {apiPath} from 'wldx-core/http';
import {StageError} from '../stage-error.mjs';

const V1 = '/api/v1';
const SECRET_PATH = 'config.confluence.apiKey';
const NANGO_PATH = 'config.gdrive.nangoConnectionId';
const present = (v) => v !== undefined && v !== null && v !== '';
const filled = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => present(v)));
const dsPath = (id) => `${V1}${apiPath`/data-sources/${id}`}`;
const kbPath = (id) => `${V1}${apiPath`/knowledge-bases/${id}`}`;

// What a source's config keeps: the fields configure takes, no ids, status or sync state.
const KEEP = {
  confluence: ['baseUrl', 'username', 'spaceId', 'apiKey', 'pages'],
  website: ['urls', 'pages'],
  gdrive: ['nangoConnectionId', 'folders'],
  files: [],
};
function portableConfig(type, config) {
  const inner = config?.[type];
  if (!inner || typeof inner !== 'object' || !KEEP[type])
    return config && Object.keys(config).length ? config : undefined;
  const kept = filled(Object.fromEntries(KEEP[type].filter((k) => k in inner).map((k) => [k, inner[k]])));
  return {[type]: kept};
}

// The failure of a step, told by its HTTP status only: the answer of the service may echo the request body.
const stageMessage = (stage, e) => `${stage} was refused${e?.status ? ` (HTTP ${e.status})` : ''}`;

export const KB_KINDS = {
  'kb-sources': {
    group: 'kb',
    label: 'KB data source',
    side: 'cloud',
    service: 'kb',
    refers: [],
    nameField: 'name',
    immutable: ['type'],
    secrets: [{path: SECRET_PATH, empty: 'unconfigured'}],
    async read(client) {
      const list = (await client.call('GET', `${V1}/data-sources`))?.dataSources ?? [];
      return list
        .filter((s) => present(s.name))
        .map((s) => ({
          id: String(s.id),
          name: String(s.name),
          data: filled({
            name: s.name,
            type: s.type,
            description: s.description,
            config: portableConfig(s.type, s.config),
            syncSchedule: s.syncSchedule,
          }),
        }));
    },
    portable(data, h) {
      const c = data.config;
      if (c?.confluence) h.secret(c.confluence, 'apiKey', SECRET_PATH);
      if (c?.gdrive && present(c.gdrive.nangoConnectionId)) {
        delete c.gdrive.nangoConnectionId; // never exported
        h.bound(NANGO_PATH, 'nango');
        h.warn(NANGO_PATH, 'a Google Drive source is a Nango connection of the source company: connect it again');
      }
      if (data.type === 'files') h.warn('type', 'documents are not carried: upload them again');
    },
    // New: create, then configure (not without a Confluence key). Existing: configure only.
    async write(client, item, data, {existing}) {
      const {config, syncSchedule} = data;
      const configurable = data.type !== 'confluence' || present(config?.confluence?.apiKey);
      const configure = async (id) => {
        try {
          await client.call('PUT', `${dsPath(id)}/configure`, {
            json: {config: config ?? {[data.type]: {}}, ...(present(syncSchedule) ? {syncSchedule} : {})},
          });
        } catch (e) {
          throw new StageError('configure', stageMessage('configure', e), {id});
        }
      };
      const skipped = 'not configured: no API token';
      if (existing !== undefined) {
        try {
          await client.call('PUT', dsPath(existing), {json: {name: data.name, description: data.description ?? ''}});
        } catch (e) {
          throw new StageError('update', stageMessage('update', e), {id: existing});
        }
        if (!configurable)
          return {
            id: String(existing),
            steps: ['update', skipped],
            notes: ['configuration not changed: no API token given'],
          };
        await configure(existing);
        return {id: String(existing), steps: ['update', 'configure']};
      }
      const r = await client.call('POST', `${V1}/data-sources`, {
        json: {name: data.name, description: data.description ?? '', type: data.type},
      });
      const id = r?.dataSource?.id;
      if (id === undefined)
        throw new Error(`The knowledge base service did not answer the id of the new source ${item.name}`);
      if (!configurable) return {id: String(id), steps: ['create', skipped]};
      await configure(id);
      return {id: String(id), steps: ['create', 'configure']};
    },
  },

  'kb-bases': {
    group: 'kb',
    label: 'knowledge base',
    side: 'cloud',
    service: 'kb',
    refers: ['kb-sources'],
    nameField: 'name',
    async read(client) {
      const list = (await client.call('GET', `${V1}/knowledge-bases`))?.knowledgeBases ?? [];
      return list
        .filter((k) => present(k.name))
        .map((k) => ({
          id: String(k.id),
          name: String(k.name),
          data: {name: k.name, description: k.description ?? '', dataSources: [...(k.dataSources ?? [])]},
        }));
    },
    portable(data, h) {
      data.dataSources = (data.dataSources ?? []).map((id, i) => h.ref(id, 'kb-sources', `dataSources[${i}]`, ['id']));
    },
    async create(client, data) {
      const r = await client.call('POST', `${V1}/knowledge-bases`, {json: data});
      const id = r?.knowledgeBase?.id;
      if (id === undefined) throw new Error(`The knowledge base service did not answer the id of ${data.name}`);
      return String(id);
    },
    async update(client, id, data) {
      await client.call('PUT', kbPath(id), {json: data});
    },
  },
};
