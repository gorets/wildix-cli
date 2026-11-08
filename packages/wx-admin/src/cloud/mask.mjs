// Secrets in the answers of the cloud services, masked: fields whose name says secret (keys, tokens, passwords,
// credentials), the value of a header whose name does (headers as [{name, value}]), every custom header, every
// sandbox environment value, a key or token in the query of a URI; never the cursors and page tokens of paged lists.
// What only names or points to a secret stays visible: Wilma secret records and references ({id}), connection
// references, API key metadata, the authorization modes of a connector, a key that names a thing ({key, version},
// {id, key}), ids, types, scopes and statuses. A whole object is hidden only for service account credentials;
// any other object under a secret name is walked, its secret fields masked by name and every `value` in it masked.
// A `key` next to a `secret` is the other half of a key pair (an SQS webhook of WIM integrations), and a
// `connectionId` next to a `providerConfigKey` is a Nango connection: whoever holds its id can bind that CRM.
// The shapes come from the OpenAPI of the knowledge base, WIM voicebots, WIM tools and Wilma (specs/), and from the
// answers of the WIM console API (wx-admin integration).
export const MASK = '********';

const SECRET = /secret|password|passwd|^register$|^key$|api_?key|token|credentials|private_?key|authorization|cookie/i;
const PAGING = /^(?:(?:next|prev|previous)(?:page)?|page)(?:token|cursor)$|^cursor$/i;
// secretId, secretIds, tokenType, authorizationScopes: they say what a secret is, not what it holds.
const DESCRIBES = /[a-z](?:Ids?|Type|Scopes|Status|Modes?)$/;
const WHOLE = /^credentials$/i;
// A `key` next to one of these names a thing (a connector definition, an asset, a space, an annotation).
const NAMING = ['id', 'version', 'name', 'title', 'type', 'kind', 'value', 'payload'];
// The authorization status of a connector in the assistant.
const AUTH_STATUS = /^(?:not_required|not_connected|connected|needs_reconnect)$/;
const SECRET_HEADER = /authorization|api-?key|token|secret|cookie|auth/i;
const URI_SECRET = /([?&](?:api_?key|access_?token|token|key|secret)=)[^&#\s]+/gi;

const isSecretKey = (k) => SECRET.test(k) && !PAGING.test(k) && !DESCRIBES.test(k);
const hide = (v) => (v === null || v === undefined || v === '' ? v : MASK);

function secretString(k, v, siblings, inSecret) {
  if (/^key$/i.test(k) && !inSecret && !('secret' in siblings) && NAMING.some((n) => n in siblings)) return false;
  if (/^authorization$/i.test(k) && AUTH_STATUS.test(v)) return false;
  return true;
}

// A change of a diff or of the audit log: {path, before, after}. The values carry no secret name of their own, so
// the path decides: a segment that names a secret (or custom headers, headers, environment) hides both sides.
const SECRET_PLACE = /^(?:customHeaders|headers|env)$/i;
function maskChange(change, inSecret) {
  const segments = change.path.split(/[/.]/).filter(Boolean);
  const secret = segments.some((s) => isSecretKey(s) || SECRET_PLACE.test(s));
  const last = segments.at(-1) ?? '';
  const side = (v) => {
    if (!secret) return maskCloud(v, last, inSecret);
    if (v && typeof v === 'object') return maskCloud(v, last, true);
    return typeof v === 'string' ? hide(v) : v;
  };
  const out = {};
  for (const [k, v] of Object.entries(change))
    out[k] = k === 'before' || k === 'after' ? side(v) : maskCloud(v, k, inSecret);
  return out;
}

export function maskCloud(value, key = '', inSecret = false) {
  if (Array.isArray(value)) {
    if (/^headers$/i.test(key))
      return value.map((h) =>
        h && typeof h === 'object' && SECRET_HEADER.test(String(h.name ?? h.key ?? ''))
          ? {...maskCloud(h, '', inSecret), value: hide(h.value)}
          : maskCloud(h, '', inSecret),
      );
    if (/^env$/i.test(key))
      return value.map((e) =>
        e && typeof e === 'object' && 'value' in e
          ? {...maskCloud(e, '', inSecret), value: hide(e.value)}
          : maskCloud(e, '', inSecret),
      );
    const own = isSecretKey(key);
    return value.map((v) => (own && typeof v === 'string' ? hide(v) : maskCloud(v, '', inSecret || own)));
  }
  if (value && typeof value === 'object') {
    if (/^customHeaders$/i.test(key)) return Object.fromEntries(Object.keys(value).map((k) => [k, hide(value[k])]));
    if (typeof value.path === 'string' && ('before' in value || 'after' in value)) return maskChange(value, inSecret);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (isSecretKey(k) && WHOLE.test(k) && v && typeof v === 'object') return [k, MASK]; // a service account
        if (isSecretKey(k) && typeof v === 'string' && secretString(k, v, value, inSecret)) return [k, hide(v)];
        if (k === 'connectionId' && 'providerConfigKey' in value && typeof v === 'string') return [k, hide(v)];
        if (inSecret && /^value$/i.test(k) && typeof v === 'string') return [k, hide(v)];
        return [k, maskCloud(v, k, inSecret || (isSecretKey(k) && v !== null && typeof v === 'object'))];
      }),
    );
  }
  if (typeof value === 'string' && /[?&]/.test(value)) return value.replace(URI_SECRET, `$1${MASK}`);
  return value;
}
