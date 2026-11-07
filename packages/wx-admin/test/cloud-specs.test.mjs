import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operationsOf} from '../src/cloud/specs.mjs';

test('kb has its 33 operations', () => {
  assert.equal(operationsOf('kb').size, 33);
});

test('ListDocuments: its query parameters and its path parameter', () => {
  const op = operationsOf('kb').get('ListDocuments');
  assert.equal(op.method, 'GET');
  assert.equal(op.path, '/api/v1/data-sources/{dataSourceId}/documents');
  assert.deepEqual(
    op.params
      .filter((p) => p.in === 'query')
      .map((p) => p.name)
      .sort(),
    ['company', 'limit', 'offset', 'originalId', 'search', 'sort', 'status'],
  );
  assert.deepEqual(
    op.params.filter((p) => p.in === 'path'),
    [{name: 'dataSourceId', in: 'path', required: true}],
  );
});

test('CreateKnowledgeBase takes a body, GetKnowledgeBase does not', () => {
  assert.equal(operationsOf('kb').get('CreateKnowledgeBase').body, true);
  assert.equal(operationsOf('kb').get('GetKnowledgeBase').body, false);
});

test('every service loads, wilma operations are unique', () => {
  for (const s of ['kb', 'voicebots', 'tools', 'wilma']) assert.ok(operationsOf(s).size > 0, s);
  assert.equal(operationsOf('wilma').size, 174);
});
