// wx-admin kb: the knowledge base of the Wildix cloud (WIM) for the company of the PBX, with the PBX's CPA token:
// knowledge bases, search and answers; data sources (kb source) and documents (kb doc). A knowledge base, a data
// source or a document is given by id or by exact name; a name several share asks for the id.
// Operations (the knowledge base service, https://kb.wim[-stage].wildix.com/api/v1):
//   ListKnowledgeBases, GetKnowledgeBase, CreateKnowledgeBase, UpdateKnowledgeBase, DeleteKnowledgeBase,
//   SearchKnowledgeBase, GenerateSearchAnswer, ListSearchQueriesHistory, ListHistoryStatistics
import {UsageError} from 'wldx-core/errors';
import {apiPath} from 'wldx-core/http';
import {localTime, oneLine, paint, table} from 'wldx-core/format';
import {cloudClient} from '../cloud/client.mjs';
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

export const groups = {
  kb: {
    summary: 'the knowledge base of the cloud (WIM): knowledge bases, data sources, documents, search, answers',
    commands: kbCommands,
  },
};

export {SHOW, masked};
