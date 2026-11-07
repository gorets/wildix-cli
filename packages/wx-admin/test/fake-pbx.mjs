// A PBX in memory for the config transfer: collections of objects with ids, read and written as the real PBX does
// (answers wrapped in {type: 'result', result}; some POSTs answer "Success" without the object; dialplans read one by
// one; price lists written as multipart with a CSV). A path that is not in the state answers 403, as a PBX does for
// a scope the key lacks.
import {pbxClient} from '../src/pbx.mjs';
import {tempConfigDir} from './helpers.mjs';

export const COLLECTIONS = {
  '/PBX/AclGroups/': {post: 'object'},
  '/PBX/Colleagues/': {post: 'object', paged: true},
  '/Trunks/Sip/': {post: 'success'},
  '/Trunks/Groups/': {post: 'success'},
  '/Trunks/Prices/': {post: 'object', multipart: true},
  '/Dialplan/timeTables/': {post: 'success'},
  '/Dialplan/Ivr/': {post: 'success'},
  '/Dialplan/Switches/': {post: 'success'},
  '/Dialplan/PagingGroups/': {post: 'success'},
  '/Dialplan/CallGroups/': {post: 'success'},
  '/PBX/Dialplans/': {post: 'object', detail: true},
};

const reply = (status, body) => new Response(JSON.stringify(body), {status});
const result = (r) => reply(200, {type: 'result', result: r});

// state: {[collection path]: [objects with id]} and {[single path]: object}; paths missing from it answer 403.
export function fakePbx(state, {failOn = () => false} = {}) {
  const calls = [];
  let next = 1000;
  const fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, '');
    let body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof FormData) body = Object.fromEntries([...init.body.entries()]);
    calls.push({method: init.method, path, query: Object.fromEntries(u.searchParams), body});
    const failure = failOn({method: init.method, path, body});
    if (failure) return reply(400, {type: 'error', reason: failure});
    const prefix = Object.keys(COLLECTIONS).find((p) => path.startsWith(p));
    if (!prefix) {
      if (!Object.hasOwn(state, path) && !(init.method === 'PUT' && path.startsWith('/Dialplan/DB/')))
        return reply(403, {type: 'error', reason: 'Access error'});
      if (init.method === 'GET') return result(state[path]);
      if (init.method === 'PUT') {
        state[path] = body; // a dialplan-db key is created by its PUT
        return result('Success');
      }
      return reply(405, {});
    }
    if (!Object.hasOwn(state, prefix)) return reply(403, {type: 'error', reason: 'Access error'});
    const list = state[prefix];
    const conf = COLLECTIONS[prefix];
    const rest = path.slice(prefix.length).replace(/\/+$/, '');
    if (rest.endsWith('/export')) {
      const p = list.find((x) => String(x.id) === rest.split('/')[0]);
      return new Response(p?.csv ?? 'dialprefix,destination,rate\n', {status: 200});
    }
    const item = rest ? list.find((x) => String(x.id) === rest) : undefined;
    if (init.method === 'GET') {
      if (!rest) {
        if (!conf.paged) return result({records: list});
        const start = Number(u.searchParams.get('start') ?? 0);
        const count = Number(u.searchParams.get('count') ?? list.length);
        return result({total: list.length, records: list.slice(start, start + count)});
      }
      return item ? result(item) : reply(404, {type: 'error', reason: 'Not found'});
    }
    if (init.method === 'POST' && !rest) {
      const made = {...body, id: String(next++)};
      if (conf.multipart) {
        made.csv = body.upload ? await body.upload.text() : '';
        delete made.upload;
      }
      list.push(made);
      return result(conf.post === 'object' ? made : 'Success');
    }
    if ((init.method === 'PUT' || (init.method === 'POST' && conf.multipart)) && item) {
      const changes = {...body};
      if (conf.multipart) {
        if (changes.upload) item.csv = await changes.upload.text();
        delete changes.upload;
        delete changes.method;
      }
      Object.assign(item, changes, {id: item.id});
      return result(conf.post === 'object' ? item : 'Success');
    }
    if (init.method === 'DELETE' && item) {
      list.splice(list.indexOf(item), 1);
      return result('Success');
    }
    return reply(404, {type: 'error', reason: 'Not found'});
  };
  return {fetch, calls, state};
}

const KEY = `wsk-v1-${'a'.repeat(93)}`;

// A PBX API client on the fake PBX (a Company API Key for the host "demo").
export function clientOf(pbx) {
  const env = {WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'};
  return pbxClient({env, fetch: pbx.fetch, pbx: 'demo', values: {}, info: () => {}});
}
