// wx-admin timetable | ivr | switch | paging | db: the routing objects that dialplans use, over the PBX REST API
// (tags Dialplan Time Table, Dialplan IVR, Dialplan switches, Dialplan Paging Groups, Dialplan DB), and the general
// dialplan settings (Dialplan General Settings), exported as `dialplanCommands` for the dialplan group.
//
// What the PBX does (seen live, WMS 7):
// - Each kind has only a list (GET /Dialplan/<Kind>/ → {records}); `get` reads the list. A write answers "Success",
//   not the object: `create` reads the list again to give the new one with its id.
// - A PUT wants every field: a timetable without items is a 500, a switch or paging group without its title a 400, an
//   IVR without type and parameters a 400, an IVR menu without a sound a 400 (although POST takes one). The commands
//   read the object and write it back whole.
// - Titles are unique (400 "Already present"). The 400 names the field in `errors` as an object {field: {code,
//   reason}}.
// - A switch is two-state (off 0, on 1) or three-state (isTreeType: also blinking 2), fixed when it is made.
// - Timetable import matches by title: a timetable of the same title is overwritten; ids in the file are ignored.
// - Dialplan DB: keys may hold "/" (family/a/b); deleting a missing key answers "Success"; deleting an empty family is
//   a 500. The DB routes carry no Company API Key scope in the OpenAPI: `dialplan` is a guess.
import {readJsonInput as readJsonFile} from 'wldx-core/files';
import {pickByName} from '../match.mjs';
import {UsageError} from 'wldx-core/errors';
import {oneLine, paint, table} from 'wldx-core/format';
import {apiPath} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';

const SCOPE = {scope: 'dialplan'};

// JSON from a file or stdin (-).
export async function readJsonInput(ctx, from) {
  const data = await readJsonFile(ctx, from); // no credentials, nothing hidden in the home folder
  return data;
}

// A whole number of an option, within [min, max].
export function wholeNumber(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (value === '' || !Number.isInteger(n) || n < min || n > max)
    throw new UsageError(
      `${name} is a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ''}: ${value}`,
    );
  return n;
}

// A record of a list by its id or its title (or `key`: name); exact title first, then without case.
export function findRecord(records, ref, noun, listCommand, key = 'title') {
  const s = String(ref);
  const byId = /^\d+$/.test(s) ? records.find((r) => String(r.id) === s) : undefined;
  return byId ?? pickByName(records, s, (r) => r[key], noun, listCommand);
}

const recordsOf = async (client, base) => (await client.call('GET', base, undefined, SCOPE))?.records ?? [];

// After a POST that answers "Success": the new record, found by its title.
async function createdRecord(client, base, title) {
  return (await recordsOf(client, base)).find((r) => r.title === title) ?? {title};
}

const needsYes = (ctx, why) => {
  if (!ctx.values.yes) throw new UsageError(`${why}: confirm with --yes`, ctx.usage());
};

const TITLE = /^\S(.{0,98}\S)?$/;
const checkTitle = (t, noun) => {
  if (typeof t !== 'string' || !TITLE.test(t))
    throw new UsageError(`A ${noun} needs a title (1 to 100 characters, not blank): ${JSON.stringify(t)}`);
  return t;
};

const titled = (r) => `${r.title}${r.id !== undefined ? ` (id ${r.id})` : ''}`;

// ---------------------------------------------------------------------------------------------------------------------
// Timetables: {id, title, state, items: [{from: {day, dayOfWeek}, to: {day, dayOfWeek}, time: {from, to}, month, year}]};
// 0 in a field means "any". The state is the PBX's code (0, 1 or 2; new ones get 0).

const TT = '/Dialplan/timeTables/';
const ttPath = (id) => apiPath`/Dialplan/timeTables/${id}/`;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function checkTime(t, what) {
  const m = TIME.exec(String(t ?? ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59)
    throw new UsageError(`${what} is a time HH:MM or HH:MM:SS: ${t}`);
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`;
}

// A timetable item with every field (the PBX wants them all).
export function timetableItem(i) {
  if (!i || typeof i !== 'object' || Array.isArray(i))
    throw new UsageError('A timetable item is an object {from, to, time, month, year}');
  const n = (v, what, max) => wholeNumber(v === undefined || v === null || v === '' ? 0 : v, what, 0, max);
  return {
    from: {day: n(i.from?.day, 'from.day', 31), dayOfWeek: n(i.from?.dayOfWeek, 'from.dayOfWeek', 7)},
    to: {day: n(i.to?.day, 'to.day', 31), dayOfWeek: n(i.to?.dayOfWeek, 'to.dayOfWeek', 7)},
    time: {
      from: checkTime(i.time?.from ?? '00:00:00', 'time.from'),
      to: checkTime(i.time?.to ?? '23:59:59', 'time.to'),
    },
    month: n(i.month, 'month', 12),
    year: n(i.year, 'year', 9999),
  };
}

// --item "weekdays=1-5 time=09:00-18:00 days=24-26 month=12 year=2026" or JSON.
function parseItem(spec) {
  const s = String(spec).trim();
  if (s.startsWith('{')) {
    try {
      return timetableItem(JSON.parse(s));
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError(`--item is not JSON: ${e.message}`);
    }
  }
  const item = {from: {}, to: {}, time: {}};
  for (const pair of s.split(/\s+/).filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at < 1) throw new UsageError(`--item is key=value pairs (weekdays, days, time, month, year): ${pair}`);
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const [a, b = a] = key === 'time' ? value.split(/-(?=\d)/) : value.split('-');
    if (key === 'weekdays') [item.from.dayOfWeek, item.to.dayOfWeek] = [a, b];
    else if (key === 'days') [item.from.day, item.to.day] = [a, b];
    else if (key === 'time') [item.time.from, item.time.to] = [a, b];
    else if (key === 'month' || key === 'year') item[key] = value;
    else throw new UsageError(`--item knows weekdays, days, time, month and year: ${key}`);
  }
  return timetableItem(item);
}

const span = (a, b) => (a === b ? `${a}` : `${a}-${b}`);
export function itemLine(i) {
  const parts = [];
  if (i.from?.dayOfWeek || i.to?.dayOfWeek) parts.push(`weekdays ${span(i.from.dayOfWeek, i.to.dayOfWeek)}`);
  if (i.from?.day || i.to?.day) parts.push(`days ${span(i.from.day, i.to.day)}`);
  if (i.month) parts.push(`month ${i.month}`);
  if (i.year) parts.push(`year ${i.year}`);
  if (!parts.length) parts.push('every day');
  parts.push(`${i.time?.from ?? ''}-${i.time?.to ?? ''}`);
  return parts.join(' ');
}

const STATE_CODES = ['0', '1', '2'];

const timetableLines = (t) => [
  `${titled(t)} · state ${t.state}`,
  ...(t.items?.length ? t.items.map((i) => `  ${itemLine(i)}`) : ['  no items']),
];

const ITEM_HELP = [
  'An --item is key=value pairs, 0 or missing meaning "any": weekdays=1-5 (day of the week 1 to 7), days=24-26 (day of the',
  'month), time=09:00-18:00, month=12, year=2026; or JSON {"from": {"day", "dayOfWeek"}, "to": {...}, "time": {"from",',
  '"to"}, "month", "year"}.',
].join('\n');

const timetable = {
  summary: 'timetables (the hours a dialplan checks): list, show, create, change, delete, import',
  commands: {
    list: {
      summary: 'the timetables of the PBX with their items',
      usage: 'wx-admin timetable list',
      options: {},
      args: [0, 0],
      async run(ctx) {
        return (await pbxClient(ctx)).call('GET', TT, undefined, SCOPE);
      },
      text: (r) =>
        r?.records?.length
          ? table(
              r.records.map((t) => [
                t.id,
                t.title,
                `state ${t.state}`,
                oneLine((t.items ?? []).map(itemLine).join('; '), 80),
              ]),
            )
          : 'No timetables',
    },
    get: {
      summary: 'one timetable and its items',
      usage: 'wx-admin timetable get <timetable>',
      details: 'A timetable is its id or its title.',
      options: {},
      args: [1, 1],
      async run(ctx) {
        return findRecord(
          await recordsOf(await pbxClient(ctx), TT),
          ctx.positionals[0],
          'timetable',
          'wx-admin timetable list',
        );
      },
      text: timetableLines,
    },
    create: {
      summary: 'create a timetable (without items it covers every day, all day)',
      usage: 'wx-admin timetable create <title> [--state 0|1|2] [--item SPEC]... [--from FILE|-]',
      details: `${ITEM_HELP}\n--from reads {"state", "items"} as JSON (the title is the argument).`,
      options: {
        state: {
          type: 'string',
          choices: STATE_CODES,
          description: 'the state code of the PBX (default 0, what WMS gives new ones)',
        },
        item: {type: 'string', multiple: true, placeholder: 'SPEC', description: 'a period of the timetable'},
        from: {
          type: 'string',
          placeholder: 'FILE',
          description: 'the state and items as JSON (a file, or - for stdin)',
        },
      },
      args: [1, 1],
      async run(ctx) {
        const title = checkTitle(ctx.positionals[0], 'timetable');
        const src = ctx.values.from ? await readJsonInput(ctx, ctx.values.from) : {};
        const items = ctx.values.item?.length
          ? ctx.values.item.map(parseItem)
          : Array.isArray(src.items)
            ? src.items.map(timetableItem)
            : undefined;
        const body = {title, state: Number(ctx.values.state ?? src.state ?? 0)};
        if (!STATE_CODES.includes(String(body.state))) throw new UsageError(`The state is 0, 1 or 2: ${src.state}`);
        if (items?.length) body.items = items;
        const client = await pbxClient(ctx);
        await client.call('POST', TT, body, SCOPE);
        return createdRecord(client, TT, title);
      },
      text: (t) => [`Created timetable ${titled(t)}`, ...timetableLines(t).slice(1)],
    },
    update: {
      summary: 'change a timetable: title, state, items (--item replaces them all, --add-item adds)',
      usage:
        'wx-admin timetable update <timetable> [--title TEXT] [--state 0|1|2] [--item SPEC]... [--add-item SPEC]... [--from FILE|-]',
      details: `${ITEM_HELP}\n--from reads {"title", "state", "items"} as JSON; fields missing from it are kept.`,
      options: {
        title: {type: 'string', placeholder: 'TEXT', description: 'the new title'},
        state: {type: 'string', choices: STATE_CODES, description: 'the new state code'},
        item: {
          type: 'string',
          multiple: true,
          placeholder: 'SPEC',
          description: 'the periods (they replace all the items)',
        },
        'add-item': {type: 'string', multiple: true, placeholder: 'SPEC', description: 'a period to add to the items'},
        from: {
          type: 'string',
          placeholder: 'FILE',
          description: 'the fields to change as JSON (a file, or - for stdin)',
        },
      },
      args: [1, 1],
      async run(ctx) {
        const v = ctx.values;
        if (v.title === undefined && v.state === undefined && !v.item?.length && !v['add-item']?.length && !v.from) {
          throw new UsageError('Nothing to change: give --title, --state, --item, --add-item or --from', ctx.usage());
        }
        const client = await pbxClient(ctx);
        const current = findRecord(
          await recordsOf(client, TT),
          ctx.positionals[0],
          'timetable',
          'wx-admin timetable list',
        );
        const src = v.from ? await readJsonInput(ctx, v.from) : {};
        const body = {
          title: checkTitle(v.title ?? src.title ?? current.title, 'timetable'),
          state: Number(v.state ?? src.state ?? current.state ?? 0),
          items: (v.item?.length
            ? v.item.map(parseItem)
            : Array.isArray(src.items)
              ? src.items
              : (current.items ?? [])
          ).map(timetableItem),
        };
        if (!STATE_CODES.includes(String(body.state))) throw new UsageError(`The state is 0, 1 or 2: ${body.state}`);
        body.items.push(...(v['add-item'] ?? []).map(parseItem));
        if (!body.items.length) throw new UsageError('A timetable needs at least one item (the PBX refuses none)');
        await client.call('PUT', ttPath(current.id), body, SCOPE);
        return {id: current.id, ...body};
      },
      text: (t) => [`Updated timetable ${titled(t)}`, ...timetableLines(t).slice(1)],
    },
    delete: {
      summary: 'delete timetables (needs --yes: rules that check them stop matching)',
      usage: 'wx-admin timetable delete <timetable>... --yes',
      options: {yes: {type: 'boolean', description: 'yes, delete them'}},
      args: [1, 50],
      async run(ctx) {
        needsYes(ctx, 'Deleting a timetable changes how the dialplans that check it route calls');
        const client = await pbxClient(ctx);
        const records = await recordsOf(client, TT);
        const found = ctx.positionals.map((ref) => findRecord(records, ref, 'timetable', 'wx-admin timetable list'));
        for (const t of found) await client.call('DELETE', ttPath(t.id), undefined, SCOPE);
        return {deleted: found.map(({id, title}) => ({id, title}))};
      },
      text: (r) => `Deleted ${r.deleted.length === 1 ? 'timetable' : 'timetables'} ${r.deleted.map(titled).join(', ')}`,
    },
    import: {
      summary:
        'create timetables from JSON (the output of timetable list or get); --replace overwrites those of the same title',
      usage: 'wx-admin timetable import --from FILE|- [--replace]',
      details: 'The JSON is {"records": [...]}, a list, or one timetable. The PBX matches by title and ignores ids.',
      options: {
        from: {type: 'string', placeholder: 'FILE', description: 'the timetables as JSON (a file, or - for stdin)'},
        replace: {type: 'boolean', description: 'overwrite the timetables of the same title'},
      },
      args: [0, 0],
      async run(ctx) {
        if (!ctx.values.from) throw new UsageError('--from is needed', ctx.usage());
        const src = await readJsonInput(ctx, ctx.values.from);
        const list = Array.isArray(src) ? src : Array.isArray(src?.records) ? src.records : [src];
        if (!list.length) throw new UsageError('No timetables in the JSON');
        const records = list.map((t) => {
          const state = Number(t?.state ?? 0);
          if (!STATE_CODES.includes(String(state))) throw new UsageError(`The state is 0, 1 or 2: ${t?.state}`);
          const items = (Array.isArray(t?.items) ? t.items : []).map(timetableItem);
          if (!items.length) items.push(timetableItem({}));
          return {title: checkTitle(t?.title, 'timetable'), state, items};
        });
        const titles = records.map((r) => r.title);
        if (new Set(titles).size !== titles.length) throw new UsageError('The JSON names a title twice');
        const client = await pbxClient(ctx);
        const existing = new Set((await recordsOf(client, TT)).map((t) => t.title));
        const replaced = titles.filter((t) => existing.has(t));
        if (replaced.length && !ctx.values.replace)
          throw new UsageError(`Timetables of these titles exist: ${replaced.join(', ')}. --replace overwrites them`);
        await client.call('PUT', `${TT}import/`, {records}, SCOPE);
        return {created: titles.filter((t) => !existing.has(t)), replaced};
      },
      text: (r) =>
        [
          r.created.length ? `Created ${r.created.join(', ')}` : '',
          r.replaced.length ? `Replaced ${r.replaced.join(', ')}` : '',
        ].filter(Boolean),
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// IVR: a tree {id, title, type: 'menu', parameters: {sound, times, timeout, backcode, context, exten}, items: [node]};
// a node is a menu (with its own parameters and items) or an item {number, type: 'item', parameters: {context, exten}}.
// number is the key pressed; context/exten of a menu are where the call goes when no key is pressed.

const IVR = '/Dialplan/Ivr/';
const ivrPath = (id) => apiPath`/Dialplan/Ivr/${id}/`;
const KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
const DIALPLAN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// "dialplan/number" → {context, exten}.
function destination(spec, what) {
  const s = String(spec ?? '');
  const at = s.indexOf('/');
  const context = at < 0 ? s : s.slice(0, at);
  const exten = at < 0 ? '' : s.slice(at + 1);
  if (!DIALPLAN_NAME.test(context) || !/^\S{1,128}$/.test(exten))
    throw new UsageError(`${what} is DIALPLAN/NUMBER (a dialplan and the number to dial in it): ${s}`);
  return {context, exten};
}

function menuParams(p, where) {
  const params = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  if (!params.sound) throw new UsageError(`${where} needs a sound (the PBX refuses a menu without one)`);
  const backcode = String(params.backcode ?? '');
  if (backcode && !KEYS.includes(backcode)) throw new UsageError(`${where}: the back key is one of ${KEYS.join(' ')}`);
  return {
    ...params,
    sound: String(params.sound),
    times: wholeNumber(params.times ?? 1, `${where}: times`, 1, 100),
    timeout: wholeNumber(params.timeout ?? 5, `${where}: timeout`, 0, 3600),
    backcode,
    context: String(params.context ?? ''),
    exten: String(params.exten ?? ''),
  };
}

// A node with every field, its keys checked (one of 0-9 * #, once per menu).
function ivrNode(node, where) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new UsageError(`${where} is not an object`);
  const number = String(node.number ?? '');
  if (!KEYS.includes(number))
    throw new UsageError(`${where}: the key is one of ${KEYS.join(' ')}: ${JSON.stringify(node.number)}`);
  if (node.type === 'menu')
    return {
      number,
      type: 'menu',
      parameters: menuParams(node.parameters, `${where} (menu)`),
      items: ivrItems(node.items, `${where} → `),
    };
  if (node.type !== 'item' && node.type !== undefined)
    throw new UsageError(`${where}: the type is menu or item: ${node.type}`);
  const p = node.parameters ?? {};
  return {number, type: 'item', parameters: {...p, context: String(p.context ?? ''), exten: String(p.exten ?? '')}};
}

function ivrItems(items, prefix) {
  const list = (Array.isArray(items) ? items : []).map((n, i) =>
    ivrNode(n, `${prefix}${n?.number ?? `item ${i + 1}`}`),
  );
  const keys = list.map((n) => n.number);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice !== undefined)
    throw new UsageError(`The key ${twice} is used twice in one menu${prefix ? ` (${prefix.slice(0, -3)})` : ''}`);
  return list;
}

const ivrBody = (title, parameters, items) => ({
  title: checkTitle(title, 'IVR'),
  type: 'menu',
  parameters: menuParams(parameters, 'The IVR'),
  items: ivrItems(items, ''),
});

const target = (p) => (p?.context || p?.exten ? `${p.context}/${p.exten}` : '');
const menuLine = (p) =>
  `menu: sound ${p?.sound || '(none)'}, played ${p?.times}×, waits ${p?.timeout} s${target(p) ? `, then ${target(p)}` : ''}${p?.backcode ? `, back key ${p.backcode}` : ''}`;
const nodeLines = (items, indent) =>
  (items ?? []).flatMap((n) =>
    n.type === 'menu'
      ? [`${indent}${n.number} → ${menuLine(n.parameters)}`, ...nodeLines(n.items, `${indent}  `)]
      : [`${indent}${n.number} → ${target(n.parameters) || '(nowhere)'}`],
  );
const ivrLines = (r) => [titled(r), menuLine(r.parameters), ...nodeLines(r.items, '  ')];

// --key 1=users/100 → an item; it replaces the item or menu of that key.
function applyKeys(items, specs = []) {
  const out = [...items];
  for (const spec of specs) {
    const at = String(spec).indexOf('=');
    const number = String(spec).slice(0, at);
    if (at < 1 || !KEYS.includes(number))
      throw new UsageError(`--key is K=DIALPLAN/NUMBER, K one of ${KEYS.join(' ')}: ${spec}`);
    const node = {number, type: 'item', parameters: destination(spec.slice(at + 1), `--key ${number}`)};
    const i = out.findIndex((n) => String(n.number) === number);
    if (i >= 0) out.splice(i, 1, node);
    else out.push(node);
  }
  return out;
}

const IVR_OPTIONS = {
  sound: {
    type: 'string',
    placeholder: 'PATH',
    description: 'the sound file of the menu (as WMS names it, e.g. 00000/RingTones/piano2)',
  },
  times: {type: 'string', placeholder: 'N', description: 'how many times the sound is played (default 1)'},
  timeout: {
    type: 'string',
    placeholder: 'SECONDS',
    description: 'how long it waits for a key after the sound (default 5)',
  },
  'timeout-to': {
    type: 'string',
    placeholder: 'DIALPLAN/NUMBER',
    description: 'where the call goes when no key is pressed',
  },
  'back-key': {type: 'string', choices: KEYS, description: 'the key that goes back to the previous menu'},
  key: {
    type: 'string',
    multiple: true,
    placeholder: 'K=DIALPLAN/NUMBER',
    description: 'a key and where it sends the call',
  },
};

function menuFromOptions(v, base) {
  const p = {...base};
  if (v.sound !== undefined) p.sound = v.sound;
  if (v.times !== undefined) p.times = wholeNumber(v.times, '--times', 1, 100);
  if (v.timeout !== undefined) p.timeout = wholeNumber(v.timeout, '--timeout', 0, 3600);
  if (v['timeout-to'] !== undefined) Object.assign(p, destination(v['timeout-to'], '--timeout-to'));
  if (v['back-key'] !== undefined) p.backcode = v['back-key'];
  return p;
}

const IVR_DETAILS = [
  '--key 1=users/100 sends the key 1 to the number 100 of the dialplan users. Submenus: --from a JSON tree',
  '{"parameters": {...}, "items": [{"number": "2", "type": "menu", "parameters": {"sound", "times", "timeout"}, "items": [...]}]}.',
].join('\n');

const ivr = {
  summary: 'IVR menus (voice menus a dialplan sends calls to): list, show, create, change, delete',
  commands: {
    list: {
      summary: 'the IVR menus of the PBX',
      usage: 'wx-admin ivr list',
      options: {},
      args: [0, 0],
      async run(ctx) {
        return (await pbxClient(ctx)).call('GET', IVR, undefined, SCOPE);
      },
      text: (r) =>
        r?.records?.length
          ? table(
              r.records.map((m) => [
                m.id,
                m.title,
                m.parameters?.sound ?? '',
                `keys ${(m.items ?? []).map((n) => n.number).join(' ') || '-'}`,
              ]),
            )
          : 'No IVR menus',
    },
    get: {
      summary: 'one IVR menu as a tree: keys and where they send the call',
      usage: 'wx-admin ivr get <ivr>',
      details: 'An IVR is its id or its title.',
      options: {},
      args: [1, 1],
      async run(ctx) {
        return findRecord(await recordsOf(await pbxClient(ctx), IVR), ctx.positionals[0], 'IVR', 'wx-admin ivr list');
      },
      text: ivrLines,
    },
    create: {
      summary: 'create an IVR menu',
      usage:
        'wx-admin ivr create <title> --sound PATH [--times N] [--timeout SECONDS] [--timeout-to DIALPLAN/NUMBER] [--back-key K] [--key K=DIALPLAN/NUMBER]... [--from FILE|-]',
      details: IVR_DETAILS,
      options: {
        ...IVR_OPTIONS,
        from: {
          type: 'string',
          placeholder: 'FILE',
          description: 'the menu as JSON {parameters, items} (a file, or - for stdin)',
        },
      },
      args: [1, 1],
      async run(ctx) {
        const title = ctx.positionals[0];
        const src = ctx.values.from ? await readJsonInput(ctx, ctx.values.from) : {};
        const body = ivrBody(
          title,
          menuFromOptions(ctx.values, src.parameters),
          applyKeys(src.items ?? [], ctx.values.key),
        );
        const client = await pbxClient(ctx);
        await client.call('POST', IVR, body, SCOPE);
        return createdRecord(client, IVR, title);
      },
      text: (r) => [`Created IVR ${titled(r)}`, ...(r.parameters ? ivrLines(r).slice(1) : [])],
    },
    update: {
      summary: 'change an IVR menu: title, sound, timeout, keys (--key sets one, --remove-key drops one)',
      usage:
        'wx-admin ivr update <ivr> [--title TEXT] [--sound PATH] [--times N] [--timeout SECONDS] [--timeout-to DIALPLAN/NUMBER] [--back-key K] [--key K=DIALPLAN/NUMBER]... [--remove-key K]... [--from FILE|-]',
      details: `${IVR_DETAILS}\n--from replaces the parameters and the items it holds; the rest is kept.`,
      options: {
        title: {type: 'string', placeholder: 'TEXT', description: 'the new title'},
        ...IVR_OPTIONS,
        'remove-key': {type: 'string', multiple: true, choices: KEYS, description: 'a key to remove'},
        from: {
          type: 'string',
          placeholder: 'FILE',
          description: 'the menu as JSON {title, parameters, items} (a file, or - for stdin)',
        },
      },
      args: [1, 1],
      async run(ctx) {
        const v = ctx.values;
        const changes =
          ['title', 'sound', 'times', 'timeout', 'timeout-to', 'back-key', 'from'].some((k) => v[k] !== undefined) ||
          v.key?.length ||
          v['remove-key']?.length;
        if (!changes) throw new UsageError('Nothing to change', ctx.usage());
        const client = await pbxClient(ctx);
        const current = findRecord(await recordsOf(client, IVR), ctx.positionals[0], 'IVR', 'wx-admin ivr list');
        const src = v.from ? await readJsonInput(ctx, v.from) : {};
        let items = applyKeys(Array.isArray(src.items) ? src.items : (current.items ?? []), v.key);
        for (const k of v['remove-key'] ?? []) {
          if (!items.some((n) => String(n.number) === k))
            throw new UsageError(`The IVR ${current.title} has no key ${k}`);
          items = items.filter((n) => String(n.number) !== k);
        }
        const body = ivrBody(
          v.title ?? src.title ?? current.title,
          menuFromOptions(v, src.parameters ?? current.parameters),
          items,
        );
        await client.call('PUT', ivrPath(current.id), body, SCOPE);
        return {id: current.id, ...body};
      },
      text: (r) => [`Updated IVR ${titled(r)}`, ...ivrLines(r).slice(1)],
    },
    delete: {
      summary: 'delete IVR menus (needs --yes: calls sent to them stop working)',
      usage: 'wx-admin ivr delete <ivr>... --yes',
      options: {yes: {type: 'boolean', description: 'yes, delete them'}},
      args: [1, 50],
      async run(ctx) {
        needsYes(ctx, 'Deleting an IVR stops the calls the dialplans send to it');
        const client = await pbxClient(ctx);
        const records = await recordsOf(client, IVR);
        const found = ctx.positionals.map((ref) => findRecord(records, ref, 'IVR', 'wx-admin ivr list'));
        for (const m of found) await client.call('DELETE', ivrPath(m.id), undefined, SCOPE);
        return {deleted: found.map(({id, title}) => ({id, title}))};
      },
      text: (r) => `Deleted IVR ${r.deleted.map(titled).join(', ')}`,
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Switches: {id, title, state, isTreeType}; state 0 off, 1 on, 2 blinking (three-state switches only). A dialplan
// branches on them (GotoIfSwitchIsOn, GotoIf3SwitchIsOnOrBlinking): changing the state changes how calls are routed.

const SW = '/Dialplan/Switches/';
const swPath = (id) => apiPath`/Dialplan/Switches/${id}/`;
const STATES = {off: 0, on: 1, blinking: 2};
const stateName = (n) => Object.keys(STATES).find((k) => STATES[k] === Number(n)) ?? String(n);
const switchLine = (s) => `${titled(s)} · ${stateName(s.state)} · ${s.isTreeType ? 'three-state' : 'two-state'}`;

async function setSwitch(ctx, state) {
  needsYes(ctx, 'Changing a switch changes how the dialplans that check it route calls');
  const client = await pbxClient(ctx);
  const current = findRecord(await recordsOf(client, SW), ctx.positionals[0], 'switch', 'wx-admin switch list');
  if (state === STATES.blinking && !current.isTreeType)
    throw new UsageError(`The switch ${current.title} is two-state: it cannot blink`);
  await client.call('PUT', swPath(current.id), {title: current.title, state}, SCOPE);
  return {...current, state, previous: current.state};
}

const toggle = (name, state) => ({
  summary: `set a switch ${name} (needs --yes: calls are routed by it)`,
  usage: `wx-admin switch ${name === 'blinking' ? 'blink' : name} <switch> --yes`,
  options: {yes: {type: 'boolean', description: `yes, set it ${name}`}},
  args: [1, 1],
  run: (ctx) => setSwitch(ctx, state),
  text: (s) => `Switch ${titled(s)}: ${stateName(s.previous)} → ${stateName(s.state)}`,
});

const switchCommands = {
  summary: 'switches (on/off flags dialplans branch on): list, show, create, rename, on, off, blink, delete',
  commands: {
    list: {
      summary: 'the switches of the PBX and their state',
      usage: 'wx-admin switch list',
      options: {},
      args: [0, 0],
      async run(ctx) {
        return (await pbxClient(ctx)).call('GET', SW, undefined, SCOPE);
      },
      text: (r, ctx) => {
        if (!r?.records?.length) return 'No switches';
        const c = paint(ctx);
        return table(
          r.records.map((s) => [
            s.id,
            s.title,
            s.state === STATES.on ? c.green('on') : s.state === STATES.blinking ? c.yellow('blinking') : 'off',
            s.isTreeType ? 'three-state' : 'two-state',
          ]),
        );
      },
    },
    get: {
      summary: 'one switch and its state',
      usage: 'wx-admin switch get <switch>',
      details: 'A switch is its id or its title.',
      options: {},
      args: [1, 1],
      async run(ctx) {
        return findRecord(
          await recordsOf(await pbxClient(ctx), SW),
          ctx.positionals[0],
          'switch',
          'wx-admin switch list',
        );
      },
      text: switchLine,
    },
    create: {
      summary: 'create a switch (off unless --state); --three-state lets it blink too (fixed once made)',
      usage: 'wx-admin switch create <title> [--three-state] [--state off|on|blinking]',
      options: {
        'three-state': {type: 'boolean', description: 'a switch with a third state, blinking'},
        state: {type: 'string', choices: Object.keys(STATES), description: 'its first state (default off)'},
      },
      args: [1, 1],
      async run(ctx) {
        const title = checkTitle(ctx.positionals[0], 'switch');
        const state = STATES[ctx.values.state ?? 'off'];
        const isTreeType = Boolean(ctx.values['three-state']);
        if (state === STATES.blinking && !isTreeType) throw new UsageError('Only a --three-state switch can blink');
        const client = await pbxClient(ctx);
        await client.call('POST', SW, {title, state, isTreeType}, SCOPE);
        return createdRecord(client, SW, title);
      },
      text: (s) => `Created switch ${s.state === undefined ? titled(s) : switchLine(s)}`,
    },
    update: {
      summary: 'rename a switch, or set its state (a state change needs --yes)',
      usage: 'wx-admin switch update <switch> [--title TEXT] [--state off|on|blinking [--yes]]',
      options: {
        title: {type: 'string', placeholder: 'TEXT', description: 'the new title'},
        state: {type: 'string', choices: Object.keys(STATES), description: 'the new state (needs --yes)'},
        yes: {type: 'boolean', description: 'yes, change the state'},
      },
      args: [1, 1],
      async run(ctx) {
        const v = ctx.values;
        if (v.title === undefined && v.state === undefined)
          throw new UsageError('Nothing to change: give --title or --state', ctx.usage());
        const client = await pbxClient(ctx);
        const current = findRecord(await recordsOf(client, SW), ctx.positionals[0], 'switch', 'wx-admin switch list');
        const state = v.state === undefined ? current.state : STATES[v.state];
        if (state !== current.state)
          needsYes(ctx, 'Changing a switch changes how the dialplans that check it route calls');
        if (state === STATES.blinking && !current.isTreeType)
          throw new UsageError(`The switch ${current.title} is two-state: it cannot blink`);
        const body = {title: checkTitle(v.title ?? current.title, 'switch'), state};
        await client.call('PUT', swPath(current.id), body, SCOPE);
        return {...current, ...body};
      },
      text: (s) => `Updated switch ${switchLine(s)}`,
    },
    on: toggle('on', STATES.on),
    off: toggle('off', STATES.off),
    blink: toggle('blinking', STATES.blinking),
    delete: {
      summary: 'delete switches (needs --yes: rules that check them change)',
      usage: 'wx-admin switch delete <switch>... --yes',
      options: {yes: {type: 'boolean', description: 'yes, delete them'}},
      args: [1, 50],
      async run(ctx) {
        needsYes(ctx, 'Deleting a switch changes how the dialplans that check it route calls');
        const client = await pbxClient(ctx);
        const records = await recordsOf(client, SW);
        const found = ctx.positionals.map((ref) => findRecord(records, ref, 'switch', 'wx-admin switch list'));
        for (const s of found) await client.call('DELETE', swPath(s.id), undefined, SCOPE);
        return {deleted: found.map(({id, title}) => ({id, title}))};
      },
      text: (r) => `Deleted ${r.deleted.length === 1 ? 'switch' : 'switches'} ${r.deleted.map(titled).join(', ')}`,
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Paging groups: {id, title, members: [extension]}; the PBX does not check that the extensions exist.

const PG = '/Dialplan/PagingGroups/';
const pgPath = (id) => apiPath`/Dialplan/PagingGroups/${id}/`;
const EXTENSION = /^[0-9A-Za-z_*#+.-]{1,64}$/;
const checkMembers = (list) => {
  for (const m of list) if (!EXTENSION.test(String(m))) throw new UsageError(`Not an extension: ${m}`);
  return [...new Set(list.map(String))];
};
const pagingLine = (g) => `${titled(g)} · ${g.members?.length ? g.members.join(', ') : 'no members'}`;

const paging = {
  summary: 'paging groups (the phones a page reaches): list, show, create, change, delete',
  commands: {
    list: {
      summary: 'the paging groups of the PBX and their members',
      usage: 'wx-admin paging list',
      options: {},
      args: [0, 0],
      async run(ctx) {
        return (await pbxClient(ctx)).call('GET', PG, undefined, SCOPE);
      },
      text: (r) =>
        r?.records?.length
          ? table(r.records.map((g) => [g.id, g.title, oneLine((g.members ?? []).join(', '), 80)]))
          : 'No paging groups',
    },
    get: {
      summary: 'one paging group and its members',
      usage: 'wx-admin paging get <group>',
      details: 'A group is its id or its title.',
      options: {},
      args: [1, 1],
      async run(ctx) {
        return findRecord(
          await recordsOf(await pbxClient(ctx), PG),
          ctx.positionals[0],
          'paging group',
          'wx-admin paging list',
        );
      },
      text: pagingLine,
    },
    create: {
      summary: 'create a paging group',
      usage: 'wx-admin paging create <title> [--member EXTENSION]...',
      options: {
        member: {
          type: 'string',
          multiple: true,
          placeholder: 'EXTENSION',
          description: 'an extension the page reaches',
        },
      },
      args: [1, 1],
      async run(ctx) {
        const title = checkTitle(ctx.positionals[0], 'paging group');
        const client = await pbxClient(ctx);
        await client.call('POST', PG, {title, members: checkMembers(ctx.values.member ?? [])}, SCOPE);
        return createdRecord(client, PG, title);
      },
      text: (g) => `Created paging group ${pagingLine(g)}`,
    },
    update: {
      summary: 'change a paging group: title, members (--member replaces them, --add and --remove change them)',
      usage:
        'wx-admin paging update <group> [--title TEXT] [--member EXTENSION]... [--add EXTENSION]... [--remove EXTENSION]...',
      options: {
        title: {type: 'string', placeholder: 'TEXT', description: 'the new title'},
        member: {
          type: 'string',
          multiple: true,
          placeholder: 'EXTENSION',
          description: 'the members (they replace all of them)',
        },
        add: {type: 'string', multiple: true, placeholder: 'EXTENSION', description: 'an extension to add'},
        remove: {type: 'string', multiple: true, placeholder: 'EXTENSION', description: 'an extension to remove'},
      },
      args: [1, 1],
      async run(ctx) {
        const v = ctx.values;
        if (v.title === undefined && !v.member?.length && !v.add?.length && !v.remove?.length)
          throw new UsageError('Nothing to change', ctx.usage());
        const client = await pbxClient(ctx);
        const current = findRecord(
          await recordsOf(client, PG),
          ctx.positionals[0],
          'paging group',
          'wx-admin paging list',
        );
        let members = v.member?.length ? v.member : [...(current.members ?? []), ...(v.add ?? [])];
        for (const m of v.remove ?? []) {
          if (!members.map(String).includes(m)) throw new UsageError(`${m} is not a member of ${current.title}`);
          members = members.filter((x) => String(x) !== m);
        }
        const body = {title: checkTitle(v.title ?? current.title, 'paging group'), members: checkMembers(members)};
        await client.call('PUT', pgPath(current.id), body, SCOPE);
        return {id: current.id, ...body};
      },
      text: (g) => `Updated paging group ${pagingLine(g)}`,
    },
    delete: {
      summary: 'delete paging groups (needs --yes)',
      usage: 'wx-admin paging delete <group>... --yes',
      options: {yes: {type: 'boolean', description: 'yes, delete them'}},
      args: [1, 50],
      async run(ctx) {
        needsYes(ctx, 'Deleting a paging group stops the pages the dialplans send to it');
        const client = await pbxClient(ctx);
        const records = await recordsOf(client, PG);
        const found = ctx.positionals.map((ref) => findRecord(records, ref, 'paging group', 'wx-admin paging list'));
        for (const g of found) await client.call('DELETE', pgPath(g.id), undefined, SCOPE);
        return {deleted: found.map(({id, title}) => ({id, title}))};
      },
      text: (r) => `Deleted paging ${r.deleted.length === 1 ? 'group' : 'groups'} ${r.deleted.map(titled).join(', ')}`,
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Dialplan DB (the Asterisk database dialplans read and write): families of key → value; a key may hold "/".

const familyPath = (family) => apiPath`/Dialplan/DB/${family}/`;
function keyPath(family, key) {
  const parts = String(key).split('/');
  if (parts.some((p) => !p)) throw new UsageError(`Not a key: ${key}`);
  try {
    return familyPath(family) + parts.map((p) => apiPath`${p}`).join('/') + '/';
  } catch {
    throw new UsageError(`A key is letters, digits and _ . : + @ - (and / between parts): ${key}`);
  }
}
const checkFamily = (family) => {
  try {
    return familyPath(family);
  } catch {
    throw new UsageError(`A family is letters, digits and _ . : + @ -: ${family}`);
  }
};
const shortKey = (family, key) =>
  String(key).startsWith(`/${family}/`) ? String(key).slice(family.length + 2) : String(key);

const db = {
  summary: 'the dialplan database (families of keys and values that dialplans read and set): list, get, set, delete',
  commands: {
    list: {
      summary: 'the keys and values of a family',
      usage: 'wx-admin db list <family>',
      options: {},
      args: [1, 1],
      async run(ctx) {
        return (await pbxClient(ctx)).call('GET', checkFamily(ctx.positionals[0]), undefined, SCOPE);
      },
      text: (r, ctx) =>
        r?.records?.length
          ? table(r.records.map((x) => [shortKey(ctx.positionals[0], x.key), oneLine(x.value, 100)]))
          : `No keys in ${ctx.positionals[0]}`,
    },
    get: {
      summary: 'the value of a key',
      usage: 'wx-admin db get <family> <key>',
      options: {},
      args: [2, 2],
      async run(ctx) {
        const [family, key] = ctx.positionals;
        const value = await (await pbxClient(ctx)).call('GET', keyPath(family, key).slice(0, -1), undefined, SCOPE);
        return {family, key, value};
      },
      text: (r) => String(r.value ?? ''),
    },
    set: {
      summary: 'set the value of a key (made if missing)',
      usage: 'wx-admin db set <family> <key> <value>',
      options: {},
      args: [3, 3],
      async run(ctx) {
        const [family, key, value] = ctx.positionals;
        await (await pbxClient(ctx)).call('PUT', keyPath(family, key), {value}, SCOPE);
        return {family, key, value};
      },
      text: (r) => `Set ${r.family}/${r.key} = ${r.value}`,
    },
    delete: {
      summary: 'delete a key, or a whole family without a key (needs --yes)',
      usage: 'wx-admin db delete <family> [<key>] --yes',
      options: {yes: {type: 'boolean', description: 'yes, delete it'}},
      args: [1, 2],
      async run(ctx) {
        const [family, key] = ctx.positionals;
        needsYes(
          ctx,
          key ? 'Deleting a key changes what the dialplans read' : 'Deleting a family deletes all its keys',
        );
        const client = await pbxClient(ctx);
        if (key) {
          // The PBX answers "Success" for a missing key: read it first, so a typo is not reported as done.
          await client.call('GET', keyPath(family, key).slice(0, -1), undefined, SCOPE);
          await client.call('DELETE', keyPath(family, key), undefined, SCOPE);
          return {family, deleted: [key]};
        }
        const keys = ((await client.call('GET', checkFamily(family), undefined, SCOPE))?.records ?? []).map((x) =>
          shortKey(family, x.key),
        );
        if (!keys.length) throw new UsageError(`The family ${family} has no keys`);
        await client.call('DELETE', checkFamily(family), undefined, SCOPE);
        return {family, all: true, deleted: keys};
      },
      text: (r) =>
        r.all
          ? `Deleted the family ${r.family} and its ${r.deleted.length === 1 ? 'key' : `${r.deleted.length} keys`}: ${r.deleted.join(', ')}`
          : `Deleted the key ${r.family}/${r.deleted[0]}`,
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// General dialplan settings (one object), for `wx-admin dialplan settings` and `settings-set`. A PUT gets the whole
// object: the current settings with the changes.

const GS = '/Dialplan/GeneralSettings/';
const SETTINGS = {
  faxLang: 'string',
  parkTimeout: 'integer',
  prefixExtLine: 'string',
  internationalPrefix: 'string',
  nationalPrefix: 'string',
  intDialTimeout: 'string',
  transferDigitTimeout: 'string',
  transferInterDigitTimeout: 'string',
  endOfDigit: ['0', '1', '2'],
  buttonSound: 'boolean',
  attachFormatVm: ['mp3', 'wav'],
  attachFormatRec: ['mp3', 'wav'],
  recNotify: 'boolean',
  recAttach: 'boolean',
  faxAttach: 'boolean',
  vmNotify: 'boolean',
  describeVoiceMail: 'boolean',
  trunkRegistrationNotification: 'boolean',
  voiceMailMessageMoreInfo: 'boolean',
  userVariables: 'lines',
  quickDialPatterns: 'lines',
  personalRecordType: ['default', 'record', 'transcribe', 'record_transcribe'],
};

function settingValue(key, raw) {
  const type = SETTINGS[key];
  if (!type) throw new UsageError(`Unknown setting ${key}: one of ${Object.keys(SETTINGS).join(', ')}`);
  if (raw === null || typeof raw === 'object') throw new UsageError(`${key} is a single value`);
  const s = String(raw);
  if (Array.isArray(type)) {
    if (!type.includes(s)) throw new UsageError(`${key} is one of ${type.join(', ')}: ${s}`);
    return s;
  }
  if (type === 'boolean') {
    if (!['true', 'false'].includes(s)) throw new UsageError(`${key} is true or false: ${s}`);
    return s === 'true';
  }
  if (type === 'integer') return wholeNumber(s, key, 0, 32767);
  if (type === 'lines') return typeof raw === 'string' ? raw.replace(/\\n/g, '\n') : s;
  return s;
}

const settingText = (v) =>
  typeof v === 'string' && v.includes('\n') ? v.split('\n').filter(Boolean).join(' · ') : String(v ?? '');

export const dialplanCommands = {
  settings: {
    summary: 'the general dialplan settings (prefixes, timeouts, recording and voicemail mail, variables)',
    usage: 'wx-admin dialplan settings',
    options: {},
    args: [0, 0],
    async run(ctx) {
      return (await pbxClient(ctx)).call('GET', GS, undefined, SCOPE);
    },
    text: (s) => table(Object.entries(s ?? {}).map(([k, v]) => [k, settingText(v)])),
  },
  'settings-set': {
    summary: 'change general dialplan settings (needs --yes: they apply to every call)',
    usage: 'wx-admin dialplan settings-set (--set KEY=VALUE... | --from FILE|-) --yes',
    details: [
      `The keys: ${Object.keys(SETTINGS).join(', ')}.`,
      "In userVariables and quickDialPatterns, \\n separates lines: --set 'quickDialPatterns=1[0-9][0-9]\\n2[0-9][0-9]'.",
      'The others are kept as they are (the PBX gets the whole settings).',
    ].join('\n'),
    options: {
      set: {type: 'string', multiple: true, placeholder: 'KEY=VALUE', description: 'a setting and its new value'},
      from: {
        type: 'string',
        placeholder: 'FILE',
        description: 'the settings to change as JSON (a file, or - for stdin)',
      },
      yes: {type: 'boolean', description: 'yes, change them'},
    },
    args: [0, 0],
    async run(ctx) {
      const v = ctx.values;
      if (!v.set?.length && !v.from) throw new UsageError('Give --set KEY=VALUE or --from', ctx.usage());
      const changes = {};
      if (v.from) {
        const src = await readJsonInput(ctx, v.from);
        if (!src || typeof src !== 'object' || Array.isArray(src))
          throw new UsageError('--from is a JSON object of settings');
        for (const [k, val] of Object.entries(src)) changes[k] = settingValue(k, val);
      }
      for (const kv of v.set ?? []) {
        const at = kv.indexOf('=');
        if (at < 1) throw new UsageError(`--set is KEY=VALUE: ${kv}`);
        changes[kv.slice(0, at)] = settingValue(kv.slice(0, at), kv.slice(at + 1));
      }
      needsYes(ctx, 'The general dialplan settings apply to every call');
      const client = await pbxClient(ctx);
      const current = await client.call('GET', GS, undefined, SCOPE);
      await client.call('PUT', GS, {...current, ...changes}, SCOPE);
      return {changed: changes, settings: await client.call('GET', GS, undefined, SCOPE)};
    },
    text: (r) =>
      `Updated the dialplan settings: ${Object.entries(r.changed)
        .map(([k, v]) => `${k}=${settingText(v)}`)
        .join(', ')}`,
  },
};

export const groups = {timetable, ivr, switch: switchCommands, paging, db};
