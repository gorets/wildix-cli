// The kinds of objects a config transfer carries, in the order they are written (what others point at first). Each
// kind reads its objects as {id, name, data} (data without ids, dns and runtime fields) and writes one: create
// answers the new id (re-reading the list where the PBX answers only "Success"), update sends the whole object (the
// PBX wants every field on a PUT).
import {apiPath, query} from 'wldx-core/http';

const listOf = (r) => (Array.isArray(r) ? r : (r?.records ?? []));
const without = (o, keys) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));
const RUNTIME = ['id', 'dn', 'status'];

// A kind kept in one list at `path`, its objects known by `nameField`; item paths are `<path><id>/` unless `item`.
function listed({group, label, path, scope, nameField, strip = [], item = (id) => `${path}${id}/`, postAnswers}) {
  const read = async (client) =>
    listOf(await client.call('GET', path, undefined, {scope})).map((r) => ({
      id: String(r.id),
      name: String(r[nameField] ?? r.id),
      data: without(r, [...RUNTIME, ...strip]),
    }));
  return {
    group,
    label,
    scope,
    read,
    async create(client, data) {
      const answer = await client.call('POST', path, data, {scope});
      if (postAnswers === 'object' && answer?.id !== undefined) return String(answer.id);
      const made = (await read(client)).find((o) => o.name === String(data[nameField]));
      if (!made) throw new Error(`The PBX did not show the new ${label} ${data[nameField]}`);
      return made.id;
    },
    async update(client, id, data) {
      await client.call('PUT', item(id), data, {scope});
    },
  };
}

// The user fields bound to the PBX they live on: never carried over.
const USER_BOUND = ['id', 'dn', 'uid', 'sourceId', 'jid', 'pbx', 'pbxDn', 'login', 'password', 'sipPassword'];
const PAGE = 1000;

const users = {
  group: 'users',
  label: 'user',
  scope: 'colleagues',
  async read(client) {
    const out = [];
    for (let start = 0; ; start += PAGE) {
      const page = listOf(
        await client.call('GET', `/PBX/Colleagues/${query({count: PAGE, start})}`, undefined, {scope: 'colleagues'}),
      );
      for (const u of page) out.push({id: String(u.id), name: String(u.extension), data: without(u, USER_BOUND)});
      if (page.length < PAGE) return out;
    }
  },
  async create(client, data) {
    return String((await client.call('POST', '/PBX/Colleagues/', data, {scope: 'colleagues'})).id);
  },
  async update(client, id, data) {
    await client.call('PUT', apiPath`/PBX/Colleagues/${id}/`, data, {scope: 'colleagues'});
  },
};

const PRICES = '/Trunks/Prices/';
const priceForm = (data, extra = {}) => {
  const form = new FormData();
  form.append('name', data.name);
  form.append('upload', new Blob([data.csv ?? ''], {type: 'text/csv'}), `${data.name}.csv`);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
};
const priceLists = {
  group: 'trunks',
  label: 'price list',
  scope: 'trunks',
  async read(client) {
    const out = [];
    for (const p of listOf(await client.call('GET', PRICES, undefined, {scope: 'trunks'}))) {
      const csv = await client.request('GET', apiPath`/Trunks/Prices/${p.id}/export`, {
        responseType: 'buffer',
        scope: 'trunks',
      });
      out.push({id: String(p.id), name: String(p.name), data: {name: p.name, csv: Buffer.from(csv).toString('utf8')}});
    }
    return out;
  },
  async create(client, data) {
    return String((await client.request('POST', PRICES, {data: priceForm(data), scope: 'trunks'})).id);
  },
  async update(client, id, data) {
    await client.request('POST', apiPath`/Trunks/Prices/${id}/`, {
      data: priceForm(data, {method: 'PUT'}),
      scope: 'trunks',
    });
  },
};

// The dialplan database has no list of its families: only the families asked for are read.
const dbKeyPath = (name) =>
  `${String(name)
    .split('/')
    .map((p) => apiPath`/${p}`)
    .join('')
    .replace(/^/, '/Dialplan/DB')}/`;
const dialplanDb = {
  group: 'routing',
  label: 'dialplan database key',
  scope: 'dialplan',
  async read(client, {dbFamilies = []} = {}) {
    const out = [];
    for (const family of dbFamilies) {
      for (const r of listOf(
        await client.call('GET', apiPath`/Dialplan/DB/${family}/`, undefined, {scope: 'dialplan'}),
      )) {
        const name = String(r.key).replace(/^\//, '');
        out.push({id: name, name, data: {value: r.value}});
      }
    }
    return out;
  },
  async create(client, data, name) {
    await client.call('PUT', dbKeyPath(name), {value: data.value}, {scope: 'dialplan'});
    return name;
  },
  async update(client, id, data) {
    await client.call('PUT', dbKeyPath(id), {value: data.value}, {scope: 'dialplan'});
  },
};

const DIALPLANS = '/PBX/Dialplans/';
const dialplans = {
  group: 'routing',
  label: 'dialplan',
  scope: 'dialplan',
  async read(client) {
    const out = [];
    for (const r of listOf(await client.call('GET', DIALPLANS, undefined, {scope: 'dialplan'}))) {
      const full = await client.call('GET', apiPath`/PBX/Dialplans/${r.id}/`, undefined, {scope: 'dialplan'});
      out.push({id: String(r.id), name: String(r.name), data: without(full, RUNTIME)});
    }
    return out;
  },
  async create(client, data) {
    const body = {
      name: data.name,
      description: data.description ?? '',
      numbers: data.numbers ?? [],
      includedDialplans: data.includedDialplans ?? [],
    };
    return String((await client.call('POST', DIALPLANS, body, {scope: 'dialplan'})).id);
  },
  // What PUT takes: description, numbers, includedDialplans (the name does not change).
  async update(client, id, data) {
    const body = {
      description: data.description ?? '',
      numbers: data.numbers ?? [],
      includedDialplans: data.includedDialplans ?? [],
    };
    await client.call('PUT', apiPath`/PBX/Dialplans/${id}/`, body, {scope: 'dialplan'});
  },
};

const GS = '/Dialplan/GeneralSettings/';
const dialplanSettings = {
  group: 'routing',
  label: 'general dialplan settings',
  scope: 'dialplan',
  single: true,
  async read(client) {
    return [{id: 'settings', name: 'settings', data: await client.call('GET', GS, undefined, {scope: 'dialplan'})}];
  },
  async create() {
    throw new Error('The general dialplan settings exist on every PBX: they are only updated');
  },
  async update(client, _id, data) {
    await client.call('PUT', GS, data, {scope: 'dialplan'});
  },
};

export const TRANSFER_KINDS = {
  'acl-groups': listed({
    group: 'users',
    label: 'ACL group',
    path: '/PBX/AclGroups/',
    scope: 'aclgroups',
    nameField: 'name',
    postAnswers: 'object',
  }),
  users,
  'trunks-sip': listed({
    group: 'trunks',
    label: 'SIP trunk',
    path: '/Trunks/Sip/',
    scope: 'trunks',
    nameField: 'title',
  }),
  'trunk-groups': listed({
    group: 'trunks',
    label: 'trunk group',
    path: '/Trunks/Groups/',
    scope: 'trunks',
    nameField: 'name',
    item: (id) => apiPath`/Trunks/Groups/${id}`,
  }),
  'price-lists': priceLists,
  timetables: listed({
    group: 'routing',
    label: 'timetable',
    path: '/Dialplan/timeTables/',
    scope: 'dialplan',
    nameField: 'title',
  }),
  ivr: listed({group: 'routing', label: 'IVR menu', path: '/Dialplan/Ivr/', scope: 'dialplan', nameField: 'title'}),
  switches: listed({
    group: 'routing',
    label: 'switch',
    path: '/Dialplan/Switches/',
    scope: 'dialplan',
    nameField: 'title',
  }),
  paging: listed({
    group: 'routing',
    label: 'paging group',
    path: '/Dialplan/PagingGroups/',
    scope: 'dialplan',
    nameField: 'title',
  }),
  queues: listed({
    group: 'routing',
    label: 'queue',
    path: '/Dialplan/CallGroups/',
    scope: 'callgroups',
    nameField: 'title',
  }),
  'dialplan-db': dialplanDb,
  dialplans,
  'dialplan-settings': dialplanSettings,
};

// The objects of each kind: {[kind]: [{id, name, data}]}, or {error} for a kind the PBX refuses to give.
export async function readKinds(client, kinds, {dbFamilies, info = () => {}} = {}) {
  const out = {};
  for (const kind of kinds) {
    try {
      out[kind] = await TRANSFER_KINDS[kind].read(client, {dbFamilies});
    } catch (e) {
      info(`${kind}: not read (${e.message})`);
      out[kind] = {error: e.message};
    }
  }
  return out;
}
