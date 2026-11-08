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

test('Wilma secrets and their references are metadata: shown, not masked', () => {
  const list = {
    secrets: [{id: 'Ab12Cd34', name: 'crm_key', description: 'CRM', status: 'active', revision: 2, attributes: {}}],
    nextCursor: null,
  };
  assert.deepEqual(maskCloud(list), list);
  const one = {secret: {id: 'Ab12Cd34', name: 'crm_key', companyId: 'c1'}};
  assert.deepEqual(maskCloud(one), one);
  const engines = {
    webhook: {url: 'https://hook', secret: {id: 'Ab12Cd34'}, timeout: 10000},
    sqs: {url: 'https://sqs', key: 'AKIA1', secret: {id: 'Ef56Gh78'}},
  };
  assert.deepEqual(maskCloud(engines), {
    webhook: engines.webhook,
    sqs: {url: 'https://sqs', key: MASK, secret: {id: 'Ef56Gh78'}},
  });
  const env = {env: [{name: 'API', secret: {id: 'Ab12Cd34'}}]};
  assert.deepEqual(maskCloud(env), env);
  const mcp = {authorization: {apiKey: {secret: {id: 'Ab12Cd34'}, headerName: 'X-API-Key', prefix: 'Bearer'}}};
  assert.deepEqual(maskCloud(mcp), mcp);
  const shared = {authorization: {shared: {connection: {id: 'Ij90Kl12'}}}};
  assert.deepEqual(maskCloud(shared), shared);
});

test('Wilma agent API key: the metadata is shown, the secret shown once is masked', () => {
  const created = {key: {id: 'k_1234567890', name: 'ci', prefix: 'wak_ab'}, secret: 'wak_ab.full-secret'};
  assert.deepEqual(maskCloud(created), {key: created.key, secret: MASK});
});

test('a key that names a thing (connector, asset, space, annotation) is not a secret', () => {
  const answer = {
    connector: {definition: {key: 'hubspot', version: '1'}, name: 'HubSpot'},
    asset: {key: 'refund-policy', name: 'Refunds', title: 'Refund policy'},
    space: {id: '1', name: 'Docs', key: 'DOC', type: 'global'},
    annotation: {id: 'a1', time: 't', key: 'intent', payload: {}},
    available: {id: 'c1', key: 'hubspot', kind: 'connector', authorization: 'not_connected'},
  };
  assert.deepEqual(maskCloud(answer), answer);
});

test('metadata of authorization is shown: the providers and modes of a connector, its scopes', () => {
  const def = {
    ref: {key: 'hubspot', version: '1'},
    authorization: {provider: 'hubspot', modes: ['user', 'shared']},
    tools: [{id: 't1', authorizationScopes: ['crm.objects.contacts.read']}],
  };
  assert.deepEqual(maskCloud(def), def);
  const token = {tokenType: 'Bearer', accessToken: 'eyJ', expiresAt: 'x'};
  assert.deepEqual(maskCloud(token), {tokenType: 'Bearer', accessToken: MASK, expiresAt: 'x'});
});

test('inside a secret container a value is masked, whatever its shape', () => {
  assert.deepEqual(maskCloud({apiKey: {value: 'k-1', label: 'main'}}), {apiKey: {value: MASK, label: 'main'}});
  assert.deepEqual(maskCloud({tokens: ['t1', 't2']}), {tokens: [MASK, MASK]});
  assert.deepEqual(maskCloud({authorization: {basic: {username: 'u', password: 'p'}}}), {
    authorization: {basic: {username: 'u', password: MASK}},
  });
});

test('a change list hides before and after when its path names a secret', () => {
  const out = maskCloud({
    changes: [
      {path: 'handler.mcp.authorization.customHeaders.X-Api-Key', before: 'OLD', after: 'NEW'},
      {path: '/engine/sqs/key', before: 'AKIAOLD', after: 'AKIANEW'},
      {path: '/handler/mcp/authorization', after: {customHeaders: {Authorization: 'Bearer N'}}},
      {path: '/env', after: [{name: 'DB', value: 'pw'}]},
      {path: '/engine/ai/model', before: 'a', after: 'b'},
    ],
  });
  assert.deepEqual(out.changes[0], {
    path: 'handler.mcp.authorization.customHeaders.X-Api-Key',
    before: MASK,
    after: MASK,
  });
  assert.deepEqual(out.changes[1], {path: '/engine/sqs/key', before: MASK, after: MASK});
  assert.deepEqual(out.changes[2].after, {customHeaders: {Authorization: MASK}});
  assert.deepEqual(out.changes[3].after, [{name: 'DB', value: MASK}]);
  assert.deepEqual(out.changes[4], {path: '/engine/ai/model', before: 'a', after: 'b'});
});

test('inside a secret container a key is masked even next to a name', () => {
  assert.deepEqual(maskCloud({apiKey: {name: 'main', key: 'sk-live-X'}}), {apiKey: {name: 'main', key: MASK}});
  assert.deepEqual(maskCloud({apiKeys: [{id: 'k1', name: 'n', key: 'X'}]}), {
    apiKeys: [{id: 'k1', name: 'n', key: MASK}],
  });
});

test('WIM integrations: the key of a key and secret pair and a Nango connection id are secrets', () => {
  const out = maskCloud({
    installed: [
      {service: 'webhook', data: {type: 'sqs', url: 'https://sqs.x/q', key: 'AKIA1', secret: 's1', events: []}},
      {service: 'webhook', data: {type: 'webhook', url: 'https://hook', key: '', secret: 's2'}},
      {service: 'hubspot_backend', data: {providerConfigKey: 'hubspot', connectionId: 'c-1', hub_id: 7}},
    ],
  });
  assert.equal(out.installed[0].data.key, MASK);
  assert.equal(out.installed[0].data.secret, MASK);
  assert.equal(out.installed[0].data.type, 'sqs');
  assert.equal(out.installed[1].data.key, '');
  assert.equal(out.installed[2].data.connectionId, MASK);
  assert.equal(out.installed[2].data.providerConfigKey, 'hubspot');
  // a key that names a thing stays, and so does a connection id that is not a Nango connection
  assert.deepEqual(maskCloud({key: 'hubspot', version: 2}), {key: 'hubspot', version: 2});
  assert.deepEqual(maskCloud({connectionId: 'conn-1', name: 'x'}), {connectionId: 'conn-1', name: 'x'});
});

test('a voice URI that names a Wilma secret (apiKey=secrets:<id>) is a reference: shown', () => {
  const voice = 'elevenlabs://21m00Tcm4TlvDq8ikWAM?model=eleven_flash_v2_5&apiKey=secrets:Ab12Cd34&speed=1.1';
  assert.equal(maskCloud({voice}).voice, voice);
  assert.equal(maskCloud({voice: 'x://v?apiKey=secrets:{0}'}).voice, 'x://v?apiKey=secrets:{0}');
  assert.equal(maskCloud({voice: 'x://v?apiKey=secrets:Ab12/../k'}).voice, `x://v?apiKey=${MASK}`);
  assert.equal(maskCloud({voice: 'x://v?apiKey=sk-secrets:1'}).voice, `x://v?apiKey=${MASK}`);
  // Only the TTS shape (apiKey=): a token, key or secret that names a secret id stays masked.
  for (const k of ['token', 'key', 'secret', 'api_key', 'access_token'])
    assert.equal(maskCloud({url: `https://h.example/in?${k}=secrets:abc`}).url, `https://h.example/in?${k}=${MASK}`);
});
