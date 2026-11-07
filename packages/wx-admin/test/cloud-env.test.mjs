import assert from 'node:assert/strict';
import {test} from 'node:test';
import {baseOf, envOf, SERVICES} from '../src/cloud/env.mjs';

test('envOf: the environment of the WIM console the PBX names', () => {
  assert.equal(envOf('https://wim-console-stage.wildix.com'), 'stage');
  assert.equal(envOf('https://wim-console-stable.wildix.com'), 'stable');
  assert.equal(envOf('https://wim-console.wildix.com'), 'prod');
  assert.equal(envOf(undefined), 'prod');
});

test('baseOf: the base URL of a service in an environment', () => {
  assert.equal(baseOf('kb', 'stage'), 'https://kb.wim-stage.wildix.com');
  assert.equal(baseOf('kb', 'prod'), 'https://kb.wim.wildix.com');
  assert.equal(baseOf('voicebots', 'stable'), 'https://wim-stable.wildix.com');
  assert.equal(baseOf('tools', 'stage'), 'https://tools.wim-stage.wildix.com');
  assert.equal(baseOf('wilma', 'prod'), 'https://api.wilma.wildix.com');
  assert.throws(() => baseOf('nope', 'prod'), /Unknown cloud service: nope/);
});

test('kb has no stable', () => {
  assert.throws(() => baseOf('kb', 'stable'), /the knowledge base has no stable environment: prod or stage/);
});

test('every base is https under wildix.com, without a path', () => {
  for (const s of Object.values(SERVICES))
    for (const url of Object.values(s.bases)) assert.match(url, /^https:\/\/[a-z0-9.-]+\.wildix\.com$/);
});
