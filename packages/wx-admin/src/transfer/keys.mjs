// Leaf module of the config transfer (it imports nothing): the key of an object and the markers, for the engine and
// for the portable hooks of the kinds (pbx-portable.mjs, cloud/*), which never import refs.mjs or kinds.mjs.

// The key of an object: "<kind>/<name>" (a name may hold "/").
export const keyOf = (kind, name) => `${kind}/${name}`;
export function splitKey(key) {
  const at = key.indexOf('/');
  return {kind: key.slice(0, at), name: key.slice(at + 1)};
}

// A marker of refs.mjs: {$ref}, {$self}, {$secret}, {$external}, {$file} (a skill file) or {$template}.
export const isMarker = (v) =>
  Boolean(v) &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  ('$ref' in v || '$self' in v || '$secret' in v || '$external' in v || '$file' in v || '$template' in v);
