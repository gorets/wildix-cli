// wx-admin queue: the call groups (call queues) of a PBX, over the PBX REST API. The OpenAPI spreads them over three
// tags; they are one object with one id (checked live: the same ids, title = name):
//   - Dialplan Call Groups, /Dialplan/CallGroups/ (scope callgroups): the configuration of WMS → Dialplan → Call
//     groups: {id, title, members, settings}. members are the static ones, "101@internalcalls" ("…,2" adds a priority
//     for the priority strategy). There is no GET of one group: the list is read and the group picked from it. POST
//     and PUT answer "Success" without the object: create reads the list again to find the new id by its title.
//     GET /Dialplan/CallGroups/{id}/stat: the counters of the queue now (members logged in, available, busy; calls waiting).
//   - Call Queue, /PBX/settings/CallQueues/ (scope callgroups): the same queues as they run now: {id, name, members:
//     [{name: "Local/101@internalcalls", stateInterface: "SIP/101", membership: static|dynamic, penalty, callsTaken,
//     lastCall, isInCall, status (the device state), paused}]}. Dynamic members (agents who log in and out) are added
//     and removed here: POST …/{id}/members/dynamic/, DELETE …/{id}/members/dynamic/{member, URI-encoded}.
//   - Call Group Management, /api/v2/call-groups/{id}/ (scope pbx:*; served at https://<pbx>/api/v2, outside
//     /api/v1): the same ids, for delegated managers (users with MANAGE_CALLGROUP on the ACL group of
//     settings.aclGroup) who are not admins: dynamic members (--manager) and the forward of a call in the queue.
// In the settings the OpenAPI enums of autoPause (no|yes|all) and announce.holdTime (yes|no|once) are strings: a
// YAML 1.1 reader turns them into booleans.
import {readJsonInput as readJsonFile} from 'wldx-core/files';
import {pickByName} from '../match.mjs';
import {UsageError} from 'wldx-core/errors';
import {oneLine, paint, table} from 'wldx-core/format';
import {apiPath} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';

const SCOPE = 'callgroups';
export const STRATEGIES = ['ringall', 'wringall', 'roundrobin', 'leastrecent', 'fewestcalls', 'linear', 'priority'];
// Settings the PBX gives and does not take back (readonly in the OpenAPI).
const READONLY = ['autoPauseBusy', 'autoPauseUnAvail'];
// The settings of a new group, the defaults of the OpenAPI: POST refuses a group without retry, autoPauseTime,
// autoPauseDelay and maxLen ("FieldRequired", seen live), so create fills them.
const DEFAULTS = {
  strategy: 'ringall',
  timeout: 60,
  retry: 1,
  maxLen: 5,
  wrapUpTime: 0,
  weight: 0,
  ringInUse: false,
  autoPause: 'no',
  autoPauseTime: 5,
  autoPauseDelay: 0,
  queueManager: '',
  cid: '',
  rule: '',
  announce: {frequency: 0, holdTime: 'yes'},
  exitAllMembers: {busy: false, paused: false, ringing: false},
};
// Asterisk device states of queue members (status of /PBX/settings/CallQueues/{id}/).
const DEVICE = [
  'unknown',
  'not in use',
  'in use',
  'busy',
  'invalid',
  'unavailable',
  'ringing',
  'ringing, in use',
  'on hold',
];

async function readJsonInput(ctx, from) {
  const data = await readJsonFile(ctx, from); // no credentials, nothing hidden in the home folder
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new UsageError('--from holds one JSON object {title?, members?, settings?}');
  return data;
}

const listGroups = async (client) =>
  (await client.call('GET', '/Dialplan/CallGroups/', undefined, {scope: SCOPE}))?.records ?? [];

// A call group by id or by title (exact, then without case).
async function findGroup(client, ref) {
  const s = String(ref);
  const list = await listGroups(client);
  if (/^\d+$/.test(s)) {
    const found = list.find((g) => String(g.id) === s);
    if (!found) throw new UsageError(`No call group ${s} (wx-admin queue list)`);
    return found;
  }
  return pickByName(list, s, (g) => g.title, 'call group', 'wx-admin queue list');
}

// The id of a queue: digits as they are (no request: a delegated manager may not read the list), else by title.
const queueId = async (client, ref) => (/^\d+$/.test(String(ref)) ? Number(ref) : (await findGroup(client, ref)).id);

// A static member: an extension ("101", "101,2" with a priority) → "101@internalcalls[,2]"; "x@context[,p]" as given.
function staticMember(spec) {
  const s = String(spec).trim();
  const m = /^([A-Za-z0-9_*#+.-]+)(@[A-Za-z0-9_-]+)?(,[1-9]\d*)?$/.exec(s);
  if (!m) throw new UsageError(`A member is an extension, or extension@context, with ,PRIORITY if needed: ${spec}`);
  return `${m[1]}${m[2] ?? '@internalcalls'}${m[3] ?? ''}`;
}

// A dynamic member (an interface of the queue): an extension → "Local/101@internalcalls"; "Local/…", "SIP/…" as given.
function dynamicMember(spec) {
  const s = String(spec).trim();
  if (/^\d+$/.test(s)) return `Local/${s}@internalcalls`;
  if (/^(Local|SIP|PJSIP)\/[A-Za-z0-9_.+-]+(@[A-Za-z0-9_-]+)?$/.test(s)) return s;
  throw new UsageError(`A dynamic member is an extension, Local/EXT@CONTEXT or SIP/EXT: ${spec}`);
}

const TITLE = /^[^\x00-\x1f\x7f/\\]{1,64}$/;

const settingOptions = {
  strategy: {type: 'string', choices: STRATEGIES, description: 'how calls ring the members'},
  timeout: {type: 'string', placeholder: 'SECONDS', description: 'how long a member rings (0 to 120)'},
  'wrap-up': {type: 'string', placeholder: 'SECONDS', description: 'pause of a member after a call'},
  'max-len': {type: 'string', placeholder: 'N', description: 'at most N calls waiting'},
  member: {
    type: 'string',
    multiple: true,
    placeholder: 'EXT',
    description: 'a static member: an extension, EXT@CONTEXT, EXT,PRIORITY',
  },
};

// The settings the options change, checked.
function settingChanges(values) {
  const out = {};
  if (values.strategy !== undefined) out.strategy = values.strategy;
  const num = (opt, key, max) => {
    if (values[opt] === undefined) return;
    const n = Number(values[opt]);
    if (!/^\d+$/.test(values[opt]) || (max !== undefined && n > max))
      throw new UsageError(`--${opt} is a whole number${max !== undefined ? ` up to ${max}` : ''}: ${values[opt]}`);
    out[key] = n;
  };
  num('timeout', 'timeout', 120);
  num('wrap-up', 'wrapUpTime');
  num('max-len', 'maxLen');
  return out;
}

// What PUT takes back of a group: everything but the readonly settings.
function writable(g) {
  const settings = Object.fromEntries(Object.entries(g.settings ?? {}).filter(([k]) => !READONLY.includes(k)));
  if (settings.announce && typeof settings.announce === 'object') {
    const {roundSeconds, ...announce} = settings.announce;
    settings.announce = announce;
  }
  return {title: g.title, members: g.members ?? [], settings};
}

const memberExt = (m) => String(m).replace(/@internalcalls/, '');

const header = (g) => {
  const s = g.settings ?? {};
  const bits = [
    s.strategy,
    s.timeout !== undefined ? `ring ${s.timeout} s` : '',
    s.wrapUpTime ? `wrap-up ${s.wrapUpTime} s` : '',
    s.maxLen ? `up to ${s.maxLen} waiting` : '',
  ].filter(Boolean);
  return `${g.title} (id ${g.id})${bits.length ? `: ${bits.join(', ')}` : ''}`;
};

function groupLines(g, ctx) {
  const c = paint(ctx);
  const lines = [header(g), `members: ${g.members?.length ? g.members.map(memberExt).join(', ') : c.dim('none')}`];
  if (g.liveMembers) {
    lines.push(g.liveMembers.length ? 'now:' : c.dim('nobody in the queue now'));
    lines.push(
      ...table(
        g.liveMembers.map((m) => [
          `  ${m.name}`,
          m.membership ?? '',
          `${DEVICE[Number(m.status)] ?? String(m.status ?? '')}${m.paused === '1' || m.paused === 1 ? c.yellow(', paused') : ''}`,
          `${m.callsTaken ?? 0} calls`,
        ]),
      ),
    );
  }
  return lines;
}

// A request to the v2 routes of the call groups (https://<pbx>/api/v2/…): see the comment at the top.
const v2 = (client, method, apiPathOf, body) => client.call(method, apiPathOf, body, {scope: 'pbx', api: 'v2'});

export const groups = {
  queue: {
    summary: 'call groups (queues): list, show, create, change, delete, stats, dynamic members, forward a call',
    commands: {
      list: {
        summary: 'the call groups of the PBX',
        usage: 'wx-admin queue list',
        options: {},
        args: [0, 0],
        readOnly: true,
        async run(ctx) {
          return {records: await listGroups(await pbxClient(ctx))};
        },
        text: (r) =>
          r.records.length
            ? table(
                r.records.map((g) => [
                  g.id,
                  g.title,
                  g.settings?.strategy ?? '',
                  `${g.members?.length ?? 0} ${g.members?.length === 1 ? 'member' : 'members'}`,
                ]),
              )
            : 'No call groups',
      },
      get: {
        summary: 'one call group: settings, static members, and who is in the queue now',
        usage: 'wx-admin queue get <queue>',
        details:
          'A queue is its id or its name. liveMembers is the queue as it runs now (static and dynamic members, their state).',
        options: {},
        args: [1, 1],
        readOnly: true,
        async run(ctx) {
          const client = await pbxClient(ctx);
          const g = await findGroup(client, ctx.positionals[0]);
          const q = await client.call('GET', apiPath`/PBX/settings/CallQueues/${g.id}/`, undefined, {scope: SCOPE});
          return {...g, liveMembers: q?.members ?? []};
        },
        text: (g, ctx) => groupLines(g, ctx),
      },
      create: {
        summary: 'create a call group',
        usage:
          'wx-admin queue create <name> [--member EXT]... [--strategy S] [--timeout SECONDS] [--wrap-up SECONDS] [--max-len N] [--from FILE|-]',
        details: [
          '--from reads {members, settings} as JSON (as queue get --output json gives them); the options win.',
          'The group is not reachable until a dialplan sends calls to it (an application Queue).',
        ].join('\n'),
        options: {
          ...settingOptions,
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'members and settings as JSON (a file, or - for stdin)',
          },
        },
        args: [1, 1],
        async run(ctx) {
          const title = ctx.positionals[0];
          if (!TITLE.test(title))
            throw new UsageError(`A call group name is 1 to 64 characters, without / and \\: ${title}`);
          const src = ctx.values.from ? await readJsonInput(ctx, ctx.values.from) : {};
          const members = (ctx.values.member ?? src.members ?? []).map(staticMember);
          const body = {
            title,
            members,
            settings: {...DEFAULTS, ...(src.settings ?? {}), ...settingChanges(ctx.values)},
          };
          const client = await pbxClient(ctx);
          const before = await listGroups(client);
          if (before.some((g) => g.title === title))
            throw new UsageError(`A call group ${title} exists: choose another name`);
          await client.call('POST', '/Dialplan/CallGroups/', body, {scope: SCOPE});
          const made = (await listGroups(client)).filter(
            (g) => g.title === title && !before.some((b) => b.id === g.id),
          );
          if (!made.length) throw new Error(`The PBX answered Success, but no call group ${title} is in its list`);
          return made.at(-1);
        },
        text: (g, ctx) => [`Created ${header(g)}`, ...groupLines(g, ctx).slice(1)],
      },
      update: {
        summary: 'change a call group: name, settings, static members (--member replaces them)',
        usage:
          'wx-admin queue update <queue> [--name NAME] [--member EXT]... [--no-members] [--strategy S] [--timeout SECONDS] [--wrap-up SECONDS] [--max-len N] [--from FILE|-] [--yes]',
        details:
          'The group is read and written back whole; --from holds {title?, members?, settings?} (settings are merged).',
        options: {
          name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
          ...settingOptions,
          'no-members': {type: 'boolean', description: 'remove every static member'},
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'title, members and settings as JSON (a file, or - for stdin)',
          },
          yes: {
            type: 'boolean',
            description: 'yes, replace the static members (--member, --no-members, members in --from)',
          },
        },
        args: [1, 1],
        async run(ctx) {
          const v = ctx.values;
          const changes = settingChanges(v);
          if (v.name === undefined && !v.member && !v['no-members'] && !v.from && !Object.keys(changes).length)
            throw new UsageError('Nothing to change', ctx.usage());
          if (v.member && v['no-members']) throw new UsageError('--member or --no-members, not both');
          if (v.name !== undefined && !TITLE.test(v.name))
            throw new UsageError(`A call group name is 1 to 64 characters, without / and \\: ${v.name}`);
          const src = v.from ? await readJsonInput(ctx, v.from) : {};
          if ((v.member || v['no-members'] || src.members !== undefined) && !v.yes)
            throw new UsageError(
              'Replacing the static members changes who the queue rings: confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const current = await findGroup(client, ctx.positionals[0]);
          const body = writable(current);
          if (src.title !== undefined) body.title = src.title;
          if (v.name !== undefined) body.title = v.name;
          // The members the PBX has stay as they are; new ones are checked.
          if (src.members !== undefined) body.members = src.members.map(staticMember);
          if (v.member) body.members = v.member.map(staticMember);
          if (v['no-members']) body.members = [];
          body.settings = {...body.settings, ...(src.settings ?? {}), ...changes};
          await client.call('PUT', apiPath`/Dialplan/CallGroups/${current.id}/`, body, {scope: SCOPE});
          return {...body, id: current.id};
        },
        text: (g, ctx) => [`Updated ${header(g)}`, ...groupLines(g, ctx).slice(1)],
      },
      delete: {
        summary: 'delete call groups (needs --yes: calls sent to them stop)',
        usage: 'wx-admin queue delete <queue>... --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete them'}},
        args: [1, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'Deleting a call group stops the calls the dialplans send to it: confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const found = [];
          for (const ref of ctx.positionals) found.push(await findGroup(client, ref));
          const deleted = [];
          for (const g of found) {
            await client.call('DELETE', apiPath`/Dialplan/CallGroups/${g.id}/`, undefined, {scope: SCOPE});
            deleted.push({id: g.id, title: g.title});
          }
          return {deleted};
        },
        text: (r) => r.deleted.map((g) => `Deleted ${g.title} (id ${g.id})`),
      },
      stats: {
        summary: 'the queues now: members logged in, available, busy; calls waiting (all, or the ones given)',
        usage: 'wx-admin queue stats [<queue>...]',
        options: {},
        args: [0, 50],
        readOnly: true,
        async run(ctx) {
          const client = await pbxClient(ctx);
          const ids = [];
          if (!ctx.positionals.length) for (const g of await listGroups(client)) ids.push(g.id);
          for (const ref of ctx.positionals) ids.push(await queueId(client, ref));
          const stats = [];
          for (const id of ids)
            stats.push(await client.call('GET', apiPath`/Dialplan/CallGroups/${id}/stat`, undefined, {scope: SCOPE}));
          return {stats};
        },
        text(r, ctx) {
          if (!r.stats.length) return 'No call groups';
          const c = paint(ctx);
          return table([
            [
              c.dim('id'),
              c.dim('queue'),
              c.dim('members'),
              c.dim('logged in'),
              c.dim('available'),
              c.dim('busy'),
              c.dim('waiting'),
            ],
            ...r.stats.map((s) => [
              s.id,
              s.title,
              s.totalMembers,
              s.loggedMembers,
              s.availableMembers,
              s.busyMembers,
              s.waitingCalls ? c.yellow(s.waitingCalls) : s.waitingCalls,
            ]),
          ]);
        },
      },
      'member-add': {
        summary: 'add a dynamic member (an agent) to a queue, at once, until removed',
        usage: 'wx-admin queue member-add <queue> <member> [--penalty N] [--paused] [--manager]',
        details: [
          'A member is an extension (Local/EXT@internalcalls), or an interface: Local/EXT@CONTEXT, SIP/EXT.',
          '--manager uses the API of the delegated managers (MANAGE_CALLGROUP on the ACL group of the queue; scope pbx:*):',
          'for a user who manages the queue without being an admin.',
        ].join('\n'),
        options: {
          penalty: {type: 'string', placeholder: 'N', description: 'the penalty of the member (higher rings later)'},
          paused: {type: 'boolean', description: 'add the member paused'},
          manager: {type: 'boolean', description: 'as a delegated manager of the queue (the /api/v2 routes)'},
        },
        args: [2, 2],
        async run(ctx) {
          const v = ctx.values;
          const member = dynamicMember(ctx.positionals[1]);
          if (v.penalty !== undefined && !/^\d+$/.test(v.penalty))
            throw new UsageError(`--penalty is a whole number: ${v.penalty}`);
          const body = {
            member,
            ...(v.penalty !== undefined ? {penalty: Number(v.penalty)} : {}),
            ...(v.paused ? {paused: 1} : {}),
          };
          const client = await pbxClient(ctx);
          const id = await queueId(client, ctx.positionals[0]);
          const r = v.manager
            ? await v2(client, 'POST', apiPath`/call-groups/${id}/members/dynamic/`, body)
            : await client.call('POST', apiPath`/PBX/settings/CallQueues/${id}/members/dynamic/`, body, {scope: SCOPE});
          return {queue: id, member, result: r};
        },
        text: (r) =>
          `Added ${r.member} to the queue ${r.queue}${r.result?.Message ? ` (${oneLine(r.result.Message, 80)})` : ''}`,
      },
      'member-remove': {
        summary: 'remove a dynamic member (an agent) from a queue',
        usage: 'wx-admin queue member-remove <queue> <member> [--manager]',
        details: 'Static members (the ones of the configuration) are changed with queue update --member.',
        options: {manager: {type: 'boolean', description: 'as a delegated manager of the queue (the /api/v2 routes)'}},
        args: [2, 2],
        async run(ctx) {
          const member = dynamicMember(ctx.positionals[1]);
          const client = await pbxClient(ctx);
          const id = await queueId(client, ctx.positionals[0]);
          const encoded = encodeURIComponent(member);
          const r = ctx.values.manager
            ? await v2(client, 'DELETE', `${apiPath`/call-groups/${id}/members/dynamic/`}${encoded}`)
            : await client.call(
                'DELETE',
                `${apiPath`/PBX/settings/CallQueues/${id}/members/dynamic/`}${encoded}`,
                undefined,
                {scope: SCOPE},
              );
          return {queue: id, member, result: r};
        },
        text: (r) =>
          `Removed ${r.member} from the queue ${r.queue}${r.result?.Message ? ` (${oneLine(r.result.Message, 80)})` : ''}`,
      },
      forward: {
        summary: 'forward a call waiting in a queue to an extension or a number',
        usage: 'wx-admin queue forward <queue> <sip-call-id> <destination>',
        details: [
          'The call is the SIP Call-ID of a call in the queue now (as the call events of the PBX name it).',
          'It uses the API of the delegated managers (MANAGE_CALLGROUP on the ACL group of the queue; scope pbx:*).',
        ].join('\n'),
        options: {},
        args: [3, 3],
        async run(ctx) {
          const [ref, sipCallId, destination] = ctx.positionals;
          if (!/^[^\s]{1,100}$/.test(sipCallId)) throw new UsageError(`Not a SIP Call-ID: ${sipCallId}`);
          if (!/^\+?[0-9*#]{1,100}$/.test(destination))
            throw new UsageError(`The destination is an extension or a number: ${destination}`);
          const client = await pbxClient(ctx);
          const id = await queueId(client, ref);
          const r = await v2(client, 'POST', apiPath`/call-groups/${id}/forward/`, {sipCallId, destination});
          return {queue: id, sipCallId, destination, result: r};
        },
        text: (r) =>
          `Forwarded the call to ${r.destination}${r.result?.message ? ` (${oneLine(r.result.message, 80)})` : ''}`,
      },
    },
  },
};
