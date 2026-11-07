import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MASK, maskCloud} from '../src/cloud/mask.mjs';

test('secrets of voicebots, WIM tools and Wilma are masked, in every shape they come in', () => {
  const out = maskCloud({
    endpoint: {
      dialogflowCx: {credentials: {type: 'service_account', private_key: '-----BEGIN', client_email: 'a@b.iam'}},
      openAiAssistant: {key: 'sk-1'},
    },
    webhook: {url: 'https://hook', secret: 's1'},
    functions: [
      {
        headers: [
          {name: 'Authorization', value: 'Bearer abc'},
          {name: 'Accept', value: 'json'},
          {name: 'X-API-Key', value: 'k2'},
        ],
      },
    ],
    smtp: {password: 'p', user: 'u'},
    auth: {bearer: {token: 't'}, oauth: {clientId: 'id', clientSecret: 'cs'}},
    mcp: {customHeaders: {Authorization: 'Bearer z', 'X-Team': 'blue'}},
    sandbox: {env: [{name: 'DB_URL', value: 'postgres://u:p@h/db'}]},
    voice: 'elevenlabs://voice?model=x&apiKey=sk-live-1',
    confluence: {apiKey: 'ATATT-1', username: 'me'},
  });
  assert.equal(out.endpoint.dialogflowCx.credentials, MASK);
  assert.equal(out.endpoint.openAiAssistant.key, MASK);
  assert.equal(out.webhook.secret, MASK);
  assert.equal(out.webhook.url, 'https://hook');
  assert.deepEqual(out.functions[0].headers, [
    {name: 'Authorization', value: MASK},
    {name: 'Accept', value: 'json'},
    {name: 'X-API-Key', value: MASK},
  ]);
  assert.deepEqual(out.smtp, {password: MASK, user: 'u'});
  assert.deepEqual(out.auth, {bearer: {token: MASK}, oauth: {clientId: 'id', clientSecret: MASK}});
  assert.deepEqual(out.mcp.customHeaders, {Authorization: MASK, 'X-Team': MASK});
  assert.deepEqual(out.sandbox.env, [{name: 'DB_URL', value: MASK}]);
  assert.equal(out.voice, `elevenlabs://voice?model=x&apiKey=${MASK}`);
  assert.deepEqual(out.confluence, {apiKey: MASK, username: 'me'});
});

test('cursors and page tokens of paged lists are not secrets', () => {
  const page = {
    items: [],
    nextCursor: 'abc',
    nextToken: 'def',
    pageToken: 'g',
    cursor: 'h',
    metadata: {nextPageToken: 'i'},
  };
  assert.deepEqual(maskCloud(page), page);
});

test('empty values stay as they are', () => {
  assert.deepEqual(maskCloud({password: '', token: null, apiKey: 'stored'}), {password: '', token: null, apiKey: MASK});
});
