// The cloud side of config export, import and copy: which cloud kinds a run carries (all of them with --cloud, else
// those --only names and what they may point at), the clients of the services those kinds use (with the CPA token of
// the PBX; a token the PBX does not give is an AuthError, before anything is read or written in the cloud), and the
// reads with the lookups their references need. A run without a cloud kind builds no client: no cloud call at all.
import {AuthError, UsageError} from 'wldx-core/errors';
import {cloudClient} from '../cloud/client.mjs';
import {cloudToken} from '../cloud/token.mjs';
import {EXPORTED, isCloud, isLookup, readKinds, TRANSFER_KINDS} from './kinds.mjs';
import {refsOf} from './refs.mjs';
import {parseOnly} from './selection.mjs';

// The cloud kinds an export carries, in the order they are written.
export const CLOUD_EXPORTED = EXPORTED.filter(isCloud);

// What the objects of a cloud kind may point at: the `refers` its kind declares next to its portable hook (cloud,
// lookup and PBX kinds), read with it so that its references become markers and an object chosen with --only brings
// them; a kind that declares none may point at any cloud kind. PBX kinds are read anyway.
const refersOf = (kind) => TRANSFER_KINDS[kind]?.refers ?? CLOUD_EXPORTED;

// The cloud kinds of a run: every one with --cloud, else those --only names (a UsageError for a kind an export does
// not carry) with what they may point at; none for a run of the PBX only.
export function cloudKindsOf(values) {
  const wanted = values.only ? parseOnly(values.only).map((w) => w.kind) : [];
  if (values.cloud) return CLOUD_EXPORTED;
  const out = new Set();
  const add = (kind) => {
    if (!isCloud(kind) || isLookup(kind) || out.has(kind)) return;
    out.add(kind);
    for (const k of refersOf(kind)) add(k);
  };
  for (const kind of wanted) add(kind);
  return CLOUD_EXPORTED.filter((k) => out.has(k));
}

// The lookups the objects of these kinds may point at: read on the source, so their ids become names.
const lookupsOf = (kinds) =>
  Object.keys(TRANSFER_KINDS).filter((l) => isLookup(l) && kinds.some((k) => refersOf(k).includes(l)));

// A token the PBX does not give (not an administrator's access, a WMS too old, a PBX not linked to the cloud) is a
// refused access: exit 2, before anything is read or written in the cloud.
async function withToken(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError || e instanceof UsageError) throw e;
    throw new AuthError(e.message);
  }
}

// The company (and the environment) of the PBX of ctx, from its CPA token.
export const companyOf = (ctx) => withToken(async () => (await cloudToken(ctx)).company);

// The clients of the cloud services the cloud kinds among `kinds` use ({wilma?, kb?, integrations?, kite?,
// stream?}), each with the token of the PBX of ctx; {} when there is none.
export async function cloudClients(ctx, kinds) {
  const services = [...new Set(kinds.filter(isCloud).map((k) => TRANSFER_KINDS[k].service))];
  const out = {};
  for (const s of services) out[s] = await withToken(() => cloudClient(ctx, s));
  return out;
}

// Where the cloud clients of a bag are: {company, env} of their token (undefined without one).
export const cloudOf = (clients) => {
  const c = Object.entries(clients).find(([k]) => k !== 'pbx')?.[1];
  return c ? {company: c.company, env: c.env} : {};
};

// The clients of the source of an export: those of the cloud kinds and of their lookups.
export const sourceClients = (ctx, kinds) => cloudClients(ctx, [...kinds, ...lookupsOf(kinds)]);

// The objects of the cloud kinds of the source, with the lookups they point at: the x-bees services and bots, and the
// users they name (by id and by e-mail, through the userIds and userEmails of their kinds; not read when none).
export async function readCloudSource(clients, kinds, {info}) {
  const lookups = lookupsOf(kinds);
  const snapshot = await readKinds(clients, [...kinds, ...lookups.filter((k) => k !== 'xbees-users')], {info});
  if (lookups.includes('xbees-users')) {
    const ids = [];
    const emails = [];
    for (const k of kinds)
      for (const o of Array.isArray(snapshot[k]) ? snapshot[k] : []) {
        ids.push(...(TRANSFER_KINDS[k].userIds?.(o.data) ?? []));
        emails.push(...(TRANSFER_KINDS[k].userEmails?.(o.data) ?? []));
      }
    if (ids.length || emails.length)
      Object.assign(snapshot, await readKinds(clients, ['xbees-users'], {userQuery: {ids, emails}, info}));
  }
  return snapshot;
}

// The kinds to read on the target: those of the export and those its references point at (lookups included).
export function kindsToRead(portable) {
  const kinds = new Set(Object.keys(portable.kinds));
  // queue members and users named by dialplans are checked against the target's users
  if (Object.values(portable.soft ?? {}).some((keys) => keys.some((k) => k.startsWith('users/')))) kinds.add('users');
  for (const list of Object.values(portable.kinds))
    for (const o of list) for (const r of refsOf(o.data)) if (Object.hasOwn(TRANSFER_KINDS, r.kind)) kinds.add(r.kind);
  return Object.keys(TRANSFER_KINDS).filter((k) => kinds.has(k));
}

// The cloud kinds (lookups included) an import reads on its target: what its cloud clients are built for.
export const targetCloudKinds = (portable) => kindsToRead(portable).filter(isCloud);

// The target of an import: every kind to read, the x-bees users last, by the e-mails the export names (and the ids
// the target's own objects name, so that those compare by e-mail too).
export async function readTarget(clients, portable, {dbFamilies, info}) {
  const kinds = kindsToRead(portable);
  const target = await readKinds(
    clients,
    kinds.filter((k) => k !== 'xbees-users'),
    {dbFamilies, info},
  );
  if (kinds.includes('xbees-users')) {
    const emails = new Set();
    for (const list of Object.values(portable.kinds))
      for (const o of list) for (const r of refsOf(o.data)) if (r.kind === 'xbees-users') emails.add(r.name);
    const ids = [];
    for (const [k, list] of Object.entries(target))
      for (const o of Array.isArray(list) ? list : []) ids.push(...(TRANSFER_KINDS[k].userIds?.(o.data) ?? []));
    Object.assign(target, await readKinds(clients, ['xbees-users'], {userQuery: {ids, emails: [...emails]}, info}));
  }
  return target;
}

// The export without the cloud kinds a run does not carry (keep: the cloud kinds it does).
export function withCloudKinds(portable, keep) {
  const left = Object.keys(portable.kinds).filter((k) => isCloud(k) && !keep.includes(k));
  if (!left.length) return {portable, left};
  return {
    portable: {
      ...portable,
      kinds: Object.fromEntries(Object.entries(portable.kinds).filter(([k]) => !left.includes(k))),
    },
    left,
  };
}
