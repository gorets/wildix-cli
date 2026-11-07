import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {UsageError} from '../src/errors.mjs';
import {createModel, select} from '../src/select.mjs';

// Routing: main needs q1 and tt; tt needs nothing; q2 is blocked. Trunks: t1.
const GROUPS = [
  {
    id: 'routing',
    label: 'Routing',
    items: [
      {id: 'dialplans/main', label: 'main', badge: 'new'},
      {id: 'queues/q1', label: 'q1', badge: 'new'},
      {id: 'timetables/tt', label: 'tt', badge: 'differs'},
      {id: 'queues/q2', label: 'q2', badge: 'blocked', disabled: 'needs queues/q9'},
    ],
  },
  {id: 'trunks', label: 'Trunks', items: [{id: 'trunks-sip/t1', label: 't1', badge: 'new', checked: true}]},
];
const NEEDS = {'dialplans/main': ['queues/q1', 'timetables/tt']};
const requires = (id) => NEEDS[id] ?? [];
const model = () => createModel({groups: GROUPS, requires});
const row = (m, id) => m.rows().find((r) => r.id === id);

test('ticking an item ticks what it requires', () => {
  const m = model();
  m.toggle('dialplans/main');
  assert.deepEqual([...m.selected()].sort(), ['dialplans/main', 'queues/q1', 'timetables/tt', 'trunks-sip/t1']);
});

test('an item a ticked one requires cannot be unticked', () => {
  const m = model();
  m.toggle('dialplans/main');
  m.toggle('queues/q1');
  assert.ok(m.selected().has('queues/q1'));
  assert.match(row(m, 'queues/q1').note, /needed by main/);
  m.toggle('dialplans/main');
  m.toggle('queues/q1');
  assert.ok(!m.selected().has('queues/q1'));
});

test('a disabled item never toggles and shows its reason', () => {
  const m = model();
  m.toggle('queues/q2');
  assert.ok(!m.selected().has('queues/q2'));
  assert.equal(row(m, 'queues/q2').disabled, 'needs queues/q9');
});

test('toggleGroup ticks every enabled item, again unticks them', () => {
  const m = model();
  m.toggleGroup('routing');
  assert.deepEqual([...m.selected()].filter((id) => !id.startsWith('trunks')).sort(), [
    'dialplans/main',
    'queues/q1',
    'timetables/tt',
  ]);
  m.toggleGroup('routing');
  assert.deepEqual([...m.selected()], ['trunks-sip/t1']);
});

test('filter keeps matching items and their groups', () => {
  const m = model();
  m.setFilter('Q');
  assert.deepEqual(
    m.rows().map((r) => r.id),
    ['routing', 'queues/q1', 'queues/q2'],
  );
  m.setFilter('');
  assert.equal(m.rows().length, 7);
});

test('collapsing a group hides its items; the cursor moves over rows', () => {
  const m = model();
  m.expand('routing', false);
  assert.deepEqual(
    m.rows().map((r) => r.id),
    ['routing', 'trunks', 'trunks-sip/t1'],
  );
  m.move(2);
  assert.equal(m.rows().find((r) => r.cursor).id, 'trunks-sip/t1');
  m.move(10);
  assert.equal(m.rows().find((r) => r.cursor).id, 'trunks-sip/t1');
});

// A terminal: raw mode recorded; keys fed one chunk at a time once the picker listens.
function terminal(keys) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.raw = [];
  stdin.setRawMode = (on) => stdin.raw.push(on);
  stdin.setEncoding = () => {};
  stdin.pause = () => {};
  stdin.resume = () => {
    let i = 0;
    const next = () => {
      if (i < keys.length) {
        stdin.emit('data', keys[i++]);
        setImmediate(next);
      }
    };
    setImmediate(next);
  };
  const stderr = {
    isTTY: true,
    rows: 20,
    columns: 80,
    text: '',
    write(s) {
      this.text += s;
      return true;
    },
  };
  return {stdin, stderr};
}

test('space and enter return the ticked ids', async () => {
  const io = terminal(['\x1b[B', ' ', '\r']); // down to "main", tick it, confirm
  const chosen = await select(io, {title: 'Export', groups: GROUPS, requires});
  assert.deepEqual([...chosen].sort(), ['dialplans/main', 'queues/q1', 'timetables/tt', 'trunks-sip/t1']);
  assert.deepEqual(io.stdin.raw, [true, false]);
  assert.match(io.stderr.text, /Export/);
});

test('a filter typed after / narrows the list; enter leaves the filter, then confirms', async () => {
  const io = terminal(['/', 't', '1', '\r', '\x1b[B', ' ', '\r']);
  const chosen = await select(io, {title: 'Export', groups: GROUPS, requires});
  assert.deepEqual([...chosen], []);
});

test('restores the terminal on cancel and on error', async () => {
  let io = terminal(['\x03']);
  await assert.rejects(select(io, {title: 'x', groups: GROUPS, requires}), /Cancelled/);
  assert.deepEqual(io.stdin.raw, [true, false]);
  io = terminal(['\x1b']);
  await assert.rejects(select(io, {title: 'x', groups: GROUPS, requires}), /Cancelled/);
  assert.deepEqual(io.stdin.raw, [true, false]);
  io = terminal(['\x1b[B', ' ']);
  const broken = () => {
    throw new Error('boom');
  };
  await assert.rejects(select(io, {title: 'x', groups: GROUPS, requires: broken}), /boom/);
  assert.deepEqual(io.stdin.raw, [true, false]);
  assert.equal(io.stdin.listenerCount('data'), 0);
});

test('refuses without a terminal', async () => {
  const io = terminal([]);
  io.stdin.isTTY = false;
  await assert.rejects(
    select(io, {title: 'x', groups: GROUPS, requires}),
    (e) => e instanceof UsageError && /--all or --only/.test(e.message),
  );
  assert.deepEqual(io.stdin.raw, []);
});

test('review 7: labels, badges, notes and reasons are drawn without terminal escapes or line breaks', async () => {
  const groups = [
    {
      id: 'g',
      label: 'G\x1b]0;evil\x07',
      items: [{id: 'a', label: 'a\x1b]52;c;Zm9v\x07\nb', badge: 'n\x1b[2J', note: 'x\ry', disabled: 'r\x1b]0;t\x07'}],
    },
  ];
  const io = terminal(['\r']);
  await select(io, {title: 'T\x1b]0;x\x07', groups, requires: () => []});
  assert.ok(!/\x1b\]|\x1b\[2J|\x07/.test(io.stderr.text), JSON.stringify(io.stderr.text));
  assert.ok(!/a\x1b|a\nb/.test(io.stderr.text));
});
