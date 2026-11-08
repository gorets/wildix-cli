// The lookup kinds of the config transfer: read-only tables of the target company that cloud objects point at (the
// services, users and bots conversations go to). They are never exported or written: a reference to one is found on
// the target by name, or mapped there with --map. Operations: ListServices (xbees-kite), ListBots (xbees-users),
// QueryUsers of the Stream directory (POST /api/v1/users/query).
import {listBots, listServices} from '../../commands/kite.mjs';

const lookup = (service, label, read) => ({group: null, label, side: 'cloud', service, lookup: true, read});

// The users are read on demand, never listed: the ids the source objects name and the e-mails the target needs.
// One query carries up to 100 ids and 100 e-mails. A user is known by e-mail, in lower case (the directory matches
// e-mails in any case); one without an e-mail cannot be found on another company and is left out. The directory is
// one for every company and answers the users of all of them: only those of the company of the token are kept (none
// when the token names no company: a user without one is no user of it).
// A value that is not an e-mail (`admin`) is not asked for: the directory refuses the whole query for it (the
// pattern is the one it checks).
const QUERY_MAX = 100;
const EMAIL = /^[\w+-]+(\.[\w+-]+)*@([\w-]+\.)+\w{2,}$/;
async function readUsers(client, {userQuery: {ids = [], emails = []} = {}} = {}) {
  const idList = [...new Set(ids.map(String))];
  const seen = new Set();
  const emailList = emails
    .map(String)
    .filter((e) => EMAIL.test(e) && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
  const found = new Map();
  for (let at = 0; at < Math.max(idList.length, emailList.length); at += QUERY_MAX) {
    const query = {};
    if (at < idList.length) query.ids = idList.slice(at, at + QUERY_MAX);
    if (at < emailList.length) query.emails = emailList.slice(at, at + QUERY_MAX);
    const answer = await client.call('POST', '/api/v1/users/query', {json: {query}});
    for (const u of answer?.users ?? [])
      if (u?.id && u.email && client.company && u.companyId === client.company) found.set(String(u.id), u);
  }
  return [...found.values()].map((u) => ({id: String(u.id), name: String(u.email).toLowerCase(), data: {}}));
}

export const LOOKUP_KINDS = {
  // A service by its title; what a target needs of it is {id, uri}. x-bees makes a service of each call group of the
  // PBX (same id, same title): one for a queue written in this run appears only once the PBX has synced it.
  'xbees-services': {
    ...lookup('kite', 'x-bees service', async (client) =>
      (await listServices(client)).map((s) => ({
        id: String(s.id),
        name: String(s.title),
        value: {id: s.id, uri: s.uri},
        data: {},
      })),
    ),
    syncedFrom: 'queues',
  },
  'xbees-users': lookup('stream', 'x-bees user', readUsers),
  'xbees-bots': lookup('kite', 'x-bees bot', async (client) =>
    (await listBots(client)).map((b) => ({id: String(b.id), name: String(b.name), data: {}})),
  ),
};
