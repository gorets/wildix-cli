// The connection to the live stream of Wildix Data Analytics (WDA), wss://wda-ws.wildix.com (src/services.mjs).
//
// Protocol: {"action":"authorize","token"} -> {"event":"authorized"}; then
// {"action":"subscribe","topic","version","state","filter"} -> the current state as {"event":"broadcast","topic",
// "data":[…]} frames, then {"event":"subscribed","topic"}; afterwards one broadcast per change.
// An error is {"event":"error","message","code","source"}: `source` echoes the request, which for authorize holds
// the token, so it is never printed (and the token is scrubbed from every message shown).
import {AuthError} from 'wldx-core/errors';

export const AUTH_TIMEOUT_MS = 20_000;
export const SNAPSHOT_TIMEOUT_MS = 30_000;

export const subscription = (topic, extra = {}) => ({action: 'subscribe', topic, version: '2', ...extra});

// The message of a refused subscription, as the skill words it.
export function explain(topic, d, license) {
  if (d.code === 403 && (topic === 'services' || topic === 'conversations')) {
    return `the live service allows ${topic === 'services' ? 'call queues' : 'the conversations of the company'} only to users with a Premium license (this login: ${license ?? 'unknown'})`;
  }
  if (d.code === 401) return 'the live service lost the login: run the command again';
  return `the live service refused the ${topic} subscription (${d.code ?? '?'}): ${d.message}`;
}

// Opens a connection and logs in. Resolves with the connection:
//   listeners   a Set of functions called with every frame after the login, and {event: '_closed', code} at the end
//   send(obj)   sends one request
//   snapshot(topic, extra)   subscribes with the state and resolves with every item broadcast until "subscribed"
//   close()     closes it (a _closed frame follows)
// Rejects with AuthError when the service refuses the token, with Error when it cannot connect.
export function connect({
  url,
  token,
  WebSocket = globalThis.WebSocket,
  license,
  timeoutMs = AUTH_TIMEOUT_MS,
  snapshotTimeoutMs = SNAPSHOT_TIMEOUT_MS,
}) {
  const scrub = (s) =>
    token
      ? String(s ?? '')
          .split(token)
          .join('[token]')
      : String(s ?? '');
  return new Promise((resolve, reject) => {
    const listeners = new Set();
    let ws;
    try {
      ws = new WebSocket(`${url}/`);
    } catch (e) {
      reject(new Error(`could not connect to the live service: ${scrub(e.message)}`));
      return;
    }
    let done = false;
    const send = (obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        // closed meanwhile: the _closed frame tells the listeners
      }
    };
    const conn = {
      listeners,
      send,
      close() {
        try {
          ws.close(1000);
        } catch {
          // already closed
        }
      },
      snapshot(topic, extra = {}) {
        return new Promise((ok, fail) => {
          const items = [];
          const timer = setTimeout(
            () => finish(new Error(`no answer for ${topic} in ${Math.round(snapshotTimeoutMs / 1000)} seconds`)),
            snapshotTimeoutMs,
          );
          const listener = (d) => {
            if (d.event === 'broadcast' && d.topic === topic)
              items.push(...(Array.isArray(d.data) ? d.data : [d.data]));
            else if (d.event === 'subscribed' && d.topic === topic) finish();
            else if (d.event === 'error')
              finish(Object.assign(new Error(scrub(explain(topic, d, license))), {code: d.code}));
            else if (d.event === '_closed')
              finish(new Error(`the live service closed the connection (code ${d.code})`));
          };
          function finish(err) {
            clearTimeout(timer);
            listeners.delete(listener);
            if (err) fail(err);
            else ok(items);
          }
          listeners.add(listener);
          send(subscription(topic, {state: true, ...extra}));
        });
      },
      scrub,
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.close();
      reject(new Error(`the live service did not answer in ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    ws.onopen = () => send({action: 'authorize', token});
    ws.onmessage = (m) => {
      let d;
      try {
        d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'));
      } catch {
        return;
      }
      if (!d || typeof d !== 'object') return;
      if (!done) {
        if (d.event === 'authorized') {
          done = true;
          clearTimeout(timer);
          resolve(conn);
        } else if (d.event === 'error') {
          done = true;
          clearTimeout(timer);
          conn.close();
          reject(new AuthError(`the live service refused the login: ${scrub(d.message)}`));
        }
        return;
      }
      for (const l of [...listeners]) l(d);
    };
    ws.onclose = (ev) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`the live service closed the connection (code ${ev?.code})`));
      }
      for (const l of [...listeners]) l({event: '_closed', code: ev?.code});
    };
    ws.onerror = () => {};
  });
}
