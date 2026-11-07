// Writing a config import: the chosen objects of a plan, in the order of TRANSFER_KINDS (what others point at
// first). ACL groups and dialplans point at each other (in cycles too), so the new ones are first made bare and get
// their content in their turn. Every marker becomes the value of the target (ids of objects made in this run
// included); an object that fails is `failed`, and everything that needs it `skip`ped with it as `because`.
import {TRANSFER_KINDS} from './kinds.mjs';
import {fromPortable, keyOf, MissingValue} from './refs.mjs';

const TWO_PASS = ['acl-groups', 'dialplans'];

// plan: makePlan(); chosen: Set of keys; secrets: {[key]: {[path]: value}}; selfDn: "pbxid=<serial of the target>,…"
// (or null when not readable); onEvent(result) after each result. Returns [{key, action, id?, error?, because?}].
export async function applyPlan(client, plan, chosen, {secrets = {}, selfDn, onEvent = () => {}} = {}) {
  const table = {};
  for (const [key, t] of Object.entries(plan.target)) table[key] = {...t};
  const results = [];
  const done = new Map(); // key → result of this run
  const bare = new Set(); // made bare in pass 1, content not written yet
  const report = (r) => {
    // An object made bare whose content was not written stays on the target empty: said so, to be finished.
    if (bare.has(r.key) && (r.action === 'skip' || r.action === 'failed')) r.bare = true;
    results.push(r);
    done.set(r.key, r);
    onEvent(r);
  };
  const items = plan.items.filter((i) => chosen.has(i.key) && (i.state === 'new' || i.state === 'differs'));
  const order = Object.keys(TRANSFER_KINDS);
  items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  const resolveFor = (it) => {
    const resolve = ({kind, name, as}) => {
      const t = table[keyOf(kind, name)];
      if (!t) return undefined;
      if (as === 'id') return t.id;
      if (as === 'dn') return t.dn;
      if (as === 'login') return t.login;
      return name;
    };
    resolve.self = () => {
      if (!selfDn) throw new MissingValue('the serial of the target PBX is not readable');
      return selfDn;
    };
    resolve.secret = (path) => secrets[it.key]?.[path];
    return resolve;
  };
  const failedNeed = (it) => it.needs.find((n) => ['failed', 'skip'].includes(done.get(n)?.action));
  const remember = (it, id) => {
    table[it.key] = {...table[it.key], id: String(id), name: it.name};
    if (it.kind === 'trunks-sip' && typeof it.data.name === 'string') table[it.key].login = it.data.name;
  };

  // Pass 1: the new ACL groups and dialplans, bare, so that everything can point at them.
  for (const it of items.filter((i) => i.state === 'new' && TWO_PASS.includes(i.kind))) {
    const empty = it.kind === 'acl-groups' ? {name: it.name} : {name: it.name, description: it.data.description ?? ''};
    try {
      remember(it, await TRANSFER_KINDS[it.kind].create(client, empty, it.name));
      bare.add(it.key);
    } catch (e) {
      report({key: it.key, action: 'failed', error: e.message});
    }
  }
  // The dns of the ACL groups just made (rules and users point at groups by dn).
  if (items.some((i) => i.kind === 'acl-groups' && i.state === 'new')) {
    for (const g of await TRANSFER_KINDS['acl-groups'].read(client)) {
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
    let data;
    try {
      data = fromPortable(it.kind, it.data, resolveFor(it));
    } catch (e) {
      if (!(e instanceof MissingValue)) throw e;
      const secret = /the secret (\S+) was not given/.exec(e.message);
      const missing = /: (\S+) is not on the target/.exec(e.message);
      report({
        key: it.key,
        action: 'skip',
        because: secret ? `no password: ${secret[1]}` : (missing?.[1] ?? e.message),
      });
      continue;
    }
    const kind = TRANSFER_KINDS[it.kind];
    const existing = table[it.key]?.id;
    try {
      if (it.state === 'differs' || (TWO_PASS.includes(it.kind) && existing)) {
        await kind.update(client, existing, data);
        remember(it, existing);
        bare.delete(it.key);
        report({key: it.key, action: it.state === 'differs' ? 'overwrite' : 'create', id: existing});
      } else {
        const id = await kind.create(client, data, it.name);
        remember(it, id);
        report({key: it.key, action: 'create', id: String(id)});
      }
    } catch (e) {
      report({key: it.key, action: 'failed', error: e.message});
    }
  }
  return results;
}
