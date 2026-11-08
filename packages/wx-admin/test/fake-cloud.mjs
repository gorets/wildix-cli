// A PBX that hands out a CPA token and the cloud services behind it, in one fetch. `cloud(method, url, init)` answers
// the service requests ({status, body, headers} or a Response); every request is recorded with its headers.
import {clearCloudTokens} from '../src/cloud/token.mjs';
import {fakeJwt, tempConfigDir} from './helpers.mjs';

export const KEY = `wsk-v1-${'a'.repeat(93)}`;
export const EXP = Date.UTC(2026, 10, 7, 20) / 1000;
export const CPA = fakeJwt({'custom:company_id': 'it_x', 'custom:company_name': 'X Inc', exp: EXP});

export function fakeCloud(cloud, {portal = 'https://wim-console-stage.wildix.com', tokens = [CPA]} = {}) {
  clearCloudTokens();
  const calls = [];
  let handed = 0; // the PBX hands the tokens in order, the last one again and again
  const fetch = async (url, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError'); // as fetch does
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;
    if (typeof body === 'string' && headers['content-type']?.includes('json')) body = JSON.parse(body);
    calls.push({
      method: init.method ?? 'GET',
      url: u.href,
      host: u.host,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers,
      body,
    });
    if (u.host === 'demo.wildixin.com')
      return new Response(
        JSON.stringify({type: 'result', result: {token: tokens[Math.min(handed++, tokens.length - 1)], portal}}),
        {status: 200},
      );
    const a = await cloud(init.method ?? 'GET', u, {headers, body});
    if (a instanceof Response) return a;
    return new Response(a?.body === undefined ? '' : JSON.stringify(a.body), {
      status: a?.status ?? 200,
      headers: a?.headers,
    });
  };
  return {fetch, calls, cloudCalls: () => calls.filter((c) => c.host !== 'demo.wildixin.com')};
}

export const envOfTest = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});
export const ctxOf = (f, extra = {}) => {
  const now = Date.UTC(2026, 10, 7, 12);
  return {env: envOfTest(), fetch: f.fetch, values: {}, info: () => {}, clock: () => now, now, ...extra};
};

// The knowledge base service in memory: state = {kbs: [{id, name, description, dataSources}], sources: [{id, name,
// type, config, syncSchedule}], docs: {[sourceId]: [{id, title, …}]}, results: [search results], syncStatus: {…}}.
// Answers as the service does ({knowledgeBases}, {knowledgeBase}, {dataSources}, …).
export function fakeKb(state) {
  let next = 1;
  const id = (p) => `${p}-new${next++}`; // never the id of an object of the state
  return (method, u, {body}) => {
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const m = (re) => p.match(re);
    let x;
    if (p === '/knowledge-bases' && method === 'GET') return {body: {knowledgeBases: state.kbs}};
    if (p === '/knowledge-bases' && method === 'POST') {
      const kb = {id: id('kb'), ...body};
      state.kbs.push(kb);
      return {body: {knowledgeBase: kb}};
    }
    if (p === '/knowledge-bases/generate-answer')
      return {
        body: {
          answer: `answer to ${body.searchQuery}`,
          metadata: {model: 'm', inputTokens: 10, outputTokens: 5, duration: 100},
          sources: body.searchResults,
        },
      };
    if (p === '/knowledge-bases/history/search-queries')
      return {body: {history: state.history ?? [], metadata: {total: 0}}};
    if (p === '/knowledge-bases/history/statistics') return {body: {statistics: state.statistics ?? {}}};
    if ((x = m(/^\/knowledge-bases\/([^/]+)\/search$/)))
      return {body: {results: state.results.filter((r) => r.kb === x[1])}};
    if ((x = m(/^\/knowledge-bases\/([^/]+)$/))) {
      const kb = state.kbs.find((k) => k.id === x[1]);
      if (!kb) return {status: 404, body: {message: 'Knowledge base not found'}};
      if (method === 'GET') return {body: {knowledgeBase: kb}};
      if (method === 'PUT') return {body: {knowledgeBase: Object.assign(kb, body)}};
      if (method === 'DELETE') {
        state.kbs.splice(state.kbs.indexOf(kb), 1);
        return {body: {}};
      }
    }
    if (p === '/data-sources' && method === 'GET') return {body: {dataSources: state.sources}};
    if (p === '/data-sources' && method === 'POST') {
      const s = {id: id('ds'), config: {}, ...body};
      state.sources.push(s);
      return {body: {dataSource: s}};
    }
    if ((x = m(/^\/data-sources\/([^/]+)(\/.*)?$/))) {
      const s = state.sources.find((d) => d.id === x[1]);
      if (!s) return {status: 404, body: {message: 'Data source not found'}};
      const rest = x[2] ?? '';
      if (!rest && method === 'GET') return {body: {dataSource: s}};
      if (!rest && method === 'PUT') return {body: {dataSource: Object.assign(s, body)}};
      if (!rest && method === 'DELETE') {
        state.sources.splice(state.sources.indexOf(s), 1);
        return {body: {}};
      }
      if (rest === '/configure') return {body: {dataSource: Object.assign(s, body)}};
      if (rest === '/describe') return {body: {result: state.describe ?? {}}};
      if (rest === '/start-sync' || rest === '/stop-sync' || rest === '/clean') return {body: {}};
      if (rest === '/clone') return {body: {dataSourceId: id('ds')}};
      if (rest === '/sync-status') return {body: state.syncStatus?.shift?.() ?? {status: 'idle', documentsStats: {}}};
      if (rest === '/statistics') return {body: {documentsCount: 2, chunksCount: 9}};
      if (rest === '/sync-logs')
        return {body: {logs: [{level: 'info', message: 'done', timestamp: 't'}], metadata: {total: 1}}};
      const docs = (state.docs[s.id] ??= []);
      if (rest === '/documents' && method === 'GET') return {body: {documents: docs, metadata: {total: docs.length}}};
      if (rest === '/documents' && method === 'POST') {
        const d = {id: id('doc'), status: 'pending', ...body};
        docs.push(d);
        return {body: {document: d}};
      }
      const dm = rest.match(/^\/documents\/([^/]+)(\/.*)?$/);
      if (dm) {
        const d = docs.find((o) => o.id === dm[1]);
        if (!d) return {status: 404, body: {message: 'Document not found'}};
        const tail = dm[2] ?? '';
        if (!tail && method === 'GET') return {body: {document: d}};
        if (!tail && method === 'DELETE') {
          docs.splice(docs.indexOf(d), 1);
          return {body: {}};
        }
        if (tail === '/with-content-and-chunks')
          return {body: {document: d, content: 'text', chunks: [{id: 'c1', content: 'text'}]}};
        if (tail === '/markdown') return {body: {markdown: `# ${d.title}\n`}};
        if (tail === '/upload-url') return {body: {uploadUrl: `https://bucket.s3.amazonaws.com/${d.id}?sig=1`}};
        if (tail === '/download-url') return {body: {downloadUrl: `https://bucket.s3.amazonaws.com/${d.id}?sig=2`}};
      }
    }
    if (u.host === 'bucket.s3.amazonaws.com') return {body: method === 'GET' ? 'file-bytes' : ''};
    return {status: 404, body: {message: `no route ${method} ${p}`}};
  };
}
