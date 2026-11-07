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
