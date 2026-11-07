// Text formatters shared by wx calls, meetings and conversations: the AI summary, the insights, the people of a call.
import {duration, oneLine} from 'wldx-core/format';

const SECTIONS = [
  'topics',
  'keyPoints',
  'review',
  'decisions',
  'progress',
  'issues',
  'actionItems',
  'nextSteps',
  'customerInsights',
  'customerResponse',
  'salesProposals',
  'competitiveInformation',
  'implementationTimeline',
  'budget',
  'tags',
];

// "actionItems" -> "Action items"
export const label = (key) => {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const valueText = (v) =>
  v === null || v === undefined
    ? ''
    : typeof v === 'object'
      ? Array.isArray(v) && v.every((x) => typeof x !== 'object')
        ? v.join('; ')
        : JSON.stringify(v)
      : String(v);

function bullets(title, items, indent = '') {
  const list = (items ?? []).filter((x) => x !== null && x !== undefined && x !== '');
  if (!list.length) return [];
  return [`${indent}${title}:`, ...list.map((x) => `${indent}  - ${oneLine(valueText(x), 400)}`)];
}

// The sections of a summary ({topics: [...], decisions: [...], ...}) as bullet lists.
export function sectionLines(json, indent = '') {
  const lines = [];
  for (const key of SECTIONS) if (Array.isArray(json?.[key])) lines.push(...bullets(label(key), json[key], indent));
  if (json?.csat && (json.csat.score || json.csat.reason))
    lines.push(
      `${indent}CSAT: ${[json.csat.score, json.csat.reason && oneLine(json.csat.reason, 300)].filter(Boolean).join(' · ')}`,
    );
  return lines;
}

// GET .../summary: {status, summary: {title, brief, json}}.
export function summaryLines(r) {
  if (r?.status !== 'SUCCEEDED') return [`No summary: ${r?.status ?? 'UNKNOWN'}`];
  const s = r.summary ?? {};
  const lines = [];
  if (s.title) lines.push(oneLine(s.title, 200));
  if (s.brief) lines.push(oneLine(s.brief, 2000));
  const sections = sectionLines(s.json);
  if (sections.length) lines.push('', ...sections);
  return lines;
}

// {projectionId: {fieldId: value}} as "projection" lines with indented "field: value".
export function insightLines(compact, indent = '') {
  const lines = [];
  for (const [id, fields] of Object.entries(compact ?? {})) {
    lines.push(`${indent}${id}:`);
    for (const [f, v] of Object.entries(fields ?? {})) lines.push(`${indent}  ${f}: ${oneLine(valueText(v), 300)}`);
  }
  return lines;
}

// A party of a call: "Name (ext 201) +3902…", whatever is known.
export function party(p) {
  if (!p) return '';
  const ext = p.userExtension ?? p.extension;
  return [p.name, ext && `(${ext})`, p.phone && p.phone !== ext ? p.phone : undefined].filter(Boolean).join(' ');
}

// Seconds or milliseconds as "m:ss".
export const secs = (s) => (Number.isFinite(s) ? duration(s) : '');
// A duration from milliseconds; '—' when there is none (no calls in the window).
export const millis = (ms) => (Number.isFinite(ms) ? duration(ms / 1000) : '—');
