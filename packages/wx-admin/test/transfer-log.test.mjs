import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {openLog} from '../src/transfer/log.mjs';
import {tempConfigDir} from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 7, 15, 4, 12);
const ctx = (env = {}) => ({env: {WILDIX_CONFIG_DIR: tempConfigDir(), ...env}, cwd: tempConfigDir()});

test('the name carries the host and the time; lines are timed; 0600', () => {
  const dir = tempConfigDir();
  const log = openLog(ctx(), {dir, host: 'b.wildixin.com', now: NOW});
  assert.equal(path.basename(log.path), 'wx-admin-import-b.wildixin.com-2026-11-07T15-04-12.log');
  log.line('create queues/support id 5');
  log.line('a \x1b[31mred\x1b[0m line');
  log.close();
  const text = fs.readFileSync(log.path, 'utf8');
  assert.match(text, /^2026-11-07T15:04:12\.000Z create queues\/support id 5$/m);
  assert.ok(!text.includes('\x1b'));
  assert.equal(fs.statSync(log.path).mode & 0o777, 0o600);
});

test('never over an existing file', () => {
  const dir = tempConfigDir();
  openLog(ctx(), {dir, host: 'b', now: NOW}).close();
  assert.throws(() => openLog(ctx(), {dir, host: 'b', now: NOW}), /exists/);
});

test('refuses a hidden folder; the default folder is the current one', () => {
  const c = ctx();
  assert.throws(() => openLog(c, {dir: path.join(c.cwd, '.logs'), host: 'b', now: NOW}), /hidden/i);
  const log = openLog(c, {host: 'b', now: NOW});
  assert.equal(path.dirname(log.path), fs.realpathSync(c.cwd));
  log.close();
});
