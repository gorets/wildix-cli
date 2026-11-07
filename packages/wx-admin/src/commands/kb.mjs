// wx-admin kb: the knowledge base of the Wildix cloud (WIM) for the company of the PBX, with the PBX's CPA token:
// knowledge bases, search and answers; data sources (kb source) and documents (kb doc). A knowledge base, a data
// source or a document is given by id or by exact name; a name several share asks for the id.
// Operations (the knowledge base service, https://kb.wim[-stage].wildix.com/api/v1):
//   ListKnowledgeBases, GetKnowledgeBase, CreateKnowledgeBase, UpdateKnowledgeBase, DeleteKnowledgeBase,
//   SearchKnowledgeBase, GenerateSearchAnswer, ListSearchQueriesHistory, ListHistoryStatistics;
//   ListDataSources, GetDataSource, CreateDataSource, ConfigureDataSource, DescribeDataSource, StartSyncDataSource,
//   StopSyncDataSource, GetDataSourceSyncStatus, ListDataSourceSynchronizationLogs, ListDataSourceStatistics,
//   CloneDataSource, CleanDataSource, DeleteDataSource
import {UsageError} from 'wldx-core/errors';
import {apiPath} from 'wldx-core/http';
import {localTime, oneLine, paint, table} from 'wldx-core/format';
import {readSecret} from 'wldx-core/secret';
import {cloudClient} from '../cloud/client.mjs';
import {operationsOf} from '../cloud/specs.mjs';
import {pickByName} from '../match.mjs';
import {maskSecrets} from './trunk.mjs';

const V1 = '/api/v1';
const kbClient = (ctx) => cloudClient(ctx, 'kb');
const masked = (ctx, data) => (ctx.values['show-secrets'] ? data : maskSecrets(data));
const SHOW = {
  'show-secrets': {type: 'boolean', description: 'show keys and tokens of data sources (masked otherwise)'},
};

const byIdOrName = (list, ref, noun, hint) =>
  list.find((x) => x.id === String(ref)) ?? pickByName(list, ref, (x) => x.name ?? x.title, noun, hint);

export async function listKbs(client) {
  return (await client.call('GET', `${V1}/knowledge-bases`))?.knowledgeBases ?? [];
}
export async function listSources(client) {
  return (await client.call('GET', `${V1}/data-sources`))?.dataSources ?? [];
}
export async function findKb(client, ref) {
  return byIdOrName(await listKbs(client), ref, 'knowledge base', 'wx-admin kb list');
}
export async function findSource(client, ref) {
  return byIdOrName(await listSources(client), ref, 'data source', 'wx-admin kb source list');
}
export async function findDoc(client, sourceId, ref) {
  const docs = [];
  for (let offset = 0; ; offset += 100) {
    const page =
      (await client.call('GET', `${V1}${apiPath`/data-sources/${sourceId}/documents`}`, {query: {limit: 100, offset}}))
        ?.documents ?? [];
    docs.push(...page);
    if (docs.some((d) => d.id === String(ref)) || page.length < 100) break;
  }
  return byIdOrName(docs, ref, 'document', `wx-admin kb doc list ${sourceId}`);
}

const kbPath = (id) => `${V1}${apiPath`/knowledge-bases/${id}`}`;
const sourceNames = (sources) => {
  const names = new Map(sources.map((s) => [s.id, s.name]));
  return (ids = []) => ids.map((i) => names.get(i) ?? i);
};
const kbLine = (k, names) =>
  `${k.name} (${k.id}) · ${names(k.dataSources).join(', ') || 'no sources'} · updated ${localTime(k.updatedAt)}`;
const resultLines = (results) =>
  results.map(
    (r) =>
      `${Number(r.score).toFixed(2)}  ${r.documentTitle}  ${r.documentUrl ?? ''}\n      ${oneLine(r.content, 160)}`,
  );

// What PUT takes: name, description, dataSources (all of them).
const kbBody = (k) => ({name: k.name, description: k.description ?? '', dataSources: k.dataSources ?? []});

export const kbCommands = {
  list: {
    summary: 'the knowledge bases of the company: name, data sources, last change',
    usage: 'wx-admin kb list',
    options: {},
    args: [0, 0],
    async run(ctx) {
      const client = await kbClient(ctx);
      const [kbs, sources] = [await listKbs(client), await listSources(client)];
      const names = sourceNames(sources);
      return {knowledgeBases: kbs.map((k) => ({...k, dataSourceNames: names(k.dataSources)}))};
    },
    text: (r) =>
      r.knowledgeBases.length ? r.knowledgeBases.map((k) => kbLine(k, () => k.dataSourceNames)) : 'No knowledge bases',
  },
  get: {
    summary: 'one knowledge base with its data sources by name',
    usage: 'wx-admin kb get <kb>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await kbClient(ctx);
      const k = (await client.call('GET', kbPath((await findKb(client, ctx.positionals[0])).id)))?.knowledgeBase;
      return {...k, dataSourceNames: sourceNames(await listSources(client))(k.dataSources)};
    },
    text: (k) =>
      table([
        ['Name', `${k.name} (${k.id})`],
        ['Description', k.description || ''],
        ['Sources', k.dataSourceNames.join(', ')],
        ['Updated', localTime(k.updatedAt)],
      ]),
  },
  create: {
    summary: 'create a knowledge base from data sources',
    usage: 'wx-admin kb create <name> --source DS... [--description TEXT]',
    options: {
      source: {type: 'string', multiple: true, placeholder: 'DS', description: 'a data source (id or name)'},
      description: {type: 'string', placeholder: 'TEXT', description: 'the description'},
    },
    args: [1, 1],
    async run(ctx) {
      if (!ctx.values.source?.length) throw new UsageError('Give its data sources: --source DS', ctx.usage());
      const client = await kbClient(ctx);
      const sources = await listSources(client);
      const ids = ctx.values.source.map((s) => byIdOrName(sources, s, 'data source', 'wx-admin kb source list').id);
      const body = {name: ctx.positionals[0], description: ctx.values.description ?? '', dataSources: ids};
      return (await client.call('POST', `${V1}/knowledge-bases`, {json: body}))?.knowledgeBase ?? body;
    },
    text: (k) => `Created the knowledge base ${k.name}${k.id ? ` (${k.id})` : ''}`,
  },
  update: {
    summary: 'change a knowledge base: name, description, data sources (--source replaces them: needs --yes)',
    usage: 'wx-admin kb update <kb> [--name NAME] [--description TEXT] [--source DS]... [--yes]',
    options: {
      name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
      description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
      source: {type: 'string', multiple: true, placeholder: 'DS', description: 'its data sources (replaces them all)'},
      yes: {type: 'boolean', description: 'yes, replace the data sources'},
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      if (v.name === undefined && v.description === undefined && !v.source)
        throw new UsageError('Nothing to change: give --name, --description or --source', ctx.usage());
      if (v.source && !v.yes)
        throw new UsageError(
          '--source replaces every data source of the knowledge base: confirm with --yes',
          ctx.usage(),
        );
      const client = await kbClient(ctx);
      const k = await findKb(client, ctx.positionals[0]);
      const body = kbBody(k);
      if (v.name !== undefined) body.name = v.name;
      if (v.description !== undefined) body.description = v.description;
      if (v.source) {
        const sources = await listSources(client);
        body.dataSources = v.source.map((s) => byIdOrName(sources, s, 'data source', 'wx-admin kb source list').id);
      }
      return (await client.call('PUT', kbPath(k.id), {json: body}))?.knowledgeBase ?? {...k, ...body};
    },
    text: (k) => `Updated the knowledge base ${k.name} (${k.id})`,
  },
  delete: {
    summary: 'delete knowledge bases (needs --yes; their data sources stay)',
    usage: 'wx-admin kb delete <kb>... --yes',
    options: {yes: {type: 'boolean', description: 'yes, delete them'}},
    args: [1, 50],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError('Deleting a knowledge base cannot be undone: confirm with --yes', ctx.usage());
      const client = await kbClient(ctx);
      const found = [];
      for (const ref of ctx.positionals) found.push(await findKb(client, ref));
      for (const k of found) await client.call('DELETE', kbPath(k.id));
      return {deleted: found.map(({id, name}) => ({id, name}))};
    },
    text: (r) => `Deleted ${r.deleted.map((k) => `${k.name} (${k.id})`).join(', ')}`,
  },
  search: {
    summary: 'search a knowledge base: the chunks found, with their document and score',
    usage: 'wx-admin kb search <kb> <query> [--limit N]',
    options: {limit: {type: 'string', placeholder: 'N', description: 'at most N chunks (default 5)'}},
    args: [2, 2],
    async run(ctx) {
      const limit = Number(ctx.values.limit ?? 5);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit is a whole number: ${ctx.values.limit}`);
      const client = await kbClient(ctx);
      const k = await findKb(client, ctx.positionals[0]);
      return client.call('POST', `${kbPath(k.id)}/search`, {json: {query: ctx.positionals[1], searchLimit: limit}});
    },
    text: (r) => (r?.results?.length ? resultLines(r.results) : 'Nothing found'),
  },
  ask: {
    summary: 'an answer from knowledge bases: search each, then generate the answer from what was found',
    usage: 'wx-admin kb ask <query> --kb KB... [--limit N] [--model MODEL]',
    options: {
      kb: {type: 'string', multiple: true, placeholder: 'KB', description: 'a knowledge base to search (id or name)'},
      limit: {type: 'string', placeholder: 'N', description: 'the chunks the answer is made from (default 5)'},
      model: {type: 'string', placeholder: 'MODEL', description: "the model of the answer (default: the service's)"},
    },
    args: [1, 1],
    async run(ctx) {
      if (!ctx.values.kb?.length) throw new UsageError('Give the knowledge bases: --kb KB', ctx.usage());
      const limit = Number(ctx.values.limit ?? 5);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit is a whole number: ${ctx.values.limit}`);
      const query = ctx.positionals[0];
      const client = await kbClient(ctx);
      const kbs = await listKbs(client);
      const results = [];
      for (const ref of ctx.values.kb) {
        const k = byIdOrName(kbs, ref, 'knowledge base', 'wx-admin kb list');
        const r = await client.call('POST', `${kbPath(k.id)}/search`, {json: {query, searchLimit: limit}});
        results.push(...(r?.results ?? []));
      }
      const best = results.sort((a, b) => b.score - a.score).slice(0, limit);
      const body = {searchQuery: query, searchResults: best, ...(ctx.values.model ? {model: ctx.values.model} : {})};
      return client.call('POST', `${V1}/knowledge-bases/generate-answer`, {json: body});
    },
    text(r, ctx) {
      const c = paint(ctx);
      const m = r.metadata ?? {};
      return [
        r.answer,
        '',
        'Sources:',
        ...(r.sources ?? []).map((s) => `  ${s.documentTitle}  ${s.documentUrl ?? ''}`),
        c.dim(`${m.model ?? ''} · ${m.inputTokens ?? '?'} in, ${m.outputTokens ?? '?'} out · ${m.duration ?? '?'} ms`),
      ];
    },
  },
  history: {
    summary: 'the search queries made on the knowledge bases',
    usage: 'wx-admin kb history [--limit N]',
    options: {limit: {type: 'string', placeholder: 'N', description: 'at most N queries'}},
    args: [0, 0],
    async run(ctx) {
      const client = await kbClient(ctx);
      return client.call('POST', `${V1}/knowledge-bases/history/search-queries`, {
        query: {limit: ctx.values.limit},
        json: {},
      });
    },
  },
  stats: {
    summary: 'statistics of the searches on the knowledge bases',
    usage: 'wx-admin kb stats',
    options: {},
    args: [0, 0],
    async run(ctx) {
      return (await kbClient(ctx)).call('POST', `${V1}/knowledge-bases/history/statistics`, {json: {}});
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Data sources

const dsPath = (id) => `${V1}${apiPath`/data-sources/${id}`}`;
const enumOf = (op, prop, fallback) => {
  const p = operationsOf('kb').get(op)?.schema?.properties?.[prop];
  return p?.enum ?? p?.allOf?.find((x) => x.enum)?.enum ?? fallback;
};
const SCHEDULES = enumOf('ConfigureDataSource', 'syncSchedule', [
  'DISABLED',
  'EVERY_SIX_HOURS',
  'EVERY_TWELVE_HOURS',
  'EVERY_DAY',
  'EVERY_WEEK',
]);
const TYPES = ['confluence', 'website', 'files'];
const LEVELS = ['debug', 'info', 'warn', 'error'];
const RUNNING = /run|sync|progress|pend|queue|start/i;
const sourceLine = (d) => `${d.name} (${d.id}) · ${d.type} · ${d.syncSchedule ?? ''}`;
const whole = (v, name) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(String(v))) throw new UsageError(`--${name} is a whole number: ${v}`);
  return Number(v);
};
const statusLine = (r) =>
  `${r.status}${r.mode ? ` (${r.mode})` : ''} · ${
    Object.entries(r.documentsStats ?? {})
      .map(([k, n]) => `${n} ${k}`)
      .join(', ') || 'no documents'
  }${r.syncedAt ? ` · synced ${localTime(r.syncedAt)}` : ''}${r.error ? ` · ${r.error}` : ''}`;

export const sourceCommands = {
  list: {
    summary: 'the data sources: type, schedule (keys masked)',
    usage: 'wx-admin kb source list [--show-secrets]',
    options: {...SHOW},
    args: [0, 0],
    async run(ctx) {
      return masked(ctx, {dataSources: await listSources(await kbClient(ctx))});
    },
    text: (r) => (r.dataSources.length ? r.dataSources.map(sourceLine) : 'No data sources'),
  },
  get: {
    summary: 'one data source with its configuration and sync status (keys masked)',
    usage: 'wx-admin kb source get <ds> [--show-secrets]',
    options: {...SHOW},
    args: [1, 1],
    async run(ctx) {
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      const full = (await client.call('GET', dsPath(d.id)))?.dataSource ?? d;
      const syncStatus = await client.call('GET', `${dsPath(d.id)}/sync-status`);
      return masked(ctx, {...full, syncStatus});
    },
    text: (r) => [
      sourceLine(r),
      `  sync: ${statusLine(r.syncStatus ?? {})}`,
      ...JSON.stringify(r.config ?? {}, null, 2)
        .split('\n')
        .map((l) => `  ${l}`),
    ],
  },
  create: {
    summary: 'create a data source (then: kb source configure, kb source sync)',
    usage: 'wx-admin kb source create <name> --type confluence|website|files [--description TEXT]',
    details:
      'Google Drive is connected with OAuth in a browser: connect it in the WIM console; wx-admin then lists, syncs and deletes it.',
    options: {
      type: {type: 'string', choices: [...TYPES, 'gdrive'], description: 'the kind of source'},
      description: {type: 'string', placeholder: 'TEXT', description: 'the description'},
    },
    args: [1, 1],
    async run(ctx) {
      const type = ctx.values.type;
      if (!type) throw new UsageError('--type is needed', ctx.usage());
      if (type === 'gdrive')
        throw new UsageError(
          'Google Drive is connected with OAuth in a browser: connect it in the WIM console, then wx-admin kb source sync',
        );
      const body = {name: ctx.positionals[0], description: ctx.values.description ?? '', type};
      return (await (await kbClient(ctx)).call('POST', `${V1}/data-sources`, {json: body}))?.dataSource ?? body;
    },
    text: (d) =>
      `Created the data source ${d.name}${d.id ? ` (${d.id})` : ''}: next, wx-admin kb source configure ${d.id ?? d.name}`,
  },
  configure: {
    summary:
      'configure a data source: Confluence (address, user, space, pages; the API token typed hidden), website, schedule',
    usage:
      'wx-admin kb source configure <ds> [--url URL]... [--user EMAIL] [--space ID] [--page ID]... [--schedule SCHEDULE]',
    details: [
      'Confluence: --url (https://<site>.atlassian.net), --user, --space, --page (replaces the pages); the API token is',
      'asked hidden (or read from stdin) when the source has none or --url or --user change. Website: --url (repeatable).',
      `Schedule: ${SCHEDULES.join(', ')}.`,
    ].join('\n'),
    options: {
      url: {
        type: 'string',
        multiple: true,
        placeholder: 'URL',
        description: 'the Confluence address, or the website(s)',
      },
      user: {type: 'string', placeholder: 'EMAIL', description: 'the Confluence user of the API token'},
      space: {type: 'string', placeholder: 'ID', description: 'the Confluence space (kb source browse lists them)'},
      page: {
        type: 'string',
        multiple: true,
        placeholder: 'ID',
        description: 'a Confluence or website page to sync (replaces them)',
      },
      schedule: {type: 'string', choices: SCHEDULES, description: 'how often it syncs'},
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      const full = (await client.call('GET', dsPath(d.id)))?.dataSource ?? d;
      let config;
      if (full.type === 'confluence') {
        const c = {...(full.config?.confluence ?? {})};
        const needKey = !c.apiKey || v.url !== undefined || v.user !== undefined;
        if (v.url) c.baseUrl = v.url[0];
        if (v.user !== undefined) c.username = v.user;
        if (v.space !== undefined) c.spaceId = v.space;
        if (v.page) c.pages = {enabled: v.page, disabled: c.pages?.disabled ?? []};
        for (const k of ['baseUrl', 'username', 'spaceId'])
          if (!c[k])
            throw new UsageError(
              `A Confluence source needs ${{baseUrl: '--url', username: '--user', spaceId: '--space'}[k]}`,
              ctx.usage(),
            );
        if (needKey) {
          c.apiKey = await readSecret(ctx, `Confluence API token of ${c.username}: `);
          if (!c.apiKey) throw new UsageError('No API token given: nothing was changed');
        }
        config = {confluence: c};
      } else if (full.type === 'website') {
        const w = {...(full.config?.website ?? {})};
        if (v.url) w.urls = v.url;
        if (v.page) w.pages = {enabled: v.page};
        if (!w.urls?.length) throw new UsageError('A website source needs --url', ctx.usage());
        config = {website: w};
      } else if (full.type === 'gdrive') {
        config = {gdrive: full.config?.gdrive};
      } else config = {files: {}};
      const body = {
        config,
        ...(v.schedule ? {syncSchedule: v.schedule} : full.syncSchedule ? {syncSchedule: full.syncSchedule} : {}),
      };
      const r = await client.call('PUT', `${dsPath(d.id)}/configure`, {json: body});
      return maskSecrets(r?.dataSource ?? {id: d.id, name: d.name, ...body});
    },
    text: (d) => `Configured the data source ${d.name} (${d.id})`,
  },
  browse: {
    summary: 'what a source can sync: Confluence spaces (or the pages of --space), website pages, Drive folders',
    usage: 'wx-admin kb source browse <ds> [--space ID] [--url URL] [--folder ID]',
    options: {
      space: {type: 'string', placeholder: 'ID', description: 'Confluence: the pages of this space'},
      url: {type: 'string', placeholder: 'URL', description: 'website: discover from this address (default: its own)'},
      folder: {
        type: 'string',
        placeholder: 'ID',
        description: 'Google Drive: the folders under this one (default root)',
      },
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      let parameters;
      if (d.type === 'confluence') parameters = {confluence: v.space ? {pages: {spaceId: v.space}} : {spaces: {}}};
      else if (d.type === 'website') {
        const url = v.url ?? d.config?.website?.urls?.[0];
        if (!url) throw new UsageError('Give the address: --url URL', ctx.usage());
        parameters = {website: {discover: {url}}};
      } else if (d.type === 'gdrive') parameters = {gdrive: {folders: {parentId: v.folder ?? 'root'}}};
      else throw new UsageError(`A ${d.type} source has nothing to browse`);
      return (await client.call('POST', `${dsPath(d.id)}/describe`, {json: {parameters}}))?.result ?? {};
    },
    text(r) {
      const c = r.confluence;
      if (c?.spaces) return c.spaces.map((s) => `${s.id}  ${s.key ?? ''}  ${s.name}  (${s.type})`);
      if (c?.pages) return c.pages.map((p) => `${p.id}  ${p.title}${p.parentId ? `  (in ${p.parentId})` : ''}`);
      if (r.website) return [...r.website.pages.map((p) => p.url), ...(r.website.truncated ? ['… (truncated)'] : [])];
      if (r.gdrive) return r.gdrive.folders.map((f) => `${f.id}  ${f.name}`);
      return JSON.stringify(r, null, 2);
    },
  },
  sync: {
    summary: 'start a sync of a data source (incremental; --full syncs everything again)',
    usage: 'wx-admin kb source sync <ds> [--full]',
    options: {full: {type: 'boolean', description: 'sync every document again, not only what changed'}},
    args: [1, 1],
    async run(ctx) {
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      await client.call('POST', `${dsPath(d.id)}/start-sync`, {
        query: {syncType: ctx.values.full ? 'full' : 'incremental'},
      });
      return {id: d.id, name: d.name, sync: ctx.values.full ? 'full' : 'incremental', started: true};
    },
    text: (r) => `Started a ${r.sync} sync of ${r.name}: wx-admin kb source status ${r.id} --watch`,
  },
  stop: {
    summary: 'stop the sync of a data source',
    usage: 'wx-admin kb source stop <ds>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      await client.call('POST', `${dsPath(d.id)}/stop-sync`);
      return {id: d.id, name: d.name, stopped: true};
    },
    text: (r) => `Stopped the sync of ${r.name}`,
  },
  status: {
    summary: 'the sync status of a data source; --watch follows it until the sync ends',
    usage: 'wx-admin kb source status <ds> [--watch] [--every SECONDS]',
    options: {
      watch: {type: 'boolean', description: 'ask again until the sync is over'},
      every: {type: 'string', placeholder: 'SECONDS', description: 'with --watch: how often (default 5)'},
    },
    args: [1, 1],
    async run(ctx) {
      const every = whole(ctx.values.every, 'every') ?? 5;
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      for (;;) {
        const r = await client.call('GET', `${dsPath(d.id)}/sync-status`);
        if (!ctx.values.watch || !RUNNING.test(String(r?.status ?? '')) || ctx.signal?.aborted)
          return {name: d.name, ...r};
        ctx.info(`${localTime(new Date(ctx.clock()).toISOString())}  ${statusLine(r)}`);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, every * 1000);
          ctx.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            {once: true},
          );
        });
      }
    },
    text: (r) => `${r.name}: ${statusLine(r)}`,
  },
  logs: {
    summary: 'the sync logs of a data source',
    usage: 'wx-admin kb source logs <ds> [--level LEVEL] [--search TEXT] [--limit N]',
    options: {
      level: {type: 'string', choices: LEVELS, description: 'only this level'},
      search: {type: 'string', placeholder: 'TEXT', description: 'only lines with this text'},
      limit: {type: 'string', placeholder: 'N', description: 'at most N lines'},
    },
    args: [1, 1],
    async run(ctx) {
      const v = ctx.values;
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      return client.call('GET', `${dsPath(d.id)}/sync-logs`, {
        query: {logLevel: v.level, search: v.search, limit: whole(v.limit, 'limit')},
      });
    },
    text: (r) =>
      (r?.logs ?? []).map((l) => `${localTime(l.timestamp)}  ${String(l.level).padEnd(5)}  ${oneLine(l.message, 200)}`),
  },
  stats: {
    summary: 'the documents and chunks of a data source',
    usage: 'wx-admin kb source stats <ds>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      return {name: d.name, ...(await client.call('GET', `${dsPath(d.id)}/statistics`))};
    },
    text: (r) => `${r.name}: ${r.documentsCount} documents, ${r.chunksCount} chunks`,
  },
  clone: {
    summary: 'a copy of a data source (its configuration, not its documents)',
    usage: 'wx-admin kb source clone <ds>',
    options: {},
    args: [1, 1],
    async run(ctx) {
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      return client.call('POST', `${dsPath(d.id)}/clone`);
    },
    text: (r) => `Cloned: the new data source is ${r.dataSourceId}`,
  },
  clean: {
    summary: 'remove the documents of a data source (needs --yes; the source and its configuration stay)',
    usage: 'wx-admin kb source clean <ds> --yes',
    options: {yes: {type: 'boolean', description: 'yes, remove its documents'}},
    args: [1, 1],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError('Cleaning removes every document of the source: confirm with --yes', ctx.usage());
      const client = await kbClient(ctx);
      const d = await findSource(client, ctx.positionals[0]);
      await client.call('POST', `${dsPath(d.id)}/clean`);
      return {id: d.id, name: d.name, cleaned: true};
    },
    text: (r) => `Cleaned ${r.name}`,
  },
  delete: {
    summary: 'delete data sources (needs --yes)',
    usage: 'wx-admin kb source delete <ds>... --yes',
    options: {yes: {type: 'boolean', description: 'yes, delete them'}},
    args: [1, 50],
    async run(ctx) {
      if (!ctx.values.yes)
        throw new UsageError('Deleting a data source removes its documents: confirm with --yes', ctx.usage());
      const client = await kbClient(ctx);
      const found = [];
      for (const ref of ctx.positionals) found.push(await findSource(client, ref));
      for (const d of found) await client.call('DELETE', dsPath(d.id));
      return {deleted: found.map(({id, name}) => ({id, name}))};
    },
    text: (r) => `Deleted ${r.deleted.map((d) => `${d.name} (${d.id})`).join(', ')}`,
  },
};

export const groups = {
  kb: {
    summary: 'the knowledge base of the cloud (WIM): knowledge bases, data sources, documents, search, answers',
    commands: {...kbCommands, source: {summary: 'the data sources of the knowledge bases', commands: sourceCommands}},
  },
};

export {SHOW, masked};
