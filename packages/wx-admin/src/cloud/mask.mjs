// Secrets in the answers of the cloud services, masked: fields whose name says secret (keys, tokens, passwords,
// credentials), the value of a header whose name does (headers as [{name, value}]), every custom header, every
// sandbox environment value, a key or token in the query of a URI; never the cursors and page tokens of paged lists.
// What only names or points to a secret stays visible: Wilma secret records and references ({id}), connection
// references, API key metadata, the authorization modes of a connector, a key that names a thing ({key, version},
// {id, key}), ids, types, scopes and statuses. A whole object is hidden only for service account credentials;
// any other object under a secret name is walked, its secret fields masked by name and every `value` in it masked.
// The shapes come from the OpenAPI of the knowledge base, WIM voicebots, WIM tools and Wilma (specs/).
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

function secretString(k, v, siblings) {
  if (/^key$/i.test(k) && NAMING.some((n) => n in siblings)) return false;
  if (/^authorization$/i.test(k) && AUTH_STATUS.test(v)) return false;
  return true;
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
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (isSecretKey(k) && WHOLE.test(k) && v && typeof v === 'object') return [k, MASK]; // a service account
        if (isSecretKey(k) && typeof v === 'string' && secretString(k, v, value)) return [k, hide(v)];
        if (inSecret && /^value$/i.test(k) && typeof v === 'string') return [k, hide(v)];
        return [k, maskCloud(v, k, inSecret || (isSecretKey(k) && v !== null && typeof v === 'object'))];
      }),
    );
  }
  if (typeof value === 'string' && /[?&]/.test(value)) return value.replace(URI_SECRET, `$1${MASK}`);
  return value;
}
