// What the PBX tells over SIP, as the user's calls, devices, presence and ringing mode: the parsers of the bodies of
// the event packages `dialog` (RFC 4235 with Wildix params), `reg` (RFC 3680) and `active-device` (Wildix), and the
// trackers that turn each full state into changes. Ported from @gorets/wildix-callcontrol 0.4.0 (the library the
// wildix-call-control skill runs), with the same rules.
import {child, children, parseXml, text} from './xml.mjs';

const PARAM = {STATE: 'X-Wildix-state', CUSTOM: 'X-Wildix-custom', TAGS: 'X-Wildix-tags', RECORD: 'X-Wildix-record'};
const SYSTEM_USER_AGENTS = ['wildixgw', 'wildix tapi'];
const RECORDING = ['off', 'personal', 'system', 'paused'];
const ACTIVE_DEVICE_TYPES = ['device', 'any_device', 'mobility'];

// The presence of the user rides on the dialog params: X-Wildix-state (online, away, dnd…) and X-Wildix-custom
// (base64 JSON with the status message and its end).
function customStatus(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return {
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      until: typeof parsed.untilTime === 'string' ? parsed.untilTime : undefined,
    };
  } catch {
    return {};
  }
}

function applyPresence(params, presence) {
  for (const p of params) {
    const {pname, pval} = p.attrs;
    if (pname === PARAM.STATE && pval) presence = {...(presence ?? {}), status: String(pval).toLowerCase()};
    if (pname === PARAM.CUSTOM && pval) presence = {...(presence ?? {}), ...customStatus(String(pval))};
  }
  return presence;
}

const recordParam = (params) => {
  const v = params.find((p) => p.attrs.pname === PARAM.RECORD)?.attrs.pval;
  return RECORDING.includes(v) ? v : undefined;
};

function recordingState(user, other) {
  if (user === 'paused' || other === 'paused') return 'paused';
  if (user === 'system' || other === 'system') return 'system';
  return user;
}

// dialog-info: the user's dialogs (calls) and the presence carried on them.
export function parseDialogInfo(xml) {
  const root = parseXml(xml);
  const dialogs = [];
  let presence = null;
  for (const d of children(root, 'dialog')) {
    presence = applyPresence(children(d, 'param'), presence);
    const targetParams = children(child(child(d, 'remote'), 'target'), 'param');
    presence = applyPresence(targetParams, presence);
    let tags;
    for (const p of targetParams) {
      if (p.attrs.pname === PARAM.TAGS && p.attrs.pval)
        tags = String(p.attrs.pval)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
    }
    const id = d.attrs['call-id'];
    if (!id) continue;
    const stateEl = child(d, 'state');
    const otherParams = children(child(child(d, 'local'), 'target'), 'param');
    const identity = child(child(d, 'local'), 'identity');
    let remoteName;
    let remoteNumber;
    if (identity) {
      remoteName = identity.attrs.display || undefined;
      const uri = text(identity);
      remoteNumber = uri ? (uri.startsWith('sip:') ? uri.slice(4).split('@')[0] : uri) : undefined;
    }
    dialogs.push({
      id,
      direction: d.attrs.direction === 'initiator' ? 'outbound' : 'inbound',
      rawState: text(stateEl),
      rawStateReason: stateEl?.attrs.reason,
      hold: text(child(d, 'note')) === 'On hold',
      remoteName,
      remoteNumber,
      tags,
      recording: recordingState(recordParam(targetParams), recordParam(otherParams)),
    });
  }
  return {dialogs, presence};
}

// reginfo: the registered devices of the user (system registrations of the PBX left out).
export function parseRegInfo(xml) {
  const root = parseXml(xml);
  const devices = [];
  for (const reg of children(root, 'registration')) {
    for (const c of children(reg, 'contact')) {
      const userAgent = c.attrs.user_agent ?? '';
      const uri = text(child(c, 'uri'));
      if (c.attrs.state !== 'active' || !uri || !userAgent) continue;
      if (SYSTEM_USER_AGENTS.some((m) => userAgent.toLowerCase().includes(m))) continue;
      devices.push({uri, userAgent});
    }
  }
  return devices;
}

// active-device: the ringing mode (a device, all devices, the mobile).
export function parseActiveDevice(xml) {
  const root = parseXml(xml);
  const type = text(child(root, 'type'));
  if (!type) return null;
  return {
    type,
    userAgent: text(child(root, 'user-agent')) || undefined,
    contactUri: text(child(root, 'contact')) || undefined,
  };
}

// A readable device name from a user agent: version numbers and UUIDs dropped.
const VERSION_LIKE = /^\d+(\.\d+)*$/;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_UUID = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function deviceName(userAgent) {
  if (!userAgent) return 'Unknown device';
  const words = userAgent
    .split(' ')
    .map((w) => w.replace(TRAILING_UUID, ''))
    .filter((w) => w && !VERSION_LIKE.test(w) && !UUID_LIKE.test(w));
  return words.length ? words.join(' ') : userAgent;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function toCall(d) {
  const state =
    d.rawState === 'confirmed' ? (d.hold ? 'held' : 'answered') : d.rawState === 'terminated' ? 'ended' : 'ringing';
  return {
    id: d.id,
    direction: d.direction,
    state,
    remoteNumber: d.remoteNumber,
    remoteName: d.remoteName,
    tags: d.tags,
    recording: d.recording,
    endReason: d.rawStateReason,
  };
}

const callChanged = (a, b) =>
  a.state !== b.state ||
  a.remoteNumber !== b.remoteNumber ||
  a.remoteName !== b.remoteName ||
  a.recording !== b.recording ||
  !same(a.tags ?? [], b.tags ?? []);

// The calls: each dialog NOTIFY is the full list; this returns what started, changed and ended since the last one.
export class CallTracker {
  calls = new Map();

  apply(dialogs) {
    const started = [];
    const updated = [];
    const ended = [];
    const seen = new Set();
    for (const d of dialogs) {
      seen.add(d.id);
      const next = toCall(d);
      const existing = this.calls.get(d.id);
      if (next.state === 'ended') {
        if (existing) {
          ended.push({...existing, state: 'ended', endReason: next.endReason});
          this.calls.delete(d.id);
        }
      } else if (!existing) {
        started.push(next);
        this.calls.set(d.id, next);
      } else if (callChanged(existing, next)) {
        updated.push(next);
        this.calls.set(d.id, next);
      }
    }
    for (const [id, call] of this.calls) {
      if (!seen.has(id)) {
        ended.push({...call, state: 'ended'});
        this.calls.delete(id);
      }
    }
    return {started, updated, ended};
  }

  list() {
    return [...this.calls.values()];
  }
}

// One value (the devices, the presence, the ringing mode) that reports whether a new one differs.
export class ValueTracker {
  value = undefined;

  apply(next, compare = same) {
    const changed = !compare(this.value, next);
    this.value = next;
    return changed;
  }
}

export function devicesEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  const sort = (l) => [...l].sort((x, y) => x.uri.localeCompare(y.uri));
  const [sa, sb] = [sort(a), sort(b)];
  return sa.every((d, i) => same(d, sb[i]));
}

export const toActiveDevice = (parsed) =>
  parsed
    ? {
        type: ACTIVE_DEVICE_TYPES.includes(parsed.type) ? parsed.type : 'unknown',
        contactUri: parsed.contactUri,
        userAgent: parsed.userAgent,
      }
    : undefined;
