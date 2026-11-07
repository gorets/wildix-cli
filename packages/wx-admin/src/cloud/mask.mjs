// Secrets in the answers of the cloud services, masked: fields whose name says secret (keys, tokens, passwords,
// credentials), the value of a header whose name does (headers as [{name, value}]), every custom header, every
// sandbox environment value, a key or token in the query of a URI; never the cursors and page tokens of paged lists.
// The shapes come from the specs of WIM voicebots, WIM tools and Wilma (docs/research of 2026-11-07).
export const MASK = '********';

const SECRET = /secret|password|passwd|^register$|^key$|api_?key|token|credentials|private_?key|authorization|cookie/i;
const PAGING = /^(?:(?:next|prev|previous)(?:page)?|page)(?:token|cursor)$|^cursor$/i;
const SECRET_HEADER = /authorization|api-?key|token|secret|cookie|auth/i;
const URI_SECRET = /([?&](?:api_?key|access_?token|token|key|secret)=)[^&#\s]+/gi;

const isSecretKey = (k) => SECRET.test(k) && !PAGING.test(k);
const hide = (v) => (v === null || v === undefined || v === '' ? v : MASK);

export function maskCloud(value, key = '') {
  if (Array.isArray(value)) {
    if (/^headers$/i.test(key))
      return value.map((h) =>
        h && typeof h === 'object' && SECRET_HEADER.test(String(h.name ?? h.key ?? ''))
          ? {...maskCloud(h), value: hide(h.value)}
          : maskCloud(h),
      );
    if (/^env$/i.test(key))
      return value.map((e) => (e && typeof e === 'object' ? {...maskCloud(e), value: hide(e.value)} : e));
    return value.map((v) => maskCloud(v));
  }
  if (value && typeof value === 'object') {
    if (/^customHeaders$/i.test(key)) return Object.fromEntries(Object.keys(value).map((k) => [k, hide(value[k])]));
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (isSecretKey(k) && v && typeof v === 'object') return [k, MASK]; // a whole credential (a service account)
        if (isSecretKey(k) && typeof v === 'string') return [k, hide(v)];
        return [k, maskCloud(v, k)];
      }),
    );
  }
  if (typeof value === 'string' && /[?&]/.test(value)) return value.replace(URI_SECRET, `$1${MASK}`);
  return value;
}
