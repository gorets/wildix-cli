import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups} from '../src/commands/user.mjs';
import {fakeFetch, fakeJwt, run} from './helpers.mjs';

const API = 'https://eu-1.stream.wildix.com/api/v1';
const env = {WILDIX_ID_TOKEN: fakeJwt({email: 'me@example.com'})};
const registry = {groups};
const wx = (argv, options = {}) => run(argv, {env, registry, ...options});
const anna = {
  id: 'annaUserId01',
  displayName: 'Anna Rossi',
  email: 'anna@example.com',
  pbxExtension: '201',
  phone: '+390212345',
  bot: false,
};

test('user me looks the logged-in user up by the e-mail of the token', async () => {
  const fetch = fakeFetch({body: {users: [anna]}});
  const r = await wx(['user', 'me'], {fetch});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(`${fetch.calls[0].method} ${fetch.calls[0].url}`, `POST ${API}/users/query`);
  assert.deepEqual(fetch.calls[0].body, {query: {emails: ['me@example.com']}});
  assert.deepEqual(JSON.parse(r.stdout), anna);
});

test('user find passes the search options; --brief keeps what is needed to pick a person', async () => {
  const answer = {
    results: [
      {user: anna, confidence: 0.75, matchedOn: 'phonetic'},
      {user: {...anna, id: 'other0000001', displayName: 'Anna Bianchi'}, confidence: 0.74, matchedOn: 'fuzzy'},
    ],
    margin: 0.01,
    nextCursor: 'n',
  };
  let fetch = fakeFetch({body: answer});
  let r = await wx(
    [
      'user',
      'find',
      'Anna R',
      '--mode',
      'name',
      '--kind',
      'all',
      '--with-extension',
      '--min-confidence',
      '0.3',
      '--size',
      '10',
      '--cursor',
      'c',
    ],
    {fetch},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    fetch.calls[0].url,
    `${API}/search/users?q=Anna+R&mode=name&kind=all&withExtensionOnly=true&minConfidence=0.3&size=10&cursor=c`,
  );
  assert.deepEqual(JSON.parse(r.stdout), answer);

  fetch = fakeFetch({body: answer});
  r = await wx(['user', 'find', 'Anna', '--brief'], {fetch});
  assert.deepEqual(JSON.parse(r.stdout), {
    margin: 0.01,
    nextCursor: 'n',
    results: [
      {
        id: 'annaUserId01',
        name: 'Anna Rossi',
        email: 'anna@example.com',
        extension: '201',
        bot: false,
        confidence: 0.75,
        matchedOn: 'phonetic',
      },
      {
        id: 'other0000001',
        name: 'Anna Bianchi',
        email: 'anna@example.com',
        extension: '201',
        bot: false,
        confidence: 0.74,
        matchedOn: 'fuzzy',
      },
    ],
  });

  r = await wx(['user', 'find', 'Anna', '--no-color'], {fetch: fakeFetch({body: answer}), output: 'text'});
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^Anna Rossi\s+annaUserId01\s+anna@example\.com\s+ext 201\s+0\.75 phonetic$/);
  assert.doesNotMatch(r.stdout, /\+390212345/, 'no phone in the text');
  assert.match(lines[2], /Ambiguous \(margin 0\.01\)/);
  assert.equal(lines[3], 'More: --cursor n');

  for (const bad of [
    ['--min-confidence', '1.5'],
    ['--size', '0'],
    ['--mode', 'fuzzy'],
    ['--kind', 'robot'],
  ]) {
    assert.equal((await wx(['user', 'find', 'x', ...bad], {fetch: fakeFetch()})).code, 64, bad.join(' '));
  }
});

test('user get takes ids, e-mails and phones, as options or recognised values', async () => {
  const fetch = fakeFetch({body: {users: [anna]}});
  const r = await wx(
    ['user', 'get', 'annaUserId01', 'anna@example.com', '+39 02 12345', '--id', 'other0000001', '--phone', '+4930'],
    {fetch},
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fetch.calls[0].body, {
    query: {ids: ['other0000001', 'annaUserId01'], emails: ['anna@example.com'], phones: ['+4930', '+390212345']},
  });
  const none = fakeFetch();
  assert.equal((await wx(['user', 'get'], {fetch: none})).code, 64);
  assert.equal(none.calls.length, 0);
  const text = await wx(['user', 'get', 'annaUserId01'], {fetch: fakeFetch({body: {users: [anna]}}), output: 'text'});
  assert.match(text.stdout, /^Anna Rossi\s+annaUserId01\s+anna@example\.com\s+ext 201\n$/);
});
