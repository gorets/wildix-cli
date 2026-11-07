// Text output: what `--output text` (the default) prints. A command gives `text(result, ctx)` (and `textEvent(event,
// ctx)` for a streaming one) returning a string or an array of lines; without one, toText() prints the data as
// indented "key: value" lines. Helpers for formatters: colors (only on a terminal), times, tables.

// Colors: on when ctx.color (a terminal, no --no-color, no NO_COLOR).
const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39],
};
export function paint(ctx) {
  const on = Boolean(ctx?.color);
  return Object.fromEntries(
    Object.entries(CODES).map(([name, [a, b]]) => [name, (s) => (on ? `\x1b[${a}m${s}\x1b[${b}m` : String(s))]),
  );
}

const pad2 = (n) => String(n).padStart(2, '0');

// "2026-11-07 10:23" in the local time zone of the machine (ISO string or ms); '' for nothing.
export function localTime(value, {seconds = false} = {}) {
  if (value === undefined || value === null || value === '') return '';
  const d = new Date(typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : value);
  if (Number.isNaN(d.getTime())) return String(value);
  const t = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return seconds ? `${t}:${pad2(d.getSeconds())}` : t;
}

// "1:05:09" / "5:09" from seconds.
export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

// One line: newlines folded, cut to max characters.
export function oneLine(text, max = 120) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Aligned columns: rows are arrays of cells; the last column is not padded. Colors in cells are not counted.
export function table(rows) {
  const visible = (s) => String(s ?? '').replace(/\x1b\[\d+m/g, '').length;
  const widths = [];
  for (const row of rows) for (const [i, c] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, visible(c));
  return rows.map((row) =>
    row
      .map((c, i) => (i === row.length - 1 ? String(c ?? '') : String(c ?? '') + ' '.repeat(widths[i] - visible(c))))
      .join('  ')
      .trimEnd(),
  );
}

const scalar = (v) => v === null || typeof v !== 'object';

// Any data as indented "key: value" lines (the fallback of commands without a formatter).
export function toText(value, indent = '') {
  if (value === undefined) return [];
  if (scalar(value)) return [`${indent}${value}`];
  const lines = [];
  if (Array.isArray(value)) {
    if (value.every(scalar)) return [`${indent}${value.join(', ')}`];
    value.forEach((item, i) => {
      if (i && !scalar(item)) lines.push('');
      lines.push(...toText(item, indent));
    });
    return lines;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (scalar(v)) lines.push(`${indent}${k}: ${v}`);
    else if (Array.isArray(v) && v.every(scalar)) lines.push(`${indent}${k}: ${v.join(', ')}`);
    else if (Array.isArray(v) && !v.length) lines.push(`${indent}${k}: (none)`);
    else lines.push(`${indent}${k}:`, ...toText(v, `${indent}  `));
  }
  return lines;
}

// Text for a terminal from data that may hold control sequences (a message, a name, an error of a service): kept
// are newlines, tabs and the color codes paint() itself writes; every other control character is dropped, so a
// fetched text cannot write the clipboard (OSC 52), move the cursor, rewrite lines or hide text.
const OWN_SGR = new Set(Object.values(CODES).flat().map(String));
export function clean(text) {
  // NUL goes first: it then marks the color codes that are kept, and no input can forge such a mark.
  return String(text)
    .replace(/\u0000/g, '')
    .replace(/\x1b\[(\d+)m/g, (m, code) => (OWN_SGR.has(code) ? `\u0000${code}\u0000` : ''))
    .replace(/[\x01-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\u0000(\d+)\u0000/g, '\x1b[$1m');
}
