// The operations of the cloud services that accept the CPA token, from the OpenAPI bundled in specs/ (made by
// tools/fetch-cloud-specs.mjs): operationId → {method, path, summary, params, body}.
import fs from 'node:fs';

const cache = new Map();

export function operationsOf(service) {
  if (cache.has(service)) return cache.get(service);
  const spec = JSON.parse(fs.readFileSync(new URL(`../../specs/${service}.openapi.json`, import.meta.url), 'utf8'));
  const ops = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      ops.set(op.operationId, {
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        params: (op.parameters ?? []).map((p) => ({name: p.name, in: p.in, required: p.required})),
        body: Boolean(op.requestBody),
        bodyRequired: Boolean(op.requestBody?.required),
        schema: op.requestBody?.schema,
      });
    }
  }
  cache.set(service, ops);
  return ops;
}
