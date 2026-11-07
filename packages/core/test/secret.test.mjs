import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {UsageError} from '../src/errors.mjs';
import {askLine, readSecret} from '../src/secret.mjs';

const sink = () => ({
  text: '',
  write(s) {
    this.text += s;
    return true;
  },
});

// A terminal stdin: raw mode recorded, chunks fed after the prompt.
function tty(chunks) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (on) => input.raw.push(on);
  input.resume = () =>
    setImmediate(() => {
      for (const c of chunks) input.emit('data', c);
    });
  input.pause = () => {};
  input.setEncoding = () => {};
  return input;
}

test('reads the first line of stdin when it is not a terminal', async () => {
  const stdin = Readable.from([Buffer.from('pw\nrest')]);
  assert.equal(await readSecret({stdin, stderr: sink()}, 'Password: '), 'pw');
});

test('hides typing in a terminal: backspace edits, enter ends, raw mode set then unset', async () => {
  const stdin = tty(['ab\x7fc\r']);
  const stderr = sink();
  assert.equal(await readSecret({stdin, stderr}, 'Password: '), 'ac');
  assert.deepEqual(stdin.raw, [true, false]);
  assert.equal(stderr.text, 'Password: \n');
});

test('Ctrl-C cancels with a UsageError and restores raw mode', async () => {
  const stdin = tty(['ab\x03']);
  await assert.rejects(
    readSecret({stdin, stderr: sink()}, 'Password: '),
    (e) => e instanceof UsageError && /Cancelled/.test(e.message),
  );
  assert.deepEqual(stdin.raw, [true, false]);
});

test('askLine: echoes what is typed and returns the line', async () => {
  const stderr = sink();
  const v = await askLine({stdin: tty(['pb', 'x1', '\x7f', '2\r']), stderr}, 'PBX: ');
  assert.equal(v, 'pbx2');
  assert.match(stderr.text, /PBX: /);
  assert.match(stderr.text, /pb/);
});

test('askLine: an empty answer takes the default', async () => {
  assert.equal(await askLine({stdin: tty(['\r']), stderr: sink()}, 'User [admin]: ', {default: 'admin'}), 'admin');
});

test('askLine: without a terminal it is a usage error and stdin is not read', async () => {
  const stdin = Readable.from(['secret\n']);
  await assert.rejects(
    askLine({stdin, stderr: sink()}, 'PBX: '),
    (e) => e instanceof UsageError && /terminal/.test(e.message),
  );
  const left = [];
  for await (const c of stdin) left.push(String(c));
  assert.equal(left.join(''), 'secret\n');
});

test('askLine: Ctrl-C cancels', async () => {
  await assert.rejects(askLine({stdin: tty(['\x03']), stderr: sink()}, 'PBX: '), /Cancelled/);
});
