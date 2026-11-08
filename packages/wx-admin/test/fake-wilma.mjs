// Wilma in memory, behind fakeCloud: the objects of a company and the answers of its operations, shaped as the
// service answers them ({agents, nextCursor}, {agent}, …). Lists are paged by `limit` and a numeric `cursor`; an update
// with another `revision` than the stored one is a 409, as optimistic locking does; a publish of a draft equal to its
// latest version is a 409 NothingToPublishException. As the live service does, the type of an error is only in the
// `x-amzn-errortype` header; the body is {message}.
//   state = {agents, skills, tools, connectors, secrets, connections: [objects with id],
//            definitions: [connector definitions], versions: {[id]: [{version, definition, …}]},
//            deployments: {[agentId]: [{version, percentage}]}, keys: {[agentId]: [{id, name, prefix}]},
//            references: {[uri]: [{label, uri}]}, changes: [{path, before, after}], events, traces, spans: {[traceId]},
//            modelCalls: {[traceId/spanId]}, usage: {rows, total}, uploads: [], files: {[fileId]: {url}}}
const COLLECTIONS = [
  ['agents', /^\/v2\/agents\/agents(?:\/([^/]+))?$/, 'agent'],
  ['skills', /^\/v2\/skills(?:\/items\/([^/]+))?$/, 'skill'],
  ['tools', /^\/v2\/tools(?:\/items\/([^/]+))?$/, 'tool'],
  ['connectors', /^\/v2\/tools\/connectors(?:\/items\/([^/]+))?$/, 'connector'],
  ['secrets', /^\/v2\/secrets(?:\/items\/([^/]+))?$/, 'secret'],
  ['connections', /^\/v2\/secrets\/connections(?:\/([^/]+))?$/, 'connection'],
];
const VERSIONED = [
  ['agents', /^\/v2\/agents\/agents\/([^/]+)/, 'agentId'],
  ['skills', /^\/v2\/skills\/items\/([^/]+)/, 'skillId'],
  ['tools', /^\/v2\/tools\/items\/([^/]+)/, 'toolId'],
];

// A 409 as live Wilma answers it: the type in the header (with the suffix it carries), the message in the body.
const conflict = (type, message) => ({
  status: 409,
  headers: {'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/wildix.wilma/`},
  body: {message},
});

// A draft unchanged since its latest version (what is not the definition aside): nothing to publish.
const META = ['id', 'companyId', 'revision', 'status', 'latestVersion', 'draftBaseVersion', 'createdAt', 'updatedAt'];
const definitionOf = (o) =>
  JSON.stringify(
    Object.keys(o)
      .filter((k) => !META.includes(k))
      .sort()
      .map((k) => [k, o[k]]),
  );
const sameDefinition = (a, b) => definitionOf(a) === definitionOf(b);

const page = (items, q, key) => {
  const start = Number(q.cursor ?? 0);
  const limit = Number(q.limit ?? 100);
  const slice = items.slice(start, start + limit);
  return {[key]: slice, nextCursor: start + limit < items.length ? String(start + limit) : undefined};
};

export function fakeWilma(state) {
  let next = 1;
  const newId = (len = 12) => `n${String(next++).padStart(len - 1, '0')}`;
  for (const k of ['agents', 'skills', 'tools', 'connectors', 'secrets', 'connections']) state[k] ??= [];
  state.versions ??= {};
  state.deployments ??= {};
  state.keys ??= {};
  state.references ??= {};
  state.uploads ??= [];
  return (method, u, {body}) => {
    const p = u.pathname;
    const q = Object.fromEntries(
      [...u.searchParams.keys()].map((k) => [
        k,
        u.searchParams.getAll(k).length > 1 ? u.searchParams.getAll(k) : u.searchParams.get(k),
      ]),
    );
    if (q.company) return {status: 400, body: {message: 'Illegal company query parameter.'}};
    let m;

    // Versions, deployment and keys of versioned objects.
    for (const [coll, re, idKey] of VERSIONED) {
      if (!(m = p.match(re))) continue;
      const id = decodeURIComponent(m[1]);
      const obj = state[coll].find((o) => o.id === id);
      const rest = p.slice(m[0].length);
      if (!rest) break;
      if (!obj) return {status: 404, body: {message: `Not found: ${id}`}};
      const versions = (state.versions[id] ??= []);
      if (rest === '/versions' && method === 'GET') return {body: page(versions, q, 'versions')};
      if (rest === '/versions' && method === 'POST') {
        if (body.revision !== obj.revision) return conflict('RevisionConflictException', 'Revision mismatch');
        const latest = versions.find((v) => v.version === obj.latestVersion);
        if (latest && sameDefinition(obj, latest.definition))
          return conflict('NothingToPublishException', 'There is nothing new to publish.');
        const v = {
          [idKey]: id,
          version: versions.length + 1,
          changelog: body.changelog,
          name: body.name,
          definition: {...obj},
        };
        versions.unshift(v);
        obj.latestVersion = v.version;
        obj.status = 'active';
        return {body: {version: v}};
      }
      if ((m = rest.match(/^\/versions\/(\d+)$/))) {
        const v = versions.find((x) => x.version === Number(m[1]));
        return v ? {body: {version: v}} : {status: 404, body: {message: 'No such version'}};
      }
      if ((m = rest.match(/^\/versions\/(\d+)\/draft$/)) && method === 'POST') {
        const v = versions.find((x) => x.version === Number(m[1]));
        if (!v) return {status: 404, body: {message: 'No such version'}};
        if (body.revision !== obj.revision) return conflict('RevisionConflictException', 'Revision mismatch');
        Object.assign(obj, v.definition, {revision: obj.revision + 1, draftBaseVersion: v.version});
        return {body: {[coll.slice(0, -1)]: obj}};
      }
      if (rest === '/compare-versions') return {body: {changes: state.changes ?? []}};
      if (rest === '/deployment' && method === 'GET') return {body: {deployment: state.deployments[id] ?? []}};
      if (rest === '/deployment' && method === 'PUT') {
        state.deployments[id] = body.deployment;
        return {body: {deployment: body.deployment}};
      }
      if (rest === '/deployment/reset') {
        state.deployments[id] = [];
        return {body: {deployment: []}};
      }
      if (rest === '/keys' && method === 'GET') return {body: {keys: state.keys[id] ?? []}};
      if (rest === '/keys' && method === 'POST') {
        const key = {
          id: newId(),
          name: body.name,
          prefix: 'wak_n',
          createdAt: '2026-11-08T10:00:00Z',
          expiresAt: body.expiresAt,
        };
        (state.keys[id] ??= []).push(key);
        return {body: {key, secret: 'wak_n.the-full-secret'}};
      }
      if ((m = rest.match(/^\/keys\/([^/]+)$/)) && method === 'DELETE') {
        state.keys[id] = (state.keys[id] ?? []).filter((k) => k.id !== m[1]);
        return {status: 200};
      }
      return {status: 404, body: {message: `No route ${method} ${p}`}};
    }

    // Skill files.
    if (p === '/v2/skills/files' && method === 'POST') {
      const fileId = newId();
      return {body: {fileId, uploadUrl: `https://upload.example/${fileId}`, expiresAt: 'x'}};
    }
    if ((m = p.match(/^\/v2\/skills\/files\/items\/([^/]+)\/download$/)))
      return {body: {url: state.files?.[m[1]]?.url ?? `https://download.example/${m[1]}`, expiresAt: 'x'}};

    // Connector definitions.
    if (p === '/v2/tools/connector-definitions') {
      const want = String(q.query ?? '').toLowerCase();
      const defs = (state.definitions ?? []).filter(
        (d) => !want || JSON.stringify(d.metadata).toLowerCase().includes(want),
      );
      return {body: page(defs, q, 'definitions')};
    }
    if ((m = p.match(/^\/v2\/tools\/connector-definitions\/([^/]+)\/versions\/([^/]+)$/))) {
      const d = (state.definitions ?? []).find((x) => x.ref.key === m[1] && String(x.ref.version) === m[2]);
      return d ? {body: {definition: d}} : {status: 404, body: {message: 'No such definition'}};
    }

    // Secrets and connections: rotate, verify.
    if ((m = p.match(/^\/v2\/secrets\/items\/([^/]+)\/rotate$/))) {
      const s = state.secrets.find((x) => x.id === m[1]);
      s.revision = (s.revision ?? 0) + 1;
      (state.values ??= {})[s.id] = body.value;
      return {body: {secret: s}};
    }
    if ((m = p.match(/^\/v2\/secrets\/connections\/([^/]+)\/verify$/)))
      return {body: {status: 'active', working: true}};

    // Audit and traces.
    if (p === '/v2/audit/references') return {body: page(state.references[q.uri] ?? [], q, 'references')};
    if (p === '/v2/audit/events') return {body: page(state.events ?? [], q, 'events')};
    if ((m = p.match(/^\/v2\/audit\/events\/([^/]+)$/))) {
      const e = (state.events ?? []).find((x) => x.eventId === m[1]);
      return e ? {body: {event: e}} : {status: 404, body: {message: 'No such event'}};
    }
    if (p === '/v2/traces') return {body: page(state.traces ?? [], q, 'traces')};
    if ((m = p.match(/^\/v2\/traces\/items\/([^/]+)$/))) {
      const t = (state.traces ?? []).find((x) => x.traceId === m[1]);
      return t
        ? {body: {trace: {...t, spans: state.spans?.[t.traceId] ?? []}}}
        : {status: 404, body: {message: 'No trace'}};
    }
    if ((m = p.match(/^\/v2\/traces\/items\/([^/]+)\/model-calls\/([^/]+)$/)))
      return {body: {modelCall: state.modelCalls?.[`${m[1]}/${m[2]}`] ?? {}}};
    if (p === '/v2/traces/usage' || p === '/v2/traces/metrics') return {body: state.usage ?? {rows: [], total: {}}};

    // Collections: list, create, get, update, delete.
    for (const [coll, re, itemKey] of COLLECTIONS) {
      if (!(m = p.match(re))) continue;
      const list = state[coll];
      if (!m[1]) {
        if (method === 'GET') {
          let items = list;
          if (q.search)
            items = items.filter((o) =>
              String(o.name ?? '')
                .toLowerCase()
                .includes(String(q.search).toLowerCase()),
            );
          return {body: page(items, q, coll)};
        }
        if (method === 'POST') {
          const {value, ...rest} = body;
          const obj = {
            id: newId(coll === 'secrets' || coll === 'connections' ? 8 : 12),
            ...(coll === 'connections' ? {type: 'shared'} : {}), // CreateConnection makes SHARED ones only
            ...rest,
            revision: 0,
            status: 'draft',
          };
          if (value !== undefined) (state.values ??= {})[obj.id] = value;
          list.push(obj);
          return {body: {[itemKey]: obj}};
        }
      }
      const id = decodeURIComponent(m[1]);
      const obj = list.find((o) => o.id === id);
      if (!obj) return {status: 404, body: {message: `Not found: ${id}`}};
      if (method === 'GET') return {body: {[itemKey]: obj}};
      if (method === 'PUT') {
        if ('revision' in body && body.revision !== obj.revision)
          return conflict('RevisionConflictException', 'Revision mismatch');
        Object.assign(obj, body, {revision: (obj.revision ?? 0) + 1});
        return {body: {[itemKey]: obj}};
      }
      if (method === 'DELETE') {
        state[coll] = list.filter((o) => o.id !== id);
        return {status: 200};
      }
    }
    return {status: 404, body: {message: `No route ${method} ${p}`}};
  };
}

// Presigned upload and download links of the fake: PUT to upload.example records the bytes, GET from
// download.example answers the bytes of state.files.
export function withLinks(state, wilma) {
  return async (method, u, init) => {
    if (u.host === 'upload.example') {
      state.uploads.push({path: u.pathname, body: init.body, headers: init.headers});
      return {status: 200};
    }
    if (u.host === 'download.example') {
      const f = Object.values(state.files ?? {}).find((x) => x.url === u.href);
      return new Response(f?.bytes ?? '', {status: f ? 200 : 404});
    }
    return wilma(method, u, init);
  };
}
