// wx-admin api: any operation of the PBX REST API (https://<pbx>/api/v1, the OpenAPI at /api/v1/doc/), for what has no
// command yet. The access and the PBX are chosen as for every command (--pbx, the default PBX, the only one).
import {UsageError} from 'wldx-core/errors';
import {readJsonInput} from 'wldx-core/files';
import {pbxClient} from '../pbx.mjs';
import {maskSecrets} from './trunk.mjs';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

export const commands = {
  api: {
    summary: 'call any PBX API operation (GET reads; other methods change the PBX and need --yes)',
    usage: 'wx-admin api <method> <path> [--data JSON | --data-file FILE|-] [--query KEY=VALUE]... [--yes]',
    details: [
      'path is relative to /api/v1, e.g. /PBX/Dialplans/ or /Colleagues/. The answer is printed as the PBX sends it,',
      'with {"type":"result","result":X} unwrapped to X, passwords and tokens masked (--show-secrets shows them).',
      'The operations: https://<pbx>/api/v1/doc/ (log in to WMS first).',
    ].join('\n'),
    options: {
      data: {type: 'string', placeholder: 'JSON', description: 'the JSON body'},
      'data-file': {type: 'string', placeholder: 'FILE', description: 'the JSON body from a file, or - for stdin'},
      query: {type: 'string', multiple: true, placeholder: 'KEY=VALUE', description: 'a query parameter'},
      yes: {type: 'boolean', description: 'yes, run a method that changes the PBX'},
      'show-secrets': {
        type: 'boolean',
        description: 'show passwords, secrets and tokens in the answer (masked otherwise)',
      },
    },
    args: [2, 2],
    async run(ctx) {
      const method = ctx.positionals[0].toUpperCase();
      if (!METHODS.includes(method)) throw new UsageError(`The method is one of ${METHODS.join(', ')}`, ctx.usage());
      if (method !== 'GET' && !ctx.values.yes)
        throw new UsageError(`${method} changes the PBX: confirm with --yes`, ctx.usage());
      const raw = ctx.positionals[1];
      if (!/^\/[A-Za-z0-9_./,{}+-]*$/.test(raw) || raw.includes('..'))
        throw new UsageError(`Not an API path (relative to /api/v1, e.g. /PBX/Dialplans/): ${raw}`);
      if (ctx.values.data !== undefined && ctx.values['data-file'] !== undefined)
        throw new UsageError('Give --data or --data-file, not both');
      let body;
      const text = ctx.values.data;
      if (ctx.values['data-file'] !== undefined) {
        if (method === 'GET') throw new UsageError('GET takes no body: use --query');
        body = await readJsonInput(ctx, ctx.values['data-file']); // no credentials, nothing hidden in the home folder
      } else if (text !== undefined) {
        if (method === 'GET') throw new UsageError('GET takes no body: use --query');
        try {
          body = JSON.parse(text);
        } catch {
          throw new UsageError('--data is not JSON');
        }
      }
      const q = new URLSearchParams();
      for (const kv of ctx.values.query ?? []) {
        const at = kv.indexOf('=');
        if (at < 1) throw new UsageError(`--query is KEY=VALUE: ${kv}`);
        q.append(kv.slice(0, at), kv.slice(at + 1));
      }
      const client = await pbxClient(ctx);
      const answer = await client.call(method, raw + (q.size ? `?${q}` : ''), body);
      // Passwords, SIP register strings, keys and tokens are masked unless --show-secrets.
      return ctx.values['show-secrets'] ? answer : maskSecrets(answer);
    },
    text: (r) => JSON.stringify(r, null, 2),
  },
};
