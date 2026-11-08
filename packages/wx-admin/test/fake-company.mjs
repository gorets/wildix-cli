// Two (or more) PBX of their own companies and the cloud of each company, in one fetch: what a config transfer between
// companies talks to.
//
//   fakeCompany({
//     pbxs: {a: {company: 'it_x', pbx: fakePbxState, serial?}, b: {company: 'it_y', pbx: …}},
//     clouds: {it_x: {wilma?, kb?, integrations?, kite?, stream?}, it_y: {…}},
//   }, {portal?})
//
// PBX: the key is the host (`a` → a.wildixin.com; a key with a dot is the host itself). Each PBX is a fakePbx of its
// state (test/fake-pbx.mjs) with its own serial in /PBX/settings/ (given, else aaaa00000001 for a, bbbb00000002 for
// b), and answers the CPA route (/PBX/integration/x-bees) with its own token: a JWT whose custom:company_id is its
// company, whose cognito:username is its serial, with the WIM console `portal` (stage by default).
//
// Cloud: a request goes to the service of its host (the stage bases of src/cloud/env.mjs: Wilma, the knowledge base,
// the WIM integrations, Kite / x-bees, the Stream directory) in the company its bearer token names; no token or an unknown one is a 401, a
// company without that service in `clouds` a 404. The state of each service, changed in place by the writes:
//   wilma:        the state of fakeWilma (test/fake-wilma.mjs)
//   kb:           the state of fakeKb (test/fake-cloud.mjs); kbs, sources, docs and results default to empty
//   integrations: {installed: [{integrationId, service, status?, data}], allowed?: [service], license?: {…}}
//                 /console/integrations GET (the console state), POST (a new one; an app with isNew false and its
//                 integrationId replaces that app's data; currentIntegrationId swaps two apps), PATCH
//                 {integrationId, status?, data?} (data merged), DELETE ?integrationId; answers {success, result}
//   kite:         {services: [{id, uri, title, settings, extensions}], bots: [{id, name}],
//                  widgets: [{id, name, target, …}],
//                  sms: {numbers: [{number, service?}], configs: [{serviceNumber, serviceUri, target, routes, actions}]},
//                  whatsapp: {numbers, configs, templates},
//                  messenger: {senders: [{senderId, name}], configs: [{senderId, serviceUri, target, …}]}, rcs: {…}}
//                 every list defaults to empty; a PUT stores what it answers. Kite refuses a `company` query
//                 parameter, as Wilma does.
//   stream:       {users: [{id, email, displayName, …}]} (the users of the company in the Stream directory);
//                 POST /api/v1/users/query {query: {ids?, emails?, phones?}}, 1 to 100 items per list, else a 400.
//                 The directory is one for every company (as the real one): a query answers the users of all the
//                 companies, each with its companyId (that of the company listing it, unless the user names one).
// Presigned links (upload.example, download.example, bucket.s3.amazonaws.com) carry no token: an upload is recorded
// in `uploads`, a download answers the bytes of the Wilma `files` of whichever company has that link, else those of the
// last upload of that file id (https://download.example/<id>, the link the fake Wilma gives a file it has no entry for).
//
// Every request is recorded in `calls` as {company, service, host, method, path, query, body} (a PBX path with its
// /api/v1): service is 'pbx',
// 'wilma', 'kb', 'integrations', 'kite', 'stream' or 'link'; company is that of the PBX, or of the token (null for a link or a
// refused token). Helpers: cloudCalls({company?, service?}), writes({company?, service?}) (the cloud calls that are
// not GET), pbxCalls(name), env (saved access to every PBX), ctxOf(name, extra?) and clients(name) ({pbx, wilma, kb,
// integrations, kite, stream} of that PBX).
import {jwtClaims} from 'wldx-core/auth';
import {baseOf} from '../src/cloud/env.mjs';
import {clearCloudTokens} from '../src/cloud/token.mjs';
import {cloudClient} from '../src/cloud/client.mjs';
import {pbxClient, saveAccess} from '../src/pbx.mjs';
import {EXP, fakeKb, KEY} from './fake-cloud.mjs';
import {fakePbx} from './fake-pbx.mjs';
import {fakeWilma} from './fake-wilma.mjs';
import {fakeJwt, tempConfigDir} from './helpers.mjs';

const CPA_ROUTE = '/api/v1/PBX/integration/x-bees';
const SERVICES = ['wilma', 'kb', 'integrations', 'kite', 'stream'];
const SERIALS = {a: 'aaaa00000001', b: 'bbbb00000002'};
const LINK_HOSTS = new Set(['upload.example', 'download.example', 'bucket.s3.amazonaws.com']);
export const NOW = Date.UTC(2026, 10, 7, 12);

const ok = (result) => ({body: {success: true, result}});
const refused = (status, message) => ({status, body: {success: false, message}});

// The WIM console API of one company (see the state above).
export function fakeIntegrations(state) {
  state.installed ??= [];
  let next = 1;
  const find = (id) => state.installed.find((i) => i.integrationId === id);
  return (method, u, {body}) => {
    if (u.pathname !== '/console/integrations')
      return {status: 404, body: {message: `No route ${method} ${u.pathname}`}};
    if (method === 'GET')
      return ok({
        installed: state.installed,
        allowed: state.allowed ?? [],
        license: state.license ?? {},
        webhook: {events: []},
        featureRequests: {},
      });
    if (method === 'POST') {
      const {isNew, integrationId, currentIntegrationId, targetIntegrationId, ...data} = body?.data ?? {};
      if (currentIntegrationId) {
        const a = find(currentIntegrationId);
        const b = find(targetIntegrationId);
        if (!a || !b) return refused(404, 'Integration not found');
        [a.data.position, b.data.position] = [b.data.position, a.data.position];
        return ok({swapped: true});
      }
      if (isNew === false && integrationId) {
        const i = find(integrationId);
        if (!i) return refused(404, 'Integration not found');
        i.data = data;
        return ok(i);
      }
      const made = {integrationId: `int-new${next++}`, service: body.service, status: 'enabled', data};
      state.installed.push(made);
      return ok(made);
    }
    if (method === 'PATCH') {
      const i = find(body?.integrationId);
      if (!i) return refused(404, 'Integration not found');
      if (body.status) i.status = body.status;
      if (body.data) i.data = {...i.data, ...body.data};
      return ok(i);
    }
    if (method === 'DELETE') {
      const id = u.searchParams.get('integrationId');
      if (!find(id)) return refused(404, 'Integration not found');
      state.installed = state.installed.filter((i) => i.integrationId !== id);
      return {body: {success: true}};
    }
    return {status: 405, body: {message: `No route ${method} ${u.pathname}`}};
  };
}

// Kite and the x-bees bots of one company (see the state above).
export function fakeKite(state, company) {
  for (const k of ['services', 'bots', 'widgets']) state[k] ??= [];
  // Filled in place: a test keeps its references to the lists.
  for (const [k, lists] of [
    ['sms', ['numbers', 'configs']],
    ['whatsapp', ['numbers', 'configs', 'templates']],
    ['messenger', ['senders', 'configs']],
    ['rcs', ['senders', 'configs']],
  ]) {
    state[k] ??= {};
    for (const l of lists) state[k][l] ??= [];
  }
  let next = 1;
  const notFound = (what) => ({status: 404, body: {message: `${what} not found`}});
  return (method, u, {body}) => {
    if (u.searchParams.has('company')) return {status: 400, body: {message: 'Illegal company query parameter.'}};
    const p = u.pathname;
    let m;
    if (p === '/v2/kite/services' && method === 'GET') return {body: {services: state.services}};
    if (p === '/v2/users/bots' && method === 'GET') return {body: {bots: state.bots}};

    if (p === '/v2/kite/widgets' && method === 'GET') return {body: {widgets: state.widgets}};
    if (p === '/v2/kite/widgets' && method === 'POST') {
      const w = {id: `wgt-new${next++}`, company, ...body};
      state.widgets.push(w);
      return {body: {widget: w}};
    }
    if ((m = p.match(/^\/v2\/kite\/widgets\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const at = state.widgets.findIndex((x) => x.id === id);
      if (at < 0) return notFound('Widget');
      if (method === 'GET') return {body: {widget: state.widgets[at]}};
      if (method === 'PUT') {
        state.widgets[at] = {id, company, ...body}; // UpdateWidget replaces the widget
        return {body: {widget: state.widgets[at]}};
      }
      if (method === 'DELETE') {
        state.widgets.splice(at, 1);
        return {body: {}};
      }
    }

    if ((m = p.match(/^\/v2\/kite\/(sms|whatsapp)\/numbers$/))) return {body: {numbers: state[m[1]].numbers}};
    if ((m = p.match(/^\/v2\/kite\/(sms|whatsapp)\/configurations$/)))
      return {body: {configurations: state[m[1]].configs}};
    if ((m = p.match(/^\/v2\/kite\/whatsapp\/templates\/([^/]+)$/)))
      return {body: {templates: state.whatsapp.templates}};
    if ((m = p.match(/^\/v2\/kite\/(sms|whatsapp)\/configurations\/([^/]+)$/))) {
      const configs = state[m[1]].configs;
      const n = decodeURIComponent(m[2]);
      const at = configs.findIndex((x) => x.serviceNumber === n);
      if (method === 'GET') return at < 0 ? notFound('Configuration') : {body: {configuration: configs[at]}};
      if (method === 'PUT') {
        const c = {serviceNumber: n, companyId: company, ...body};
        if (at < 0) configs.push(c);
        else configs[at] = c;
        return {body: {configuration: c}};
      }
    }
    if ((m = p.match(/^\/v2\/kite\/messaging\/(messenger|rcs)\/senders$/)))
      return {body: {senders: state[m[1]].senders}};
    if ((m = p.match(/^\/v2\/kite\/messaging\/(messenger|rcs)\/senders\/([^/]+)\/configuration$/))) {
      const configs = state[m[1]].configs;
      const id = decodeURIComponent(m[2]);
      const at = configs.findIndex((x) => x.senderId === id);
      if (method === 'GET') return at < 0 ? notFound('Configuration') : {body: {configuration: configs[at]}};
      if (method === 'PUT') {
        const c = {senderId: id, companyId: company, ...body};
        if (at < 0) configs.push(c);
        else configs[at] = c;
        return {body: {configuration: c}};
      }
    }
    return {status: 404, body: {message: `No route ${method} ${p}`}};
  };
}

// The Stream directory of one company: POST /api/v1/users/query {query: {ids?, emails?, phones?}}, each list 1 to 100
// items as the service takes them (more, or no list, is a 400); e-mails match in any case; each user once.
export function fakeStream(state) {
  state.users ??= [];
  return (method, u, {body}) => {
    if (u.pathname !== '/api/v1/users/query' || method !== 'POST')
      return {status: 404, body: {message: `No route ${method} ${u.pathname}`}};
    const q = body?.query ?? {};
    const lists = ['ids', 'emails', 'phones'].filter((k) => q[k] !== undefined);
    if (!lists.length || lists.some((k) => !Array.isArray(q[k]) || q[k].length < 1 || q[k].length > 100))
      return {status: 400, body: {message: 'query: ids, emails or phones, 1 to 100 items each'}};
    const emails = (q.emails ?? []).map((e) => String(e).toLowerCase());
    const hit = (x) =>
      (q.ids ?? []).includes(x.id) ||
      emails.includes(String(x.email).toLowerCase()) ||
      (q.phones ?? []).includes(x.phone);
    return {body: {users: state.users.filter(hit)}};
  };
}

const hostOf = (name) => (name.includes('.') ? name : `${name}.wildixin.com`);

export function fakeCompany({pbxs, clouds = {}}, {portal = 'https://wim-console-stage.wildix.com'} = {}) {
  clearCloudTokens(); // the tokens of an earlier fake are kept per PBX host: never reuse them
  const calls = [];
  const uploads = [];

  // The PBX: host → {name, company, serial, token, fake}.
  const byHost = new Map();
  const tokens = new Set(); // the tokens the PBX hand out
  Object.entries(pbxs).forEach(([name, spec], i) => {
    const serial = spec.serial ?? SERIALS[name] ?? (i + 1).toString(16).padStart(12, '0');
    const state = spec.pbx ?? {};
    state['/PBX/settings/'] ??= {pbxSerial: serial};
    const token = fakeJwt({
      'custom:company_id': spec.company,
      'custom:company_name': `${spec.company} Inc`,
      'cognito:username': serial,
      exp: EXP,
    });
    tokens.add(token);
    byHost.set(hostOf(name), {name, company: spec.company, serial, token, fake: fakePbx(state)});
  });

  // The clouds: company → service → handler.
  const handlers = {};
  const directory = {
    get users() {
      return Object.entries(clouds).flatMap(([c, s]) => (s.stream?.users ?? []).map((u) => ({companyId: c, ...u})));
    },
  };
  for (const [company, services] of Object.entries(clouds)) {
    handlers[company] = {};
    if (services.wilma) handlers[company].wilma = fakeWilma(services.wilma);
    if (services.kb) {
      const s = services.kb;
      s.kbs ??= [];
      s.sources ??= [];
      s.docs ??= {};
      s.results ??= [];
      handlers[company].kb = fakeKb(s);
    }
    if (services.integrations) handlers[company].integrations = fakeIntegrations(services.integrations);
    if (services.kite) handlers[company].kite = fakeKite(services.kite, company);
    if (services.stream) handlers[company].stream = fakeStream(directory);
  }
  const serviceOfHost = new Map(SERVICES.map((s) => [new URL(baseOf(s, 'stage')).host, s]));

  const answer = (a) =>
    a instanceof Response
      ? a
      : new Response(a?.body === undefined ? '' : JSON.stringify(a.body), {
          status: a?.status ?? 200,
          headers: a?.headers,
        });

  function link(method, u, init) {
    if (u.host === 'upload.example') {
      uploads.push({path: u.pathname, body: init.body, headers: init.headers});
      return {status: 200};
    }
    if (u.host === 'download.example') {
      const files = Object.values(clouds).flatMap((c) => Object.values(c.wilma?.files ?? {}));
      const f = files.find((x) => x.url === u.href);
      if (f) return new Response(f.bytes ?? '', {status: 200});
      // A file uploaded in this fake (a skill file an import wrote) is downloaded by its id, as Wilma links it.
      const up = uploads.findLast((x) => x.path === u.pathname);
      return new Response(up?.body ?? '', {status: up ? 200 : 404});
    }
    return {body: method === 'GET' ? 'file-bytes' : ''}; // the knowledge base bucket
  }

  const fetch = async (url, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError'); // as fetch does
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;
    if (typeof body === 'string' && headers['content-type']?.includes('json')) body = JSON.parse(body);
    const call = {
      company: null,
      service: null,
      host: u.host,
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body,
    };
    calls.push(call);

    const pbx = byHost.get(u.hostname);
    if (pbx) {
      Object.assign(call, {company: pbx.company, service: 'pbx'});
      if (u.pathname === CPA_ROUTE) return answer({body: {type: 'result', result: {token: pbx.token, portal}}});
      return pbx.fake.fetch(url, init);
    }
    if (LINK_HOSTS.has(u.host)) {
      call.service = 'link';
      return answer(link(method, u, {...init, headers}));
    }
    const service = serviceOfHost.get(u.host);
    if (!service) return answer({status: 404, body: {message: `No such host ${u.host}`}});
    call.service = service;
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
    if (!bearer || !tokens.has(bearer)) return answer({status: 401, body: {message: 'Unauthorized'}});
    const company = jwtClaims(bearer)['custom:company_id'];
    call.company = company;
    const handler = handlers[company]?.[service];
    if (!handler) return answer({status: 404, body: {message: `No ${service} for ${company} in the fake`}});
    return answer(await handler(method, u, {headers, body}));
  };

  const env = {WILDIX_CONFIG_DIR: tempConfigDir()};
  for (const host of byHost.keys()) saveAccess({host, port: 443, auth: 'apikey', key: KEY}, env);
  const match = (c, {company, service} = {}) =>
    (company === undefined || c.company === company) && (service === undefined || c.service === service);
  const cloudCalls = (filter) => calls.filter((c) => c.service !== 'pbx' && match(c, filter));
  const ctxOf = (name, extra = {}) => ({
    env,
    fetch,
    pbx: hostOf(name),
    values: {},
    info: () => {},
    clock: () => NOW,
    now: NOW,
    ...extra,
  });

  return {
    fetch,
    calls,
    uploads,
    env,
    host: hostOf,
    serial: (name) => byHost.get(hostOf(name)).serial,
    pbx: (name) => byHost.get(hostOf(name)).fake,
    cloudCalls,
    writes: (filter) => cloudCalls(filter).filter((c) => c.method !== 'GET'),
    pbxCalls: (name) => calls.filter((c) => c.service === 'pbx' && c.host === hostOf(name)),
    ctxOf,
    // The clients bag of a PBX, as config import and copy build it: its PBX and the cloud services of its company.
    async clients(name) {
      const ctx = ctxOf(name);
      const out = {pbx: await pbxClient(ctx)};
      for (const s of SERVICES) out[s] = await cloudClient(ctx, s);
      return out;
    },
  };
}
