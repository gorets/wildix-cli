// wx-admin cloud: any operation of the Wildix cloud services that accept the CPA token of the PBX (the knowledge
// base, voicebots, WIM tools, Wilma), from their OpenAPI bundled in specs/. GET reads; every other method needs
// --yes. Answers are masked (keys, tokens, passwords) unless --show-secrets.
import {UsageError} from 'wldx-core/errors';
import {readJsonInput} from 'wldx-core/files';
import {apiPath} from 'wldx-core/http';
import {cloudClient} from '../cloud/client.mjs';
import {SERVICES} from '../cloud/env.mjs';
import {operationsOf} from '../cloud/specs.mjs';
import {maskCloud} from '../cloud/mask.mjs';

const segment = (value) => apiPath(['', ''], value);

// The request of an operation: the path with its parameters, the query, the body; usage errors before any request.
export async function requestOf(ctx, service, operationId) {
  const ops = operationsOf(service);
  const op = ops.get(operationId);
  if (!op)
    throw new UsageError(`Unknown operation of ${service}: ${operationId}. Its operations: wx-admin cloud ${service}`);
  const given = new Map();
  for (const kv of ctx.values.param ?? []) {
    const at = kv.indexOf('=');
    if (at < 1) throw new UsageError(`--param is NAME=VALUE: ${kv}`);
    const name = kv.slice(0, at);
    if (!op.params.some((p) => p.name === name))
      throw new UsageError(
        `${operationId} has no parameter ${name}. Its parameters: ${op.params.map((p) => p.name).join(', ') || 'none'}`,
      );
    given.set(name, kv.slice(at + 1));
  }
  for (const p of op.params)
    if (p.required && !given.has(p.name)) throw new UsageError(`${operationId} needs --param ${p.name}=…`);
  const path = op.path.replace(/\{([^}]+)\}/g, (_, name) => segment(given.get(name)));
  const query = Object.fromEntries(
    op.params.filter((p) => p.in === 'query' && given.has(p.name)).map((p) => [p.name, given.get(p.name)]),
  );
  let json;
  const v = ctx.values;
  if (v.data !== undefined && v['data-file'] !== undefined)
    throw new UsageError('Give --data or --data-file, not both');
  if (v.data !== undefined || v['data-file'] !== undefined) {
    if (!op.body) throw new UsageError(`${operationId} takes no body`);
    if (v['data-file'] !== undefined) json = await readJsonInput(ctx, v['data-file']);
    else {
      try {
        json = JSON.parse(v.data);
      } catch {
        throw new UsageError('--data is not JSON');
      }
    }
  } else if (op.bodyRequired) throw new UsageError(`${operationId} needs a body: --data JSON or --data-file FILE`);
  if (op.method !== 'GET' && !v.yes)
    throw new UsageError(
      `${operationId} is a ${op.method}: it changes or runs something in the cloud, confirm with --yes`,
    );
  return {op, path, query, json};
}

export const commands = {
  cloud: {
    summary:
      'any operation of the cloud services (knowledge base, voicebots, WIM tools, Wilma) with the token of the PBX',
    usage:
      'wx-admin cloud [<service> [<operation>]] [--param NAME=VALUE]... [--data JSON | --data-file FILE|-] [--yes] [--show-secrets]',
    details: [
      'Without a service: the services. With a service: its operations. The PBX (--pbx, the default one…) gives its',
      'cloud token to an administrator; the environment is the one of the PBX, or --env prod|stable|stage.',
      'Methods other than GET need --yes. Answers are masked (keys, tokens, passwords) unless --show-secrets.',
    ].join('\n'),
    options: {
      param: {type: 'string', multiple: true, placeholder: 'NAME=VALUE', description: 'a path or query parameter'},
      data: {type: 'string', placeholder: 'JSON', description: 'the JSON body'},
      'data-file': {type: 'string', placeholder: 'FILE', description: 'the JSON body from a file, or - for stdin'},
      yes: {type: 'boolean', description: 'yes, run an operation that is not a GET'},
      'show-secrets': {
        type: 'boolean',
        description: 'show keys, tokens and passwords in the answer (masked otherwise)',
      },
    },
    args: [0, 2],
    complete: 'cloudServices',
    async run(ctx) {
      const [service, operationId] = ctx.positionals;
      if (!service)
        return {
          services: Object.entries(SERVICES).map(([name, s]) => ({
            name,
            label: s.label,
            environments: Object.keys(s.bases),
            operations: operationsOf(name).size,
          })),
        };
      if (!Object.hasOwn(SERVICES, service))
        throw new UsageError(`Unknown cloud service: ${service}. Known: ${Object.keys(SERVICES).join(', ')}`);
      if (!operationId)
        return {
          service,
          operations: [...operationsOf(service)].map(([id, o]) => ({
            operationId: id,
            method: o.method,
            path: o.path,
            summary: o.summary,
          })),
        };
      const {op, path, query, json} = await requestOf(ctx, service, operationId);
      const client = await cloudClient(ctx, service);
      const answer = await client.call(op.method, path, {query, json});
      return ctx.values['show-secrets'] ? answer : maskCloud(answer);
    },
    text(r) {
      if (r?.services)
        return r.services.map(
          (s) => `${s.name.padEnd(10)} ${s.label} · ${s.environments.join(', ')} · ${s.operations} operations`,
        );
      if (r?.operations && r.service)
        return r.operations.map(
          (o) => `${o.operationId.padEnd(40)} ${o.method.padEnd(6)} ${o.path}${o.summary ? `  ${o.summary}` : ''}`,
        );
      return JSON.stringify(r, null, 2);
    },
  },
};
