import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {UsageError} from '../src/errors.mjs';
import {readSecret} from '../src/secret.mjs';

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
