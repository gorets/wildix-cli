// Writing a config import: the chosen objects of a plan, in the order of TRANSFER_KINDS (what others point at
// first). Objects of a twoPass kind may point at each other (ACL groups and dialplans, in cycles too), so the new ones
// are first made bare and get their content in their turn. Every marker becomes the value of the target (ids and
// versions of objects made in this run included); an object that fails is `failed` (with the `stage` of a multi-step
// write), and everything that needs it `skip`ped with it as `because`. A secret without a value follows the policy
// its kind declares for it (secrets[].empty); an undeclared one skips the object. On an overwrite, a `generate` or
// `pending` secret without a value is left out of the data: the target keeps its own.
import {randomBytes} from 'node:crypto';
import {MASK} from '../cloud/mask.mjs';
import {accessRefused} from '../pbx.mjs';
import {clientOf, isCloud, TRANSFER_KINDS} from './kinds.mjs';
import {StageError} from './stage-error.mjs';
import {fromPortable, keyOf, MissingValue, splitKey} from './refs.mjs';

export {StageError};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// A new secret: 30 characters of [A-Za-z0-9], unbiased (bytes beyond the last whole multiple of 62 are dropped).
function generateSecret(length = 30) {
  let out = '';
  while (out.length < length)
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += ALPHABET[b % 62];
    }
  return out;
}

const isSecret = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$secret === 'string';
// The paths of the $secret markers of an object.
function secretPaths(v, out = []) {
  if (!v || typeof v !== 'object') return out;
  if (isSecret(v)) out.push(v.$secret);
  else for (const x of Array.isArray(v) ? v : Object.values(v)) secretPaths(x, out);
  return out;
}
// The object without the $secret markers of `paths` (a field holding one is left out).
function withoutSecrets(v, paths) {
  if (!v || typeof v !== 'object' || isSecret(v)) return v;
  const drop = (x) => isSecret(x) && paths.includes(x.$secret);
  if (Array.isArray(v)) return v.filter((x) => !drop(x)).map((x) => withoutSecrets(x, paths));
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => !drop(x))
      .map(([k, x]) => [k, withoutSecrets(x, paths)]),
  );
}
// What an object skipped for a secret without a value is `because` of: `no secret: <path>` (a declared path), `no
// password: <path>` (an undeclared one, as a trunk's).
export const SECRET_SKIP = /^no (?:password|secret): /;

// The policy of a secret path: the kind's declaration (an exact path or a RegExp), else `skip`.
export const policyOf = (kind, path) =>
  kind.secrets?.find((s) => (typeof s.path === 'string' ? s.path === path : s.path.test(path)));

// What the secrets of an object without a value (given: {[path]: value}) mean, by the policy of their path:
// {skipped: why} when one skips the object, else {left: paths left out of the data, flags: {pending?,
// unconfigured?}, generate: paths to give a new secret}. Nothing is generated here.
function emptySecrets(it, kind, given) {
  const left = [];
  const flags = {};
  const generate = [];
  for (const path of new Set(secretPaths(it.data))) {
    const policy = policyOf(kind, path);
    // An undeclared path keeps the PBX rule: only a missing value is empty ('' is written as it is).
    if (given[path] !== undefined && (!policy || given[path] !== '')) continue;
    if (!policy || policy.empty === 'skip') return {skipped: `${policy ? 'no secret' : 'no password'}: ${path}`};
    if (it.state === 'differs' && (policy.empty === 'generate' || policy.empty === 'pending'))
      left.push(path); // the target keeps its value
    else if (policy.empty === 'generate') generate.push(path);
    else {
      left.push(path);
      flags[policy.empty === 'pending' ? 'pending' : 'unconfigured'] = true;
    }
  }
  return {left, flags, generate};
}

// Why an object is skipped for a value the target lacks ({because, syncWait?}): the reference (a lookup the target
// makes of a PBX object it syncs, such as the x-bees service of a call group made in this run: not synced yet, a
// wait), else the message.
function missingBecause(e) {
  const ref = e.ref === undefined ? undefined : splitKey(e.ref);
  if (ref && TRANSFER_KINDS[ref.kind]?.syncedFrom)
    return {because: `x-bees has not synced ${ref.name} yet: re-run in a few minutes`, syncWait: true};
  return {because: /: (\S+) is not on the target/.exec(e.message)?.[1] ?? e.message};
}

// Items in kind order, and inside a cloud kind what an object points at first (an MCP tool after its server): each
// turn takes the first item (in the order given) whose needs of its own kind are placed; in a cycle, the first one
// left. PBX kinds keep the order given (their objects that point at each other are made bare first).
function byNeeds(items) {
  const out = [];
  const placed = new Set();
  const kindOf = new Map(items.map((i) => [i.key, i.kind]));
  const ready = (it) => it.needs.every((n) => n === it.key || kindOf.get(n) !== it.kind || placed.has(n));
  const left = [...items];
  while (left.length) {
    const kind = left[0].kind;
    const at = isCloud(kind) ? left.findIndex((it) => it.kind === kind && ready(it)) : 0;
    const [it] = left.splice(Math.max(at, 0), 1); // none ready: a cycle, the first one left
    placed.add(it.key);
    out.push(it);
  }
  return out;
}

// clients: {pbx, …} (each kind writes with its own, clientOf); plan: makePlan(); chosen: Set of keys; secrets:
// {[key]: {[path]: value}}; selfDn: "pbxid=<serial of the target>,…" (or null when not readable); onEvent(result)
// after each result. Returns [{key, action, id?, version?, steps? (of a write hook), stage?, error?, because?,
// syncWait?, pending?, unconfigured?, generated?: {path}, bare?}], with the generated secret values only in its
// non-enumerable `generatedSecrets` ({[key]: {[path]: value}}).
export async function applyPlan(clients, plan, chosen, {secrets = {}, selfDn, onEvent = () => {}} = {}) {
  const table = {};
  for (const [key, t] of Object.entries(plan.target)) table[key] = {...t};
  const results = [];
  const generatedSecrets = {};
  Object.defineProperty(results, 'generatedSecrets', {value: generatedSecrets, enumerable: false});
  const done = new Map(); // key → result of this run
  const bare = new Set(); // made bare in pass 1, content not written yet
  const report = (r) => {
    // An object made bare whose content was not written stays on the target empty: said so, to be finished.
    if (bare.has(r.key) && (r.action === 'skip' || r.action === 'failed')) r.bare = true;
    results.push(r);
    done.set(r.key, r);
    onEvent(r);
  };
  // made(id): called when a StageError names the id of an object an earlier step made (it is on the target). given:
  // the secret values of the object (given and generated): cut out of the message, whatever the kind put in it.
  const fail = (it, e, made = () => ({}), given = secrets[it.key]) => {
    if (accessRefused(e)) throw e;
    const stage = e instanceof StageError ? {stage: e.stage} : {};
    const id = e instanceof StageError && e.id !== undefined ? {id: e.id, ...made(e.id)} : {};
    const values = Object.values(given ?? {}).filter((v) => typeof v === 'string' && v !== '');
    const error = values.reduce((m, v) => m.split(v).join(MASK), String(e.message));
    report({key: it.key, action: 'failed', ...stage, ...id, error});
  };
  const order = Object.keys(TRANSFER_KINDS);
  const items = byNeeds(
    plan.items
      .filter((i) => chosen.has(i.key) && (i.state === 'new' || i.state === 'differs'))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
  );

  // given: the secret values of this object ({[path]: value}).
  const resolveFor = (given = {}) => {
    const resolve = ({kind, name, as}) => {
      const t = table[keyOf(kind, name)];
      if (!t) return undefined;
      if (as === 'id') return t.id;
      if (as === 'dn') return t.dn;
      if (as === 'login') return t.login;
      if (as === 'version') return t.version;
      if (as === 'object') return t.value;
      return name;
    };
    resolve.self = () => {
      if (!selfDn) throw new MissingValue('the serial of the target PBX is not readable');
      return selfDn;
    };
    resolve.secret = (path) => given[path];
    return resolve;
  };
  const failedNeed = (it) => it.needs.find((n) => ['failed', 'skip'].includes(done.get(n)?.action));
  const remember = (it, id, version) => {
    table[it.key] = {...table[it.key], id: String(id), name: it.name, ...(version !== undefined ? {version} : {})};
    if (it.kind === 'trunks-sip' && typeof it.data.name === 'string') table[it.key].login = it.data.name;
  };

  // Pass 1 makes no placeholder of what is skipped anyway: an object a secret it lacks skips (by its policy), or, of a
  // cloud kind, one whose needs already failed. PBX kinds keep their first pass as it was (made bare, skipped after).
  const willSkip = (it) =>
    emptySecrets(it, TRANSFER_KINDS[it.kind], {...secrets[it.key]}).skipped ??
    (isCloud(it.kind) ? failedNeed(it) : undefined);

  // Pass 1: the new objects of the twoPass kinds, bare, so that everything can point at them.
  for (const it of items.filter((i) => i.state === 'new' && TRANSFER_KINDS[i.kind].twoPass)) {
    const because = willSkip(it);
    if (because) {
      report({key: it.key, action: 'skip', because});
      continue;
    }
    const kind = TRANSFER_KINDS[it.kind];
    const data = kind.twoPass.bare(it.data);
    try {
      const client = clientOf(kind, clients);
      if (kind.write) {
        const answer = await kind.write(client, it, data, {existing: undefined, resolve: resolveFor(), bare: true});
        remember(it, answer.id);
      } else remember(it, await kind.create(client, data, it.name));
      bare.add(it.key);
    } catch (e) {
      fail(it, e, (id) => {
        remember(it, id);
        bare.add(it.key);
        return {};
      });
    }
  }
  // The dns of the ACL groups just made (rules and users point at groups by dn).
  if (items.some((i) => i.kind === 'acl-groups' && i.state === 'new')) {
    const groups = TRANSFER_KINDS['acl-groups'];
    for (const g of await groups.read(clientOf(groups, clients))) {
      const key = keyOf('acl-groups', g.name);
      table[key] = {...table[key], id: g.id, dn: g.dn, name: g.name};
    }
  }

  // Pass 2: every object, whole, in order.
  for (const it of items) {
    if (done.has(it.key)) continue;
    const blocker = failedNeed(it);
    if (blocker) {
      report({key: it.key, action: 'skip', because: blocker});
      continue;
    }
    const kind = TRANSFER_KINDS[it.kind];

    // The secrets without a value, by the policy of their path.
    const given = {...secrets[it.key]};
    const {skipped, left, flags, generate: generated} = emptySecrets(it, kind, given);
    if (skipped) {
      report({key: it.key, action: 'skip', because: skipped});
      continue;
    }
    for (const path of generated) given[path] = generateSecret();

    const resolve = resolveFor(given);
    let data;
    try {
      data = fromPortable(it.kind, left.length ? withoutSecrets(it.data, left) : it.data, resolve);
    } catch (e) {
      if (!(e instanceof MissingValue)) throw e;
      report({key: it.key, action: 'skip', ...missingBecause(e)});
      continue;
    }
    const existing = table[it.key]?.id;
    const action = it.state === 'differs' ? 'overwrite' : 'create';
    const extra = {
      ...(flags.pending ? {pending: true} : {}),
      // An overwrite leaves the target's own configuration: only a new object is unconfigured.
      ...(flags.unconfigured && it.state !== 'differs' ? {unconfigured: true} : {}),
      ...(generated.length ? {generated: {path: generated.join(', ')}} : {}),
    };
    // A generated secret is on the target once the object is: its value goes to generatedSecrets only.
    const keepGenerated = () => {
      if (generated.length) generatedSecrets[it.key] = Object.fromEntries(generated.map((p) => [p, given[p]]));
    };
    try {
      const client = clientOf(kind, clients);
      let id;
      let version;
      let notes;
      let steps;
      if (kind.write) {
        const answer = await kind.write(client, it, data, {
          existing,
          resolve,
          ...(flags.unconfigured ? {unconfigured: true} : {}),
        });
        ({id, version, notes, steps} = answer);
      } else if (existing !== undefined && (it.state === 'differs' || kind.twoPass)) {
        await kind.update(client, existing, data);
        id = existing;
      } else id = await kind.create(client, data, it.name);
      remember(it, id, version);
      bare.delete(it.key);
      keepGenerated();
      report({
        key: it.key,
        action,
        id: String(id),
        ...(version !== undefined ? {version} : {}),
        ...(notes?.length ? {notes} : {}),
        ...(steps?.length ? {steps} : {}),
        ...extra,
      });
    } catch (e) {
      fail(
        it,
        e,
        (id) => {
          remember(it, id);
          keepGenerated();
          return extra;
        },
        given,
      );
    }
  }
  return results;
}
