import assert from 'node:assert/strict';
import {test} from 'node:test';
import {UsageError} from 'wldx-core/errors';
import {apiPath, query} from 'wldx-core/http';
import {channelId, messageId, streamBase} from '../src/stream.mjs';

test('channelId takes an id, a type:id form and an inbox link', () => {
  assert.equal(channelId('abc-1'), 'abc-1');
  assert.equal(channelId('group:abc-1'), 'abc-1');
  assert.equal(channelId('https://app.x-bees.com/inbox/abc-1/msg-2?x=1#y'), 'abc-1');
  assert.equal(channelId('abc/rest'), 'abc'); // a path keeps its first segment, as in the skill
  for (const bad of ['', '..', 'a..b', '/abc', 'https://example.com/x'])
    assert.throws(() => channelId(bad), UsageError, bad);
});

test('messageId takes an id or the last segment of a link', () => {
  assert.equal(messageId('m1'), 'm1');
  assert.equal(messageId('https://app.x-bees.com/inbox/abc/m1/'), 'm1');
  assert.throws(() => messageId('..'), UsageError);
});

test('streamBase: eu-1 by default, a region, only *.wildix.com unless allowed', () => {
  assert.equal(streamBase({}), 'https://eu-1.stream.wildix.com');
  assert.equal(streamBase({WILDIX_STREAM_REGION: 'us-1'}), 'https://us-1.stream.wildix.com');
  assert.throws(() => streamBase({WILDIX_STREAM_URL: 'http://eu-1.stream.wildix.com'}), UsageError);
  assert.throws(() => streamBase({WILDIX_STREAM_URL: 'https://wildix.com.evil.example'}), UsageError);
  assert.throws(() => streamBase({WILDIX_STREAM_REGION: 'x.evil.example/'}), UsageError);
  assert.equal(
    streamBase({WILDIX_STREAM_URL: 'http://localhost:9000/', WILDIX_ALLOW_CUSTOM_URL: '1'}),
    'http://localhost:9000',
  );
});

test('apiPath refuses a segment that would change the path', () => {
  assert.equal(apiPath`/channels/${'a_b.c:1'}/messages`, '/channels/a_b.c%3A1/messages');
  for (const bad of ['', '..', 'a/b', 'a?b', 'a#b', '.hidden']) assert.throws(() => apiPath`/channels/${bad}`, bad);
});

test('query leaves out empty values and encodes the rest', () => {
  assert.equal(query({a: undefined, b: '', c: false, d: 0, e: 'x y&z'}), '?d=0&e=x+y%26z');
  assert.equal(query({}), '');
});
