#!/usr/bin/env node
// Downloads the OpenAPI of the cloud services wx-admin reaches with the CPA token and keeps what it uses: the
// servers and the operations that accept the token (security wildix.auth.pbx), with their parameters and request
// bodies ($refs resolved), without responses and examples. Wilma comes in one spec per area, merged into one file
// (an operationId two areas share is prefixed with the area). Run by hand; review the diff; commit.
//   node tools/fetch-cloud-specs.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'packages', 'wx-admin', 'specs');
const URL_OF = (name) => `https://docs.wildix.com/codegen/api/${name}-client.openapi.json`;
const SERVICES = {
  kb: ['wim-knowledge-base'],
  voicebots: ['wim-voicebots'],
  tools: ['wim-tools'],
  wilma: [
    'agents',
    'artifacts',
    'assistant',
    'audit',
    'copilot',
    'copilot-sessions',
    'sandbox',
    'secrets',
    'skills',
    'tools',
    'traces',
    'voice',
  ].map((a) => `wilma-${a}`),
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function resolver(spec) {
  const resolve = (v, depth = 0) => {
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth));
    if (!v || typeof v !== 'object') return v;
    if (v.$ref) {
      if (depth > 8) return {type: 'object'};
      const target = v.$ref
        .replace(/^#\//, '')
        .split('/')
        .reduce((o, k) => o?.[k], spec);
      return resolve(target, depth + 1);
    }
    const out = {};
    for (const [k, x] of Object.entries(v))
      if (!['example', 'examples', 'x-codegen'].includes(k)) out[k] = resolve(x, depth);
    return out;
  };
  return resolve;
}

const acceptsCpa = (op, spec) => (op.security ?? spec.security ?? []).some((s) => 'wildix.auth.pbx' in s);

fs.mkdirSync(OUT, {recursive: true});
for (const [service, names] of Object.entries(SERVICES)) {
  const merged = {openapi: '3.0.2', info: {title: service, sources: names.map(URL_OF)}, servers: undefined, paths: {}};
  const seen = new Map();
  for (const name of names) {
    const res = await fetch(URL_OF(name));
    if (!res.ok) throw new Error(`${URL_OF(name)}: ${res.status}`);
    const spec = await res.json();
    const resolve = resolver(spec);
    merged.servers ??= spec.servers;
    for (const [p, item] of Object.entries(spec.paths ?? {})) {
      for (const m of METHODS) {
        const op = item[m];
        if (!op || !acceptsCpa(op, spec)) continue;
        let id = op.operationId;
        if (seen.has(id) && seen.get(id) !== name) id = `${name.replace(/^wilma-/, '')}.${id}`;
        seen.set(op.operationId, name);
        const params = resolve([...(item.parameters ?? []), ...(op.parameters ?? [])]).map((x) => ({
          name: x.name,
          in: x.in,
          required: Boolean(x.required),
          ...(x.schema ? {schema: x.schema} : {}),
          ...(x.description ? {description: x.description} : {}),
        }));
        const body = op.requestBody ? resolve(op.requestBody) : undefined;
        merged.paths[p] ??= {};
        merged.paths[p][m] = {
          operationId: id,
          summary: op.summary ?? '',
          ...(op.description ? {description: op.description} : {}),
          parameters: params,
          ...(body
            ? {requestBody: {required: Boolean(body.required), schema: body.content?.['application/json']?.schema}}
            : {}),
        };
      }
    }
  }
  const file = path.join(OUT, `${service}.openapi.json`);
  fs.writeFileSync(file, `${JSON.stringify(merged)}\n`);
  const ops = Object.values(merged.paths).flatMap((x) => Object.values(x)).length;
  console.log(`${path.relative(ROOT, file)}  ${ops} operations`);
}
