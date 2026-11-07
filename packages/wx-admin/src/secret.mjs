// Reads a secret (an API key, a token, a password) without echo: hidden typing in a terminal, else the first line
// of stdin (`… | wx-admin pbx add …`). Never from a command line, where other processes can read it.
import {UsageError} from 'wldx-core/errors';

export async function readSecret(ctx, prompt) {
  const input = ctx.stdin;
  if (input.isTTY && typeof input.setRawMode === 'function') {
    ctx.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    try {
      return await new Promise((resolve, reject) => {
        let value = '';
        const onData = (chunk) => {
          for (const ch of chunk) {
            if (ch === '\r' || ch === '\n') {
              input.off('data', onData);
              ctx.stderr.write('\n');
              return resolve(value);
            }
            if (ch === '\u0003') {
              input.off('data', onData);
              ctx.stderr.write('\n');
              return reject(new UsageError('Cancelled'));
            }
            if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
            else value += ch;
          }
          return undefined;
        };
        input.on('data', onData);
      });
    } finally {
      input.setRawMode(false);
      input.pause();
    }
  }
  const chunks = [];
  for await (const c of input) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}
