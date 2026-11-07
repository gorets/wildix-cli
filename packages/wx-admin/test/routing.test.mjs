import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {dialplanCommands, groups} from '../src/commands/routing.mjs';
import {run, tempConfigDir} from './helpers.mjs';

const KEY = `wsk-v1-${'a'.repeat(93)}`;
const env = () => ({WILDIX_CONFIG_DIR: tempConfigDir(), WILDIX_PBX_API_KEY: KEY, WILDIX_PBX_HOST: 'demo'});
const registry = {groups: {...groups, dialplan: {summary: 'dialplans', commands: dialplanCommands}}};

// A PBX with the routing objects in memory, answering as a real one does (seen live): lists only, "Success" for writes,
// 400 {errors: {field: {code, reason}}} for a missing title or a duplicate one, 500 for a timetable PUT without items.
function fakePbx(seed = {}) {
  const kinds = {timeTables: [], Ivr: [], Switches: [], PagingGroups: [], ...structuredClone(seed)};
  const db = new Map(Object.entries(seed.db ?? {}));
  let settings = {
    faxLang: 'EN',
    parkTimeout: 60,
    buttonSound: true,
    quickDialPatterns: '1[0-9][0-9]',
    transferDigitTimeout: '600',
    transferInterDigitTimeout: '2',
  };
  let next = 100;
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), {status});
  const ok = (r = 'Success') => reply(200, {type: 'result', result: r});
  const invalid = (field, code) =>
    reply(400, {type: 'error', reason: 'Validation error', errors: {[field]: {code, reason: code}}});
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const p = decodeURIComponent(u.pathname.replace(/^\/api\/v1/, ''));
    calls.push({method: init.method, path: p, body});
    if (p === '/Dialplan/GeneralSettings/') {
      if (init.method === 'GET') return ok(settings);
      settings = body;
      return ok();
    }
    const d = p.match(/^\/Dialplan\/DB\/([^/]+)\/(?:(.+?)\/?)?$/);
    if (d) {
      const [, family, key] = d;
      const full = key && `/${family}/${key}`;
      if (init.method === 'GET' && !key) {
        const records = [...db].filter(([k]) => k.startsWith(`/${family}/`)).map(([k, value]) => ({key: k, value}));
        return ok({total: String(records.length), records});
      }
      if (init.method === 'GET')
        return db.has(full) ? ok(db.get(full)) : reply(404, {type: 'error', reason: `Key ${key} not found`});
      if (init.method === 'PUT' || init.method === 'POST') {
        db.set(full, body.value);
        return ok();
      }
      if (init.method === 'DELETE' && key) {
        db.delete(full);
        return ok();
      }
      const keys = [...db.keys()].filter((k) => k.startsWith(`/${family}/`));
      if (!keys.length) return reply(500, {type: 'error', reason: 'Failed to update database'});
      for (const k of keys) db.delete(k);
      return ok();
    }
    const m = p.match(/^\/Dialplan\/(timeTables|Ivr|Switches|PagingGroups)\/(?:(\d+|import)\/)?$/);
    if (!m) return reply(404, {type: 'error', reason: 'Not found'});
    const [, kind, id] = m;
    const list = kinds[kind];
    if (init.method === 'GET') return ok({records: list});
    if (id === 'import') {
      for (const r of body.records) {
        const at = list.findIndex((x) => x.title === r.title);
        if (at >= 0) list[at] = {...list[at], ...r, id: list[at].id};
        else list.push({...r, id: next++});
      }
      return ok();
    }
    if (init.method === 'POST') {
      if (!body.title) return invalid('title', 'FieldRequired');
      if (list.some((x) => x.title === body.title)) return invalid('title', 'AlreadyPresent');
      const rec = {id: next++, ...body};
      if (kind === 'timeTables' && !rec.items)
        rec.items = [
          {
            from: {day: 0, dayOfWeek: 0},
            to: {day: 0, dayOfWeek: 0},
            time: {from: '00:00:00', to: '23:59:59'},
            month: 0,
            year: 0,
          },
        ];
      list.push(rec);
      return ok();
    }
    const at = list.findIndex((x) => String(x.id) === id);
    if (at < 0) return reply(404, {type: 'error', reason: 'Not found'});
    if (init.method === 'PUT') {
      if (!body.title) return invalid('title', 'FieldRequired');
      if (kind === 'timeTables' && !body.items) return reply(500, {type: 'error', reason: 'Internal Server Error'});
      if (kind === 'Switches' && body.state === 2 && !list[at].isTreeType) return invalid('state', 'MaxLimit');
      list[at] = {...list[at], ...body, id: list[at].id};
      return ok();
    }
    if (init.method === 'DELETE') {
      list.splice(at, 1);
      return ok();
    }
    return reply(405, {});
  };
  return {
    fetch,
    calls,
    kinds,
    db,
    get settings() {
      return settings;
    },
  };
}

const wx = (pbx, argv, options = {}) =>
  run([...argv, '--pbx', 'demo'], {env: env(), fetch: pbx.fetch, registry, ...options});
const writes = (pbx) => pbx.calls.filter((c) => c.method !== 'GET');
const ANY_DAY = {
  from: {day: 0, dayOfWeek: 0},
  to: {day: 0, dayOfWeek: 0},
  time: {from: '00:00:00', to: '23:59:59'},
  month: 0,
  year: 0,
};

test('timetable: list and get as text, create with --item specs, update writes every field', async () => {
  const pbx = fakePbx({
    timeTables: [
      {
        id: 1,
        title: 'office',
        state: 0,
        items: [
          {
            ...ANY_DAY,
            from: {day: 0, dayOfWeek: 1},
            to: {day: 0, dayOfWeek: 5},
            time: {from: '09:00:00', to: '18:00:00'},
          },
        ],
      },
    ],
  });
  const list = await wx(pbx, ['timetable', 'list'], {output: 'text'});
  assert.equal(list.stdout, '1  office  state 0  weekdays 1-5 09:00:00-18:00:00\n');
  assert.equal(
    (await wx(pbx, ['timetable', 'get', 'Office'], {output: 'text'})).stdout,
    'office (id 1) · state 0\n  weekdays 1-5 09:00:00-18:00:00\n',
  );
  assert.equal((await wx(pbx, ['timetable', 'get', 'nope'])).code, 64);

  const c = await wx(pbx, [
    'timetable',
    'create',
    'xmas',
    '--item',
    'days=24-26 month=12',
    '--item',
    'weekdays=6 time=9:30-12:00',
    '--state',
    '2',
  ]);
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'POST',
    path: '/Dialplan/timeTables/',
    body: {
      title: 'xmas',
      state: 2,
      items: [
        {...ANY_DAY, from: {day: 24, dayOfWeek: 0}, to: {day: 26, dayOfWeek: 0}, month: 12},
        {
          ...ANY_DAY,
          from: {day: 0, dayOfWeek: 6},
          to: {day: 0, dayOfWeek: 6},
          time: {from: '09:30:00', to: '12:00:00'},
        },
      ],
    },
  });
  assert.equal(JSON.parse(c.stdout).id, 100);

  const plain = await wx(pbx, ['timetable', 'create', 'always']);
  assert.deepEqual(writes(pbx).at(-1).body, {title: 'always', state: 0});
  assert.match(
    (await wx(pbx, ['timetable', 'create', 'always2'], {output: 'text'})).stdout,
    /^Created timetable always2 \(id 102\)\n {2}every day 00:00:00-23:59:59$/m,
  );
  assert.equal(plain.code, 0);

  const u = await wx(pbx, [
    'timetable',
    'update',
    'office',
    '--add-item',
    'weekdays=6 time=10:00-12:00',
    '--title',
    'office2',
  ]);
  assert.equal(u.code, 0, u.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'PUT',
    path: '/Dialplan/timeTables/1/',
    body: {
      title: 'office2',
      state: 0,
      items: [
        {
          ...ANY_DAY,
          from: {day: 0, dayOfWeek: 1},
          to: {day: 0, dayOfWeek: 5},
          time: {from: '09:00:00', to: '18:00:00'},
        },
        {
          ...ANY_DAY,
          from: {day: 0, dayOfWeek: 6},
          to: {day: 0, dayOfWeek: 6},
          time: {from: '10:00:00', to: '12:00:00'},
        },
      ],
    },
  });
  assert.equal((await wx(pbx, ['timetable', 'update', 'office2'])).code, 64);
  assert.equal((await wx(pbx, ['timetable', 'update', 'office2', '--item', 'weekdays=8'])).code, 64);
  assert.equal((await wx(pbx, ['timetable', 'update', 'office2', '--item', 'time=25:00-26:00'])).code, 64);
  assert.equal((await wx(pbx, ['timetable', 'update', 'office2', '--item', 'hours=1'])).code, 64);
  assert.equal((await wx(pbx, ['timetable', 'create', 'x', '--state', '3'])).code, 64);
  const dup = await wx(pbx, ['timetable', 'create', 'xmas']);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /HTTP 400/);
});

test('timetable: delete needs --yes; import refuses existing titles without --replace', async () => {
  const pbx = fakePbx({
    timeTables: [
      {id: 1, title: 'office', state: 0, items: [ANY_DAY]},
      {id: 2, title: 'night', state: 0, items: [ANY_DAY]},
    ],
  });
  assert.equal((await wx(pbx, ['timetable', 'delete', 'office'])).code, 64);
  assert.equal(writes(pbx).length, 0);
  const d = await wx(pbx, ['timetable', 'delete', 'office', '2', '--yes'], {output: 'text'});
  assert.equal(d.stdout, 'Deleted timetables office (id 1), night (id 2)\n');
  assert.deepEqual(
    writes(pbx).map((c) => `${c.method} ${c.path}`),
    ['DELETE /Dialplan/timeTables/1/', 'DELETE /Dialplan/timeTables/2/'],
  );

  const dir = tempConfigDir();
  const file = path.join(dir, 'tt.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      records: [
        {
          id: 9,
          title: 'lunch',
          state: 0,
          items: [{from: {dayOfWeek: 1}, to: {dayOfWeek: 5}, time: {from: '13:00', to: '14:00'}}],
        },
      ],
    }),
  );
  const i = await wx(pbx, ['timetable', 'import', '--from', file], {output: 'text'});
  assert.equal(i.stdout, 'Created lunch\n', i.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'PUT',
    path: '/Dialplan/timeTables/import/',
    body: {
      records: [
        {
          title: 'lunch',
          state: 0,
          items: [
            {
              ...ANY_DAY,
              from: {day: 0, dayOfWeek: 1},
              to: {day: 0, dayOfWeek: 5},
              time: {from: '13:00:00', to: '14:00:00'},
            },
          ],
        },
      ],
    },
  });
  assert.equal((await wx(pbx, ['timetable', 'import', '--from', file])).code, 64);
  const again = await wx(pbx, ['timetable', 'import', '--from', '-', '--replace'], {
    stdin: fs.readFileSync(file, 'utf8'),
    output: 'text',
  });
  assert.equal(again.stdout, 'Replaced lunch\n');
  assert.equal((await wx(pbx, ['timetable', 'import'])).code, 64);
});

const IVR = {
  id: 3,
  title: 'reception',
  type: 'menu',
  parameters: {sound: 'snd/welcome', times: 2, timeout: 5, backcode: '', context: 'users', exten: '100', priority: ''},
  items: [
    {number: '1', type: 'item', parameters: {context: 'users', exten: '101'}},
    {
      number: '9',
      type: 'menu',
      parameters: {sound: 'snd/sub', times: 1, timeout: 3, backcode: '*', context: '', exten: ''},
      items: [{number: '1', type: 'item', parameters: {context: 'main', exten: '200'}}],
    },
  ],
};

test('ivr: tree as text, create with keys, update keys, delete with --yes', async () => {
  const pbx = fakePbx({Ivr: [IVR]});
  const got = await wx(pbx, ['ivr', 'get', 'reception'], {output: 'text'});
  assert.equal(
    got.stdout,
    [
      'reception (id 3)',
      'menu: sound snd/welcome, played 2×, waits 5 s, then users/100',
      '  1 → users/101',
      '  9 → menu: sound snd/sub, played 1×, waits 3 s, back key *',
      '    1 → main/200',
      '',
    ].join('\n'),
  );
  assert.equal((await wx(pbx, ['ivr', 'list'], {output: 'text'})).stdout, '3  reception  snd/welcome  keys 1 9\n');

  assert.equal((await wx(pbx, ['ivr', 'create', 'night'])).code, 64); // no sound
  const c = await wx(pbx, [
    'ivr',
    'create',
    'night',
    '--sound',
    'snd/night',
    '--timeout-to',
    'users/100',
    '--key',
    '1=users/101',
    '--key',
    '#=main/0',
  ]);
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'POST',
    path: '/Dialplan/Ivr/',
    body: {
      title: 'night',
      type: 'menu',
      parameters: {sound: 'snd/night', times: 1, timeout: 5, backcode: '', context: 'users', exten: '100'},
      items: [
        {number: '1', type: 'item', parameters: {context: 'users', exten: '101'}},
        {number: '#', type: 'item', parameters: {context: 'main', exten: '0'}},
      ],
    },
  });
  assert.equal((await wx(pbx, ['ivr', 'create', 'bad', '--sound', 's', '--key', 'x=users/1'])).code, 64);
  assert.equal((await wx(pbx, ['ivr', 'create', 'bad', '--sound', 's', '--key', '1=users'])).code, 64);

  const u = await wx(pbx, ['ivr', 'update', '3', '--key', '1=users/102', '--remove-key', '9', '--times', '3']);
  assert.equal(u.code, 0, u.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'PUT',
    path: '/Dialplan/Ivr/3/',
    body: {
      title: 'reception',
      type: 'menu',
      parameters: {
        sound: 'snd/welcome',
        times: 3,
        timeout: 5,
        backcode: '',
        context: 'users',
        exten: '100',
        priority: '',
      },
      items: [{number: '1', type: 'item', parameters: {context: 'users', exten: '102'}}],
    },
  });
  assert.equal((await wx(pbx, ['ivr', 'update', '3', '--remove-key', '5'])).code, 64);
  assert.equal((await wx(pbx, ['ivr', 'update', '3'])).code, 64);

  // A submenu from JSON: every parameter filled; a key used twice is refused.
  const dir = tempConfigDir();
  const file = path.join(dir, 'ivr.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      items: [
        {
          number: '2',
          type: 'menu',
          parameters: {sound: 'snd/x'},
          items: [{number: '1', type: 'item', parameters: {context: 'users'}}],
        },
      ],
    }),
  );
  assert.equal((await wx(pbx, ['ivr', 'update', 'reception', '--from', file])).code, 0);
  assert.deepEqual(writes(pbx).at(-1).body.items, [
    {
      number: '2',
      type: 'menu',
      parameters: {sound: 'snd/x', times: 1, timeout: 5, backcode: '', context: '', exten: ''},
      items: [{number: '1', type: 'item', parameters: {context: 'users', exten: ''}}],
    },
  ]);
  fs.writeFileSync(
    file,
    JSON.stringify({
      items: [
        {number: '2', type: 'item'},
        {number: '2', type: 'item'},
      ],
    }),
  );
  assert.equal((await wx(pbx, ['ivr', 'update', 'reception', '--from', file])).code, 64);

  assert.equal((await wx(pbx, ['ivr', 'delete', 'reception'])).code, 64);
  assert.equal((await wx(pbx, ['ivr', 'delete', 'reception', '--yes'])).code, 0);
  assert.equal(writes(pbx).at(-1).path, '/Dialplan/Ivr/3/');
});

test('switch: on/off/blink need --yes, blinking only three-state, update renames', async () => {
  const pbx = fakePbx({
    Switches: [
      {id: 1, title: 'night', state: 0, isTreeType: false},
      {id: 2, title: 'holiday', state: 1, isTreeType: true},
    ],
  });
  assert.equal(
    (await wx(pbx, ['switch', 'list', '--no-color'], {output: 'text'})).stdout,
    '1  night    off  two-state\n2  holiday  on   three-state\n',
  );
  assert.equal((await wx(pbx, ['switch', 'on', 'night'])).code, 64);
  assert.equal(writes(pbx).length, 0);
  const on = await wx(pbx, ['switch', 'on', 'night', '--yes'], {output: 'text'});
  assert.equal(on.stdout, 'Switch night (id 1): off → on\n');
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'PUT',
    path: '/Dialplan/Switches/1/',
    body: {title: 'night', state: 1},
  });
  assert.equal((await wx(pbx, ['switch', 'blink', 'night', '--yes'])).code, 64);
  assert.equal((await wx(pbx, ['switch', 'blink', 'holiday', '--yes'])).code, 0);
  assert.deepEqual(writes(pbx).at(-1).body, {title: 'holiday', state: 2});
  assert.equal((await wx(pbx, ['switch', 'off', '2', '--yes'])).code, 0);

  assert.equal((await wx(pbx, ['switch', 'update', 'night', '--title', 'night2'])).code, 0);
  assert.deepEqual(writes(pbx).at(-1).body, {title: 'night2', state: 1});
  assert.equal((await wx(pbx, ['switch', 'update', 'night2', '--state', 'off'])).code, 64);
  assert.equal((await wx(pbx, ['switch', 'update', 'night2', '--state', 'off', '--yes'])).code, 0);

  assert.equal((await wx(pbx, ['switch', 'create', 'x', '--state', 'blinking'])).code, 64);
  const c = await wx(pbx, ['switch', 'create', 'storm', '--three-state', '--state', 'blinking'], {output: 'text'});
  assert.equal(c.stdout, 'Created switch storm (id 100) · blinking · three-state\n');
  assert.deepEqual(writes(pbx).at(-1).body, {title: 'storm', state: 2, isTreeType: true});
  assert.equal((await wx(pbx, ['switch', 'create', 'y', '--state', 'dim'])).code, 64);
  assert.equal((await wx(pbx, ['switch', 'delete', 'storm'])).code, 64);
  assert.equal((await wx(pbx, ['switch', 'delete', 'storm', 'night2', '--yes'])).code, 0);
  assert.deepEqual(
    pbx.kinds.Switches.map((s) => s.title),
    ['holiday'],
  );
});

test('paging: create, add and remove members, delete with --yes', async () => {
  const pbx = fakePbx({PagingGroups: [{id: 4, title: 'floor1', members: ['101', '102']}]});
  assert.equal((await wx(pbx, ['paging', 'list'], {output: 'text'})).stdout, '4  floor1  101, 102\n');
  const c = await wx(pbx, ['paging', 'create', 'floor2', '--member', '201', '--member', '202']);
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'POST',
    path: '/Dialplan/PagingGroups/',
    body: {title: 'floor2', members: ['201', '202']},
  });
  assert.equal((await wx(pbx, ['paging', 'update', 'floor1', '--add', '103', '--remove', '101'])).code, 0);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'PUT',
    path: '/Dialplan/PagingGroups/4/',
    body: {title: 'floor1', members: ['102', '103']},
  });
  assert.equal((await wx(pbx, ['paging', 'update', 'floor1', '--member', '300', '--title', 'f1'])).code, 0);
  assert.deepEqual(writes(pbx).at(-1).body, {title: 'f1', members: ['300']});
  assert.equal((await wx(pbx, ['paging', 'update', 'f1', '--remove', '999'])).code, 64);
  assert.equal((await wx(pbx, ['paging', 'create', 'bad', '--member', '1 2'])).code, 64);
  assert.equal((await wx(pbx, ['paging', 'delete', 'f1'])).code, 64);
  assert.equal((await wx(pbx, ['paging', 'delete', 'f1', '--yes'])).code, 0);
  assert.equal(writes(pbx).at(-1).path, '/Dialplan/PagingGroups/4/');
});

test('db: list, get, set (nested keys), delete a key or a family with --yes', async () => {
  const pbx = fakePbx({db: {'/night/mode': 'on', '/night/a/b': 'x y'}});
  assert.equal((await wx(pbx, ['db', 'list', 'night'], {output: 'text'})).stdout, 'mode  on\na/b   x y\n');
  assert.deepEqual(JSON.parse((await wx(pbx, ['db', 'get', 'night', 'a/b'])).stdout), {
    family: 'night',
    key: 'a/b',
    value: 'x y',
  });
  assert.equal((await wx(pbx, ['db', 'get', 'night', 'mode'], {output: 'text'})).stdout, 'on\n');
  assert.equal(pbx.calls.at(-1).path, '/Dialplan/DB/night/mode');
  const s = await wx(pbx, ['db', 'set', 'night', 'c/d', 'hello world']);
  assert.equal(s.code, 0, s.stderr);
  assert.deepEqual(writes(pbx).at(-1), {method: 'PUT', path: '/Dialplan/DB/night/c/d/', body: {value: 'hello world'}});
  assert.equal((await wx(pbx, ['db', 'set', 'night', '../x', 'v'])).code, 64);
  assert.equal((await wx(pbx, ['db', 'set', 'bad family', 'k', 'v'])).code, 64);

  assert.equal((await wx(pbx, ['db', 'delete', 'night', 'mode'])).code, 64);
  assert.equal((await wx(pbx, ['db', 'delete', 'night', 'nokey', '--yes'])).code, 1); // read first: the PBX would say Success
  assert.equal(writes(pbx).filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(
    (await wx(pbx, ['db', 'delete', 'night', 'mode', '--yes'], {output: 'text'})).stdout,
    'Deleted the key night/mode\n',
  );
  assert.equal(writes(pbx).at(-1).path, '/Dialplan/DB/night/mode/');
  const f = await wx(pbx, ['db', 'delete', 'night', '--yes'], {output: 'text'});
  assert.equal(f.stdout, 'Deleted the family night and its 2 keys: a/b, c/d\n');
  assert.equal((await wx(pbx, ['db', 'delete', 'night', '--yes'])).code, 64); // empty: the PBX would answer 500
});

test('dialplan settings and settings-set: typed values, the whole object written, --yes', async () => {
  const pbx = fakePbx();
  assert.match((await wx(pbx, ['dialplan', 'settings'], {output: 'text'})).stdout, /^parkTimeout +60$/m);
  assert.equal((await wx(pbx, ['dialplan', 'settings-set', '--set', 'buttonSound=false'])).code, 64);
  assert.equal(writes(pbx).length, 0);
  const r = await wx(pbx, [
    'dialplan',
    'settings-set',
    '--set',
    'buttonSound=false',
    '--set',
    'parkTimeout=90',
    '--set',
    'quickDialPatterns=1[0-9][0-9]\\n2[0-9][0-9]',
    '--yes',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(writes(pbx).at(-1), {
    method: 'PUT',
    path: '/Dialplan/GeneralSettings/',
    body: {
      faxLang: 'EN',
      parkTimeout: 90,
      buttonSound: false,
      quickDialPatterns: '1[0-9][0-9]\n2[0-9][0-9]',
      transferDigitTimeout: '600',
      transferInterDigitTimeout: '2',
    },
  });
  assert.deepEqual(JSON.parse(r.stdout).changed, {
    buttonSound: false,
    parkTimeout: 90,
    quickDialPatterns: '1[0-9][0-9]\n2[0-9][0-9]',
  });
  for (const bad of ['nope=1', 'buttonSound=yes', 'attachFormatVm=ogg', 'parkTimeout=-1', 'novalue']) {
    assert.equal((await wx(pbx, ['dialplan', 'settings-set', '--set', bad, '--yes'])).code, 64, bad);
  }
  assert.equal((await wx(pbx, ['dialplan', 'settings-set', '--yes'])).code, 64);
  const piped = await wx(pbx, ['dialplan', 'settings-set', '--from', '-', '--yes'], {
    stdin: '{"personalRecordType": "transcribe"}',
    output: 'text',
  });
  assert.equal(piped.stdout, 'Updated the dialplan settings: personalRecordType=transcribe\n');
});

test('every routing command has usage, summary, described options and a text formatter', () => {
  const all = [...Object.values(groups).flatMap((g) => Object.values(g.commands)), ...Object.values(dialplanCommands)];
  for (const c of all) {
    assert.ok(c.usage && c.summary && Array.isArray(c.args) && typeof c.text === 'function', c.usage);
    for (const [name, o] of Object.entries(c.options)) assert.ok(o.description, `${c.usage} --${name}`);
  }
});
