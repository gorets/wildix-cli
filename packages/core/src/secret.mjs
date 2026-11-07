// Reads a secret (an API key, a token, a password) without echo: hidden typing in a terminal, else the first line
// of stdin (`… | wx-admin pbx add …`). Never from a command line, where other processes can read it.
// askLine() asks a question whose answer may be seen (a host, a user name): only in a terminal, never from stdin,
// which may carry a secret for a later readSecret().
import {UsageError} from './errors.mjs';

const isTerminal = (input) => Boolean(input.isTTY && typeof input.setRawMode === 'function');

// One line typed in raw mode; echo: the typed characters are shown (askLine) or not (readSecret).
async function typed(ctx, prompt, echo) {
  const input = ctx.stdin;
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
          if (ch === '\u007f' || ch === '\b') {
            if (echo && value) ctx.stderr.write('\b \b');
            value = value.slice(0, -1);
          } else if (ch >= ' ') {
            value += ch;
            if (echo) ctx.stderr.write(ch);
          }
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

export async function readSecret(ctx, prompt) {
  if (isTerminal(ctx.stdin)) return typed(ctx, prompt, false);
  const chunks = [];
  for await (const c of ctx.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

// The answer to a question, typed in a terminal; `default` when the answer is empty.
export async function askLine(ctx, prompt, {default: fallback} = {}) {
  if (!isTerminal(ctx.stdin))
    throw new UsageError(`Answering "${prompt.replace(/[:\s]+$/, '')}" needs a terminal: give it as an option`);
  const answer = (await typed(ctx, prompt, true)).trim();
  return answer || fallback || '';
}
