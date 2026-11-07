// Output larger than a pipe buffer (64 KB on macOS) must arrive whole, also when the reader is slow: wx never calls
// process.exit() after a write (the agent skills lost data that way, fixed in their 3.2.2).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {test} from 'node:test';

const CHILD = `
import {createMain} from ${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)};
const big = {summary: 's', usage: 'wx big', options: {}, args: [0, 0], run: () => ({items: Array.from({length: 20000}, (_, i) => ({i, text: 'x'.repeat(40)}))})};
const stream = {summary: 's', usage: 'wx stream', options: {}, args: [0, 0], run: (ctx) => { for (let i = 0; i < 3; i++) ctx.emit({event: 'BIG', data: 'y'.repeat(300000)}); }};
process.exitCode = await createMain({groups: {}, commands: {big, stream}})(process.argv.slice(1));
`;

function runSlow(args, delayMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, '--', ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const chunks = [];
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), delayMs);
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => resolve({code, out: Buffer.concat(chunks).toString('utf8')}));
  });
}

test('a 1 MB answer through a pipe with a slow reader arrives whole', async () => {
  const {code, out} = await runSlow(['--output', 'json', 'big'], 500);
  assert.equal(code, 0);
  assert.ok(out.length > 1_000_000, `${out.length} bytes`);
  assert.equal(JSON.parse(out).items.length, 20000);
});

test('streamed lines larger than the pipe buffer arrive whole', async () => {
  const {code, out} = await runSlow(['--output', 'json', 'stream'], 500);
  assert.equal(code, 0);
  const lines = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.data.length),
    [300000, 300000, 300000],
  );
});
