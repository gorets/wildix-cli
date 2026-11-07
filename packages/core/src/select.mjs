// A checkbox tree for the terminal, without dependencies: groups of items, each item with a badge and a note, items
// that bring others with them (`requires`) and items that cannot be chosen (`disabled`, with the reason). Drawn on
// stderr (stdout stays data). createModel() is the state, select() the keyboard and the drawing around it.
//
//   ↑/↓ or k/j move · space ticks (on a group: the whole group) · →/← open and close a group · a: the whole group
//   / filters by name (enter ends the filter, esc clears it) · enter confirms · esc or Ctrl-C cancels
import {UsageError} from './errors.mjs';
import {clean} from './format.mjs';

export function createModel({groups, requires = () => []}) {
  const items = new Map();
  for (const g of groups) for (const it of g.items) items.set(it.id, {...it, group: g.id});
  const checked = new Set([...items.values()].filter((it) => it.checked && !it.disabled).map((it) => it.id));
  const open = new Set(groups.map((g) => g.id));
  const notes = new Map(); // a note the model sets (a refused untick), over the item's own
  let filter = '';
  let cursor = 0;

  // Everything an item brings with it, itself included (disabled items are never brought).
  const closure = (id, seen = new Set()) => {
    if (seen.has(id) || !items.has(id) || items.get(id).disabled) return seen;
    seen.add(id);
    for (const r of requires(id)) closure(r, seen);
    return seen;
  };
  // A ticked item, outside `except`, that needs `id`.
  const neededBy = (id, except = new Set()) =>
    [...checked].find((c) => c !== id && !except.has(c) && closure(c).has(id));
  const matches = (it) => !filter || it.label.toLowerCase().includes(filter.toLowerCase());

  function rows() {
    const out = [];
    for (const g of groups) {
      const visible = g.items.filter(matches);
      if (filter && !visible.length) continue;
      const enabled = g.items.filter((it) => !it.disabled);
      const ticked = enabled.filter((it) => checked.has(it.id)).length;
      out.push({
        kind: 'group',
        id: g.id,
        label: g.label,
        note: `${ticked}/${enabled.length}`,
        checked: enabled.length > 0 && ticked === enabled.length,
        open: open.has(g.id),
      });
      if (!open.has(g.id)) continue;
      for (const it of visible) {
        out.push({
          kind: 'item',
          id: it.id,
          label: it.label,
          badge: it.badge,
          note: notes.get(it.id) ?? it.note,
          checked: checked.has(it.id),
          disabled: it.disabled,
        });
      }
    }
    cursor = Math.max(0, Math.min(cursor, out.length - 1));
    return out.map((r, i) => ({...r, cursor: i === cursor}));
  }

  function untick(id, except) {
    const by = neededBy(id, except);
    if (by) {
      notes.set(id, `needed by ${items.get(by).label}`);
      return false;
    }
    checked.delete(id);
    notes.delete(id);
    return true;
  }

  const model = {
    toggle(id) {
      const it = items.get(id);
      if (!it || it.disabled) return;
      if (checked.has(id)) untick(id);
      else for (const c of closure(id)) checked.add(c);
    },
    toggleGroup(groupId) {
      const enabled = [...items.values()].filter((it) => it.group === groupId && !it.disabled).map((it) => it.id);
      if (enabled.length && enabled.every((id) => checked.has(id))) {
        const leaving = new Set(enabled);
        for (const id of enabled) untick(id, leaving);
      } else {
        for (const id of enabled) for (const c of closure(id)) checked.add(c);
      }
    },
    setFilter(text) {
      filter = text;
      cursor = 0;
    },
    get filter() {
      return filter;
    },
    move(delta) {
      cursor += delta;
      rows();
    },
    expand(groupId, on) {
      if (on) open.add(groupId);
      else open.delete(groupId);
    },
    current: () => rows().find((r) => r.cursor),
    selected: () => new Set(checked),
    rows,
  };
  return model;
}

// One screen of the picker: the title, the keys, the rows around the cursor.
function draw(model, title, height, filtering) {
  const all = model.rows();
  const at = all.findIndex((r) => r.cursor);
  const room = Math.max(3, height);
  const start = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
  const lines = [
    title,
    filtering || model.filter
      ? `filter: ${model.filter}${filtering ? '_' : ''}   (enter: done, esc: clear)`
      : 'space: tick · ↑↓ move · →← open/close · a: group · /: filter · enter: done · esc: cancel',
  ];
  for (const r of all.slice(start, start + room)) {
    const mark = r.cursor ? '›' : ' ';
    if (r.kind === 'group') {
      lines.push(`${mark} ${r.open ? '▾' : '▸'} ${r.checked ? '[x]' : '[ ]'} ${r.label}  ${r.note}`);
      continue;
    }
    const box = r.disabled ? '[-]' : r.checked ? '[x]' : '[ ]';
    const badge = r.badge ? ` (${r.badge})` : '';
    const note = r.disabled ? ` — ${r.disabled}` : r.note ? ` — ${r.note}` : '';
    lines.push(`${mark}     ${box} ${r.label}${badge}${note}`);
  }
  return lines;
}

// Opens the picker; resolves with the ids of the ticked items, rejects UsageError('Cancelled') on esc or Ctrl-C.
// The terminal is always given back in its normal mode.
export function select(io, {title, groups, requires}) {
  const {stdin, stderr} = io;
  if (!stdin.isTTY || !stderr.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new UsageError('Choosing needs a terminal: without one, choose with --all or --only'));
  }
  const model = createModel({groups, requires});
  const height = (stderr.rows ?? 24) - 4;
  let drawn = 0;
  let filtering = false;
  const paint = () => {
    // Labels, notes and reasons come from a PBX or a file: no terminal escapes, no line breaks.
    const lines = draw(model, title, height, filtering).map((l) =>
      clean(l)
        .replace(/\x1b\[[0-9;]*m|[\r\n\t]/g, ' ')
        .slice(0, (stderr.columns ?? 80) - 1),
    );
    stderr.write(`${drawn ? `\x1b[${drawn}A` : ''}\x1b[J${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      fn(value);
    };
    const key = (k) => {
      if (filtering) {
        if (k === '\r' || k === '\n') filtering = false;
        else if (k === '\x1b') {
          filtering = false;
          model.setFilter('');
        } else if (k === '\x7f' || k === '\b') model.setFilter(model.filter.slice(0, -1));
        else if (k === '\x03') return finish(reject, new UsageError('Cancelled'));
        else if (k.length === 1 && k >= ' ') model.setFilter(model.filter + k);
        return undefined;
      }
      const r = model.current();
      if (k === '\r' || k === '\n') return finish(resolve, model.selected());
      if (k === '\x03' || k === '\x1b') return finish(reject, new UsageError('Cancelled'));
      if (k === '\x1b[A' || k === 'k') model.move(-1);
      else if (k === '\x1b[B' || k === 'j') model.move(1);
      else if (k === '\x1b[C' && r?.kind === 'group') model.expand(r.id, true);
      else if (k === '\x1b[D' && r) model.expand(r.kind === 'group' ? r.id : groupOf(r.id), false);
      else if (k === ' ' && r) r.kind === 'group' ? model.toggleGroup(r.id) : model.toggle(r.id);
      else if (k === 'a' && r) model.toggleGroup(r.kind === 'group' ? r.id : groupOf(r.id));
      else if (k === '/') filtering = true;
      return undefined;
    };
    const groupOf = (id) => groups.find((g) => g.items.some((it) => it.id === id))?.id;
    // A chunk may hold several keys; an arrow is ESC [ X.
    const onData = (chunk) => {
      try {
        const s = String(chunk);
        for (let i = 0; i < s.length; ) {
          const k = s[i] === '\x1b' && s[i + 1] === '[' ? s.slice(i, i + 3) : s[i];
          i += k.length;
          key(k);
          if (!stdin.listenerCount('data')) return;
        }
        paint();
      } catch (e) {
        finish(reject, e);
      }
    };
    try {
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.resume();
      paint();
    } catch (e) {
      finish(reject, e);
    }
  });
}

// One item out of a short list (a menu): ↑/↓ or k/j move and skip disabled items, 1–9 pick, enter confirms, esc or
// Ctrl-C cancel. items: [{label, note?, disabled?: reason}]. Resolves to the index. Without a terminal it is a usage
// error (the caller offers options instead).
export async function choose(io, {title, items, initial = 0}) {
  const {stdin, stderr} = io;
  const usable = (i) => i >= 0 && i < items.length && !items[i].disabled;
  const one = (s) =>
    clean(String(s ?? ''))
      .replace(/\x1b\[[0-9;]*m|[\r\n\t]/g, ' ')
      .slice(0, (stderr.columns ?? 80) - 6);
  const lines = (at) => [
    one(title),
    '',
    ...items.flatMap((it, i) => [
      `${at === i ? '›' : ' '} ${i + 1}. ${one(it.label)}${it.disabled ? ` (${one(it.disabled)})` : ''}`,
      ...(it.note ? [`     ${one(it.note)}`] : []),
    ]),
  ];
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function')
    throw new UsageError('Choosing needs a terminal: give the choice as an option');

  let at = usable(initial) ? initial : items.findIndex((_, i) => usable(i));
  let drawn = 0;
  const paint = () => {
    const out = lines(at);
    stderr.write(`${drawn ? `\x1b[${drawn}A` : ''}\x1b[J${out.join('\n')}\n`);
    drawn = out.length;
  };
  const step = (d) => {
    for (let i = at + d; i >= 0 && i < items.length; i += d) {
      if (usable(i)) {
        at = i;
        return;
      }
    }
  };
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      fn(value);
    };
    const onData = (chunk) => {
      const s = String(chunk);
      for (let i = 0; i < s.length; ) {
        const k = s[i] === '\x1b' && s[i + 1] === '[' ? s.slice(i, i + 3) : s[i];
        i += k.length;
        if (k === '\r' || k === '\n') return finish(resolve, at);
        if (k === '\x03' || k === '\x1b') return finish(reject, new UsageError('Cancelled'));
        if (k === '\x1b[A' || k === 'k') step(-1);
        else if (k === '\x1b[B' || k === 'j') step(1);
        else if (/^[1-9]$/.test(k) && usable(Number(k) - 1)) return finish(resolve, Number(k) - 1);
      }
      paint();
      return undefined;
    };
    try {
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.resume();
      paint();
    } catch (e) {
      finish(reject, e);
    }
  });
}
