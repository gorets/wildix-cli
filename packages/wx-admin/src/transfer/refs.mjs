// References of a config transfer. toPortable() turns every value that points outside its object (an id, a name or
// an LDAP dn of another object, the PBX itself, a secret, an object outside the PBX) into a marker, so the objects
// mean the same on any PBX; fromPortable() turns the markers back into the values of the target PBX. A last scan
// marks an object `bound` when the serial or the host of the source PBX is still in one of its strings.
//
//   {"$ref": "<kind>/<name>", "as": "id"|"name"|"dn"|"login", "number"?: true}   another object
//   {"$self": "pbx"}                                                            the PBX (pbxid=<serial>,dc=wildix)
//   {"$secret": "<path>"}                                                       a secret, never exported
//   {"$external": "<what>", "value": …}                                         outside the PBX, kept as it is

// The parameters of dialplan applications that point at objects, found live on WMS 7.11 (an empty rule per
// application: the PBX names what it requires). `by` is the form the PBX uses first.
const ID = 'id';
const NAME = 'name';
export const APP_REFS = {
  Queue: {queueId: ['queues', ID], mohClass: ['moh']},
  Timetable: {timetableId: ['timetables', ID], dialplan: ['dialplans', NAME]},
  IVR: {ivrName: ['ivr', NAME]},
  GotoIfSwitchIsOn: {switchId: ['switches', ID], dialplan: ['dialplans', NAME]},
  GotoIf3SwitchIsOnOrBlinking: {
    switchId: ['switches', ID],
    dialplanOn: ['dialplans', NAME],
    dialplanBlinking: ['dialplans', NAME],
  },
  FeaturePaging: {groupId: ['paging', ID]},
  DialTrunk: {trunk: ['trunks-sip', NAME]},
  DialHuntGroup: {huntGroup: ['trunk-groups', NAME]},
  GotoIfUserStatus: {user: ['users', NAME, 'soft'], dialplan: ['dialplans', NAME]},
  Goto: {dialplan: ['dialplans', NAME]},
  GotoIf: {dialplan: ['dialplans', NAME]},
  GotoIfBusyCongested: {dialplan: ['dialplans', NAME]},
  VerifyCaller: {dialplan: ['dialplans', NAME]},
  CorrectOutgoingNumber: {dialplan: ['dialplans', NAME]},
  GotoIfGroupCount: {dialplan: ['dialplans', NAME]},
  DialRemotePbx: {dialplan: ['dialplans', NAME]},
  LookUpCidNameInPhonebook: {phonebookId: ['phonebooks']},
  LookUpDestCidNameInPhonebook: {phonebookId: ['phonebooks']},
  Playback: {filename: ['sounds']},
};
// Kinds a transfer does not carry: their values stay, and the plan checks the target has them.
const OUTSIDE = new Set(['moh', 'sounds', 'phonebooks']);
export const EXTERNAL = {VoiceBot: {botId: 'voicebot'}, DialRemotePbx: {pbx: 'remote-pbx'}};

const SECRET_KEY = /secret|password|passwd|^register$|^key$|apikey|token/i;
const PBXID = /^pbxid=([^,]+),dc=wildix$/i;

// Values that mean the same on every PBX: nothing, "all", a dialplan expression, a built-in (negative) id.
const literal = (v) =>
  v === undefined || v === null || v === '' || v === 'all' || /\$\{/.test(String(v)) || /^-\d+$/.test(String(v));

export const keyOf = (kind, name) => `${kind}/${name}`;
export function splitKey(key) {
  const at = key.indexOf('/');
  return {kind: key.slice(0, at), name: key.slice(at + 1)};
}

const isMarker = (v) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  ('$ref' in v || '$self' in v || '$secret' in v || '$external' in v);

// Lookup tables of the objects of a snapshot, per kind: by id, dn, name and (trunks) login.
function indexOf(snapshot) {
  const idx = {};
  for (const [kind, objects] of Object.entries(snapshot)) {
    if (!Array.isArray(objects)) continue;
    const t = {id: new Map(), dn: new Map(), name: new Map(), login: new Map()};
    for (const o of objects) {
      t.id.set(String(o.id), o.name);
      if (o.dn) t.dn.set(String(o.dn).toLowerCase(), o.name);
      t.name.set(String(o.name), o.name);
      if (kind === 'trunks-sip' && o.data?.name) t.login.set(String(o.data.name), o.name);
    }
    idx[kind] = t;
  }
  return idx;
}

export function toPortable(snapshot, {serial, host}) {
  const idx = indexOf(snapshot);
  const out = {kinds: {}, errors: {}, needs: {}, soft: {}, bound: [], external: [], unresolved: [], outside: []};

  for (const [kind, objects] of Object.entries(snapshot)) {
    if (!Array.isArray(objects)) {
      out.errors[kind] = objects?.error ?? 'not read';
      continue;
    }
    out.kinds[kind] = objects.map((o) => {
      const key = keyOf(kind, o.name);
      const needs = new Set();
      const soft = new Set();
      const at = {kind, name: o.name};

      // A value pointing at an object of `target`: a marker, or the value kept and noted.
      const ref = (value, target, path, order = [ID, 'dn', NAME, 'login'], how) => {
        if (literal(value)) return value;
        if (OUTSIDE.has(target)) {
          out.outside.push({...at, path, kind: target, value: String(value), from: key});
          return value;
        }
        const t = idx[target];
        const s = String(value);
        for (const as of order) {
          const name = t?.[as]?.get(as === 'dn' ? s.toLowerCase() : s);
          if (name === undefined) continue;
          (how === 'soft' ? soft : needs).add(keyOf(target, name));
          return {$ref: keyOf(target, name), as, ...(typeof value === 'number' ? {number: true} : {})};
        }
        if (how === 'soft') {
          soft.add(keyOf(target, s));
          return value;
        }
        out.unresolved.push({...at, path, value: s});
        return value;
      };
      const pathOf = (base, k) => (base ? `${base}.${k}` : k);
      const data = structuredClone(o.data);

      if (kind === 'dialplans') {
        data.includedDialplans = (data.includedDialplans ?? []).map((x, i) => ({
          ...x,
          dialplanId: ref(x.dialplanId, 'dialplans', `includedDialplans[${i}].dialplanId`, [ID, NAME]),
        }));
        for (const [n, num] of (data.numbers ?? []).entries()) {
          for (const [a, application] of (num.apps ?? []).entries()) {
            const params = application.params;
            if (!params || Array.isArray(params)) continue;
            const base = `numbers[${n}].apps[${a}].params`;
            for (const [p, [target, by, how]] of Object.entries(APP_REFS[application.name] ?? {})) {
              if (!(p in params)) continue;
              params[p] = ref(params[p], target, pathOf(base, p), by === ID ? [ID, NAME] : [NAME, ID, 'login'], how);
            }
            for (const [p, what] of Object.entries(EXTERNAL[application.name] ?? {})) {
              if (literal(params[p])) continue;
              out.external.push({...at, path: pathOf(base, p), what});
              params[p] = {$external: what, value: params[p]};
            }
          }
        }
      }
      if (kind === 'acl-groups') {
        if (data.inherits?.dn)
          data.inherits = {...data.inherits, dn: ref(data.inherits.dn, 'acl-groups', 'inherits.dn', ['dn'])};
        data.rules = (data.rules ?? []).map((r, i) => ({
          ...r,
          group: ref(r.group, 'acl-groups', `rules[${i}].group`, ['dn']),
        }));
        data.adminRules = (data.adminRules ?? []).map((r) => {
          const m = PBXID.exec(String(r.subject ?? ''));
          return m && serial && m[1].toLowerCase() === String(serial).toLowerCase()
            ? {...r, subject: {$self: 'pbx'}}
            : r;
        });
      }
      if (kind === 'users') {
        if ('groupDn' in data) data.groupDn = ref(data.groupDn, 'acl-groups', 'groupDn', ['dn']);
        for (const f of ['dialplan', 'faxDialplan']) if (f in data) data[f] = ref(data[f], 'dialplans', f, [NAME]);
      }
      if (kind === 'queues') {
        if (data.settings && 'aclGroup' in data.settings)
          data.settings.aclGroup = ref(data.settings.aclGroup, 'acl-groups', 'settings.aclGroup', ['dn', ID, NAME]);
        for (const m of data.members ?? []) soft.add(keyOf('users', String(m).split(/[@,]/)[0]));
      }
      if (kind === 'trunk-groups') {
        data.rules = (data.rules ?? []).map((r, i) => ({
          ...r,
          trunkName: ref(r.trunkName, 'trunks-sip', `rules[${i}].trunkName`, [NAME, 'login', ID]),
        }));
      }
      if (kind === 'trunks-sip') {
        if (data.settingsPbx && 'context' in data.settingsPbx)
          data.settingsPbx.context = ref(data.settingsPbx.context, 'dialplans', 'settingsPbx.context', [NAME]);
        hideSecrets(data, '');
      }

      out.needs[key] = [...needs].filter((k) => k !== key);
      out.soft[key] = [...soft];
      if (!out.soft[key].length) delete out.soft[key];
      if (!out.needs[key].length) delete out.needs[key];
      scan(data, '', (path, found) => out.bound.push({...at, path, found}), {serial, host});
      return {name: o.name, data};
    });
  }
  return out;
}

// Every non-empty secret of an object becomes {$secret: <its path>}.
function hideSecrets(o, base) {
  for (const [k, v] of Object.entries(o)) {
    const path = base ? `${base}.${k}` : k;
    if (SECRET_KEY.test(k) && typeof v === 'string' && v !== '') o[k] = {$secret: path};
    else if (v && typeof v === 'object' && !isMarker(v)) hideSecrets(v, path);
  }
}

// The safety scan: strings (outside markers) that still hold the source serial or host.
function scan(v, path, hit, {serial, host}) {
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (serial && s.includes(String(serial).toLowerCase())) hit(path, 'serial');
    else if (host && s.includes(String(host).toLowerCase())) hit(path, 'host');
    return;
  }
  if (!v || typeof v !== 'object' || isMarker(v)) return;
  for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v))
    scan(x, Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${k}` : k, hit, {serial, host});
}

// Every $ref of an object, with where it is.
export function refsOf(data, path = '', out = []) {
  if (!data || typeof data !== 'object') return out;
  if (!Array.isArray(data) && typeof data.$ref === 'string') {
    out.push({...splitKey(data.$ref), path});
    return out;
  }
  for (const [k, v] of Array.isArray(data) ? data.entries() : Object.entries(data))
    refsOf(v, Array.isArray(data) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
  return out;
}

export class MissingValue extends Error {}

// The markers of an object replaced by the values of the target: resolve({kind, name, as}) for a $ref,
// resolve.self() for the PBX, resolve.secret(path) for a secret. A $ref or secret without a value throws MissingValue.
export function fromPortable(kind, data, resolve) {
  const walk = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v.$ref === 'string') {
      const {kind: k, name} = splitKey(v.$ref);
      const value = resolve({kind: k, name, as: v.as});
      if (value === undefined) throw new MissingValue(`${kind}: ${v.$ref} is not on the target`);
      return v.number ? Number(value) : value;
    }
    if ('$self' in v) return resolve.self();
    if ('$secret' in v) {
      const value = resolve.secret(v.$secret);
      if (value === undefined) throw new MissingValue(`${kind}: the secret ${v.$secret} was not given`);
      return value;
    }
    if ('$external' in v) return v.value;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(data);
}
