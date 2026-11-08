// References of a config transfer. toPortable() turns every value that points outside its object (an id, a name or
// an LDAP dn of another object, the PBX itself, a secret, an object outside the PBX) into a marker, so the objects
// mean the same on any PBX; fromPortable() turns the markers back into the values of the target PBX. A last scan
// marks an object `bound` when the serial, the host or the company of the source is still in one of its strings, and
// an object of a cloud kind when the mask of the cloud services still hides something in it (a secret not declared).
//
//   {"$ref": "<kind>/<name>", "as": "id"|"name"|"dn"|"login"|"version"|"object", "number"?: true}   another object
//   {"$self": "pbx"}                                                            the PBX (pbxid=<serial>,dc=wildix)
//   {"$secret": "<path>"}                                                       a secret, never exported
//   {"$external": "<what>", "value": …}                                         outside the PBX, kept as it is
//   {"$template": "<string with {0}, {1}…>", "args": [<markers>]}              references inside a string ({{ and }}
//                                                                               are literal braces)

import {maskCloud} from '../cloud/mask.mjs';
import {isMarker, keyOf, splitKey} from './keys.mjs';
import {isCloud, TRANSFER_KINDS} from './kinds.mjs';

export {APP_REFS, EXTERNAL} from './pbx-portable.mjs';
export {keyOf, splitKey};

const ID = 'id';
const NAME = 'name';
// Kinds a transfer does not carry: their values stay, and the plan checks the target has them.
const OUTSIDE = new Set(['moh', 'sounds', 'phonebooks']);
// Values that mean the same on every PBX: nothing, "all", a dialplan expression, a built-in (negative) id.
const literal = (v) =>
  v === undefined || v === null || v === '' || v === 'all' || /\$\{/.test(String(v)) || /^-\d+$/.test(String(v));

// What the mask of the cloud services is checked against: the data with every marker replaced by null, except an
// $external marker, replaced by its value (exported as it is, so a secret in it must be found), and a $template,
// replaced by its string with the placeholders kept (its args are markers).
const withoutMarkers = (v) =>
  isMarker(v)
    ? '$external' in v
      ? withoutMarkers(v.value)
      : '$template' in v
        ? v.$template
        : null
    : Array.isArray(v)
      ? v.map(withoutMarkers)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutMarkers(x)]))
        : v;

// A version as a number when it is one ("3" and 3 are the same version).
const sameVersion = (a, b) => {
  const numeric = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(+v));
  return numeric(a) && numeric(b) ? Number(a) === Number(b) : String(a) === String(b);
};

// The leaf paths where two values differ (dotted, [i] in arrays), the first `limit` of them. Leaves compare as JSON
// with numbers as strings, the rule of the plan (the PBX answers 0 or "0" for the same value); a field on one side
// only is one path.
export function diffPaths(a, b, limit = Number.POSITIVE_INFINITY) {
  const out = [];
  const leaf = (v) => JSON.stringify(typeof v === 'number' ? String(v) : v);
  const isObject = (v) => v !== null && typeof v === 'object';
  const walk = (x, y, path) => {
    if (out.length >= limit) return;
    if (isObject(x) && isObject(y) && Array.isArray(x) === Array.isArray(y)) {
      if (Array.isArray(x)) for (let i = 0; i < Math.max(x.length, y.length); i++) walk(x[i], y[i], `${path}[${i}]`);
      else for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path ? `${path}.${k}` : k);
    } else if (isObject(x) || isObject(y) || leaf(x) !== leaf(y)) out.push(path);
  };
  walk(a, b, '');
  return out;
}

// Why a bound object is left out: the text a hook gave, a secret field the cloud mask found, else what of the source
// is in which field. A hook's own reason (found: 'nango', or a text) reads as a sentence; it names no source PBX.
export const boundText = (b) =>
  typeof b.text === 'string'
    ? b.text
    : b.found === 'secret'
      ? `secret field ${b.path} not known`
      : b.found === 'nango'
        ? `bound to a Nango connection of the source (${b.path})`
        : `${b.found} in ${b.path}`;
// Reasons that already say what the object is bound to (the rest read "bound to the source PBX").
export const ownBoundReason = (b) => typeof b.text === 'string' || b.found === 'secret' || b.found === 'nango';

// The name an object of a kind goes by outside memory: that of a cloud object as the mask of the cloud services shows
// it (a webhook is known by its URL, which may hold a token); the object is then bound (toPortable).
const shownName = (kind, name) => (isCloud(kind) && !TRANSFER_KINDS[kind].lookup ? maskCloud(String(name)) : name);

// Lookup tables of the objects of a snapshot, per kind (lookup kinds too): by id, dn, name and (trunks) login, and
// the latest published version by name. Each answers the name the object goes by (shownName).
function indexOf(snapshot) {
  const idx = {};
  for (const [kind, objects] of Object.entries(snapshot)) {
    if (!Array.isArray(objects)) continue;
    const t = {id: new Map(), dn: new Map(), name: new Map(), login: new Map(), version: new Map()};
    for (const o of objects) {
      const name = shownName(kind, o.name);
      t.id.set(String(o.id), name);
      if (o.version !== undefined) t.version.set(String(name), o.version);
      if (o.dn) t.dn.set(String(o.dn).toLowerCase(), name);
      t.name.set(String(o.name), name);
      if (kind === 'trunks-sip' && o.data?.name) t.login.set(String(o.data.name), name);
    }
    idx[kind] = t;
  }
  return idx;
}

// The helper `h` a portable hook works with, for one object (see pbx-portable.mjs and the kinds):
//   h.ref(value, target, path, order?, how?)  a value pointing at an object of `target`: a $ref, else kept and noted
//                                             (how 'soft': a soft need; how 'drop': undefined, not noted, when
//                                             the source read `target` and has no such object; when it could not
//                                             read it, the object is bound and the value kept; on the target side,
//                                             never dropped: kept as it is, so it compares as it is)
//   h.external(path, what, value)             a value outside the PBX: {$external}, kept as it is and noted
//   h.unresolved(path, value)                 a value kept as it is that should have been a reference
//   h.self()                                  the source PBX ({$self: 'pbx'}); h.serial: its serial, when known
//   h.soft(key)                               a soft need (a user by extension): the plan checks the target has it
//   h.secret(obj, key, path)                  obj[key], when a non-empty string, becomes {$secret: path}
//   h.version(target, name, pinned, path)     a pin on a version of target/name: a version $ref when it is the latest
//                                             published one, else undefined (the hook drops it) and a warning
//   h.template(value, path, pattern, target, order?)
//                                             references inside a string: each match of `pattern` (its group 1) is
//                                             h.ref(…, target, path, order); those that resolve become the args of a
//                                             {$template, args}, the rest stay in the string (none resolves: the
//                                             string as it is)
//   h.bound(path, found, text?)               the object is bound to something of the source (found: 'nango'), or
//                                             left out for the reason `text` (an SQS webhook)
//   h.warn(path, text)                        a warning about the object (portable.warnings, only when there is one)
// Objects of lookup kinds (read-only tables of the target) are only indexed: they are never in `kinds`. side:
// 'target' when the snapshot is that of the target (makePlan), whose objects are only compared.
export function toPortable(snapshot, {serial, host, company, side = 'source'}) {
  const idx = indexOf(snapshot);
  const out = {kinds: {}, errors: {}, needs: {}, soft: {}, bound: [], external: [], unresolved: [], outside: []};

  for (const [kind, objects] of Object.entries(snapshot)) {
    if (!Array.isArray(objects)) {
      out.errors[kind] = objects?.error ?? 'not read';
      continue;
    }
    if (TRANSFER_KINDS[kind]?.lookup) continue;
    out.kinds[kind] = objects.map((o) => {
      // A cloud object whose name the mask changes goes by the masked name everywhere (its entries, its key) and is
      // bound: its name never leaves memory.
      const name = shownName(kind, o.name);
      const key = keyOf(kind, name);
      const needs = new Set();
      const soft = new Set();
      const at = {kind, name};
      const unresolved = (path, value) => out.unresolved.push({...at, path, value: String(value)});
      const unread = new Set(); // the kinds this object's access lists point at that the source could not read

      const h = {
        serial,
        ref(value, target, path, order = [ID, 'dn', NAME, 'login'], how) {
          if (literal(value)) return value;
          // A soft reference (a user by extension) stays as it is: an extension means the same on any PBX.
          if (how === 'soft') {
            soft.add(keyOf(target, String(value)));
            return value;
          }
          if (OUTSIDE.has(target)) {
            out.outside.push({...at, path, kind: target, value: String(value), from: key});
            return value;
          }
          const t = idx[target];
          const s = String(value);
          for (const as of order) {
            const name = t?.[as]?.get(as === 'dn' ? s.toLowerCase() : s);
            if (name === undefined) continue;
            needs.add(keyOf(target, name));
            return {$ref: keyOf(target, name), as, ...(typeof value === 'number' ? {number: true} : {})};
          }
          // An entry of an access list that is no object of the source: undefined, for the hook to drop it. Only
          // when the source read that kind: else the list cannot be checked, and the object is bound.
          if (how === 'drop' && side !== 'target') {
            if (Array.isArray(snapshot[target])) return undefined;
            if (!unread.has(target)) {
              unread.add(target);
              h.bound(path, 'unread', `${target} could not be read on the source: access lists cannot be checked`);
            }
            return value;
          }
          unresolved(path, s);
          return value;
        },
        external(path, what, value) {
          if (literal(value)) return value;
          out.external.push({...at, path, what});
          return {$external: what, value};
        },
        unresolved,
        self: () => ({$self: 'pbx'}),
        soft: (k) => soft.add(k),
        secret(obj, k, path) {
          if (typeof obj[k] === 'string' && obj[k] !== '') obj[k] = {$secret: path};
        },
        version(target, name, pinned, path) {
          if (pinned === undefined || pinned === null || pinned === '') return pinned;
          const latest = idx[target]?.version.get(String(name));
          if (latest !== undefined && sameVersion(pinned, latest)) {
            needs.add(keyOf(target, name));
            return {$ref: keyOf(target, name), as: 'version'};
          }
          h.warn(path, 'pinned to an older version, dropped');
          return undefined;
        },
        template(value, path, pattern, target, order = [ID]) {
          if (typeof value !== 'string') return value;
          const literalPart = (s) => s.replace(/[{}]/g, (c) => c + c);
          const re = new RegExp(pattern.source, [...new Set(`${pattern.flags}dg`)].join(''));
          const args = [];
          let text = '';
          let last = 0;
          for (const m of value.matchAll(re)) {
            if (m[1] === undefined) continue;
            const [start, end] = m.indices[1];
            const r = h.ref(m[1], target, path, order);
            text += literalPart(value.slice(last, start)) + (isMarker(r) ? `{${args.push(r) - 1}}` : literalPart(m[1]));
            last = end;
          }
          return args.length ? {$template: text + literalPart(value.slice(last)), args} : value;
        },
        bound: (path, found, text) => out.bound.push({...at, path, found, ...(text === undefined ? {} : {text})}),
        warn(path, text) {
          (out.warnings ??= []).push({...at, path, text});
        },
      };
      const data = structuredClone(o.data);
      TRANSFER_KINDS[kind]?.portable?.(data, h);

      // The safety net of a cloud kind: what the mask of the cloud services would still hide is a secret the kind
      // does not declare.
      if (isCloud(kind)) {
        const plain = withoutMarkers(data);
        const [path] = diffPaths(maskCloud(plain), plain, 1);
        if (path !== undefined) out.bound.push({...at, path, found: 'secret'});
        else if (name !== o.name) out.bound.push({...at, path: 'name', found: 'secret'});
      }

      out.needs[key] = [...needs].filter((k) => k !== key);
      out.soft[key] = [...soft];
      if (!out.soft[key].length) delete out.soft[key];
      if (!out.needs[key].length) delete out.needs[key];
      scan(data, '', (path, found) => out.bound.push({...at, path, found}), {serial, host, company});
      return {name, data, ...(o.files ? {files: o.files} : {})};
    });
  }
  return out;
}

// The safety scan: strings (outside markers) that still hold the source serial, host or company id.
function scan(v, path, hit, source) {
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    const found = ['serial', 'host', 'company'].find((f) => source[f] && s.includes(String(source[f]).toLowerCase()));
    if (found) hit(path, found);
    return;
  }
  if (v && typeof v === 'object' && typeof v.$template === 'string') return scan(v.$template, path, hit, source);
  if (!v || typeof v !== 'object' || isMarker(v)) return;
  for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v))
    scan(x, Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${k}` : k, hit, source);
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

// ref: the "<kind>/<name>" of a $ref without a value.
export class MissingValue extends Error {
  constructor(message, {ref} = {}) {
    super(message);
    if (ref !== undefined) this.ref = ref;
  }
}

// The markers of an object replaced by the values of the target: resolve({kind, name, as}) for a $ref (a value that
// is an object, as: 'object', is put in as it is), resolve.self() for the PBX, resolve.secret(path) for a secret, the
// args of a $template put in its string. A $ref or secret without a value throws MissingValue.
export function fromPortable(kind, data, resolve) {
  const walk = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v.$ref === 'string') {
      const {kind: k, name} = splitKey(v.$ref);
      const value = resolve({kind: k, name, as: v.as});
      if (value === undefined) throw new MissingValue(`${kind}: ${v.$ref} is not on the target`, {ref: v.$ref});
      return v.number ? Number(value) : value;
    }
    if ('$self' in v) return resolve.self();
    if ('$secret' in v) {
      const value = resolve.secret(v.$secret);
      if (value === undefined) throw new MissingValue(`${kind}: the secret ${v.$secret} was not given`);
      return value;
    }
    if ('$external' in v) return v.value;
    if (typeof v.$template === 'string') {
      const args = v.args.map(walk);
      return v.$template.replace(/\{\{|\}\}|\{(\d+)\}/g, (all, n) => (n === undefined ? all[0] : String(args[n])));
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(data);
}
