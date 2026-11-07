// The Wildix stream service (chats): https://<region>.stream.wildix.com/api/v1, region eu-1 by default.
import {UsageError} from 'wldx-core/errors';
import {request} from 'wldx-core/http';
import {streamUrl} from 'wldx-core/services';

const ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// The base address (see services.mjs for the overrides).
export const streamBase = (env = process.env) => streamUrl(env);

const valid = (v) => ID.test(v) && !v.includes('..');

// A channel id from an id, a "type:id" form or an inbox link (the message part of a link is dropped).
export function channelId(input) {
  let v = String(input).replace(/[?#].*$/s, '');
  const at = v.indexOf('/inbox/');
  if (at >= 0) v = v.slice(at + '/inbox/'.length);
  v = v.split('/')[0];
  v = v.slice(v.lastIndexOf(':') + 1);
  if (!valid(v)) throw new UsageError(`Not a channel id: ${input}`);
  return v;
}

// A message id from an id or from an inbox link to the message (the last path segment).
export function messageId(input) {
  const v = String(input)
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .split('/')
    .pop();
  if (!valid(v)) throw new UsageError(`Not a message id: ${input}`);
  return v;
}

export function streamClient({token, env = process.env, fetchImpl}) {
  const api = `${streamBase(env)}/api/v1`;
  return {
    call: (method, path, body, options = {}) =>
      request(api + path, {method, token, body, fetchImpl, service: 'the stream service', ...options}),
  };
}
