// wx phone: the live calls of the logged-in user on their Wildix PBX, as the wildix-call-control skill does it
// (calls.sh, devices.sh, sip.sh). Two channels of the PBX, both found from the login itself:
//   - the Call Control REST API (https://<pbx>/api/v2/call-control/): list, place, answer, hold, transfer, DTMF,
//     hang up, the name shown, the devices and the active one. One request per action.
//   - SIP over a WebSocket (wss://<pbx>/sip/): a headless SIP user of the extension (no media; it turns every call
//     offered to it down) for the live view and what only SIP has: recording and the transfer through a conference.
// The user acts on their own calls and devices only; the admin-only `user` parameter of the API is left out.
import {jwtClaims} from 'wldx-core/auth';
import {UsageError} from 'wldx-core/errors';
import {duration, localTime, paint, table} from 'wldx-core/format';
import {pbxUrl} from 'wldx-core/services';
import {CallControl, RECORD_ACTIONS} from '../phone/control.mjs';
import {deviceName} from '../phone/events.mjs';
import {
  PbxError,
  WATCHER_USER_AGENT,
  checkCallId,
  checkContact,
  checkDigits,
  extensionOf,
  isWatcher,
  normNumber,
  pbxAction,
  pbxCall,
  sipEndpoint,
  sipPassword,
} from '../phone/pbx.mjs';

// Tests replace the WebSocket (a fake PBX) and the timings of the SIP channel here.
export const sipIo = {WebSocket: undefined, options: {}};

const DTMF_PART = 10; // the PBX takes at most 10 digits per request
const NAME_MAX = 100;

// ---- text helpers

const callColor = (c, state) => {
  const s = String(state ?? '').toLowerCase();
  if (s === 'up' || s === 'answered') return c.green(state);
  if (s.startsWith('ring')) return c.yellow(state);
  if (s === 'held') return c.cyan(state);
  if (s === 'ended') return c.dim(state);
  return String(state ?? '');
};

const party = (number, name) => [number, name].filter((v) => v !== undefined && v !== null && v !== '').join(' ');

// A call of the REST list or of the SIP view, as table cells.
function callRow(call, c) {
  if (call.sipCallId !== undefined) {
    return [
      callColor(c, call.state),
      duration(Number(call.duration)),
      party(call.callerNumber, call.callerName),
      '→',
      party(call.calleeNumber, call.calleeName),
      c.dim(call.sipCallId),
    ];
  }
  const extras = [
    call.recording && call.recording !== 'off' && `recording ${call.recording}`,
    call.tags?.length && `[${call.tags.join(', ')}]`,
    call.endReason && `(${call.endReason})`,
  ];
  return [
    callColor(c, call.state),
    call.direction === 'outbound' ? 'to' : 'from',
    party(call.remoteNumber, call.remoteName),
    extras.filter(Boolean).join(' '),
    c.dim(call.id),
  ];
}

// table() without the columns that are empty in every row.
function compactTable(rows) {
  const keep = (rows[0] ?? []).map((_, i) => rows.some((r) => r[i] !== '' && r[i] !== undefined && r[i] !== null));
  return table(rows.map((r) => r.filter((_, i) => keep[i])));
}

function callsText(calls, ctx) {
  if (!calls?.length) return 'No calls now.';
  const c = paint(ctx);
  return compactTable(calls.map((call) => callRow(call, c)));
}

function devicesText(devices, ctx) {
  if (!devices?.length) return 'No device of yours is registered now.';
  const c = paint(ctx);
  return compactTable(
    devices.map((d) => [
      [d.active && c.green('active'), d.watcher && c.dim('watcher')].filter(Boolean).join(' '),
      d.name ?? deviceName(d.userAgent),
      d.contact ?? '',
    ]),
  );
}

const actionText = (r) => (typeof r.message === 'string' ? r.message : `OK ${JSON.stringify(r.message ?? {})}`);

// ---- the SIP channel

const callView = (c) => ({
  id: c.id,
  direction: c.direction,
  state: c.state,
  remoteNumber: c.remoteNumber,
  remoteName: c.remoteName,
  tags: c.tags,
  recording: c.recording,
  endReason: c.endReason,
});
const deviceView = (d) => ({
  contact: d.uri,
  name: d.deviceName,
  userAgent: d.userAgent,
  ...(isWatcher(d.userAgent) || d.isLocalRegistration ? {watcher: true} : {}),
});

// Connects as a SIP user of the extension and waits for the first call state. setup(cc, extension) adds the
// listeners before the connection. The registration asks for 120 s, so a watcher killed instead of stopped leaves
// it on the PBX for at most two minutes.
async function openSip(ctx, setup) {
  const extension = extensionOf(ctx.token);
  const {wsUrl, domain} = sipEndpoint(ctx.token, ctx.env);
  const password = await sipPassword(ctx, extension);
  const cc = new CallControl({
    domain,
    wsUrl,
    extension,
    password,
    userAgent: WATCHER_USER_AGENT,
    expires: 120,
    WebSocketImpl: sipIo.WebSocket ?? globalThis.WebSocket,
    ...sipIo.options,
  });
  cc.on('error', () => {}); // a one-shot command reports only its own failure
  setup?.(cc, extension);
  try {
    await cc.connect();
    await cc.waitUntilReady(15_000);
  } catch (e) {
    await cc.disconnect();
    throw new PbxError(`could not connect to the PBX as extension ${extension}: ${e.message}`);
  }
  return cc;
}

// Connect, check that the call is one of the user's current calls, run the command, disconnect.
async function sipCommand(ctx, command, callId, action) {
  const cc = await openSip(ctx);
  try {
    if (!cc.getActiveCalls().some((call) => call.id === callId))
      throw new PbxError(
        `no current call of this user has the id ${callId} (see: wx phone list --sip or wx phone list)`,
      );
    try {
      await action(cc);
    } catch (e) {
      throw new PbxError(`${command} failed: ${e.message}`);
    }
  } finally {
    await cc.disconnect();
  }
  return {ok: true, command, callId};
}

function waitUntil(signal, seconds) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, {once: true});
    if (seconds > 0) timer = setTimeout(done, seconds * 1000);
  });
}

// ---- event text for watch

function eventText(e, ctx) {
  const c = paint(ctx);
  const time = localTime(ctx.clock(), {seconds: true}).slice(11);
  const d = e.data ?? {};
  let line;
  switch (e.event) {
    case 'READY':
    case 'RECONNECTED': {
      const parts = [`extension ${d.extension}`, `${d.calls?.length ?? 0} call${d.calls?.length === 1 ? '' : 's'}`];
      if (d.presence?.status) parts.push(`presence ${d.presence.status}`);
      if (d.devices) parts.push(`${d.devices.filter((x) => !x.watcher).length} device(s)`);
      if (d.activeDevice) parts.push(`ringing ${activeDeviceText(d.activeDevice)}`);
      line = [
        c.bold(e.event === 'READY' ? 'ready' : 'reconnected'),
        parts.join(', '),
        ...(d.calls ?? []).map((call) => `\n  ${compactTable([callRow(call, c)])[0]}`),
      ].join(' ');
      break;
    }
    case 'CALL_START':
    case 'CALL_UPDATE':
    case 'CALL_END':
      line = `${{CALL_START: c.bold('call'), CALL_UPDATE: 'call', CALL_END: c.dim('call')}[e.event]} ${compactTable([callRow(d, c)])[0]}`;
      break;
    case 'DEVICES':
      line = `devices: ${(Array.isArray(d) ? d : []).map((x) => `${x.name}${x.watcher ? ' (watcher)' : ''}`).join(', ') || 'none'}`;
      break;
    case 'PRESENCE':
      line = `presence: ${[d.status, d.message && `"${d.message}"`, d.until && `until ${localTime(d.until)}`].filter(Boolean).join(' ')}`;
      break;
    case 'ACTIVE_DEVICE':
      line = `ringing: ${activeDeviceText(d)}`;
      break;
    case 'RECONNECTING':
      line = c.yellow(`reconnecting (attempt ${d.attempt})`);
      break;
    case 'ERROR':
      line = c.red(`error: ${d.message}`);
      break;
    default:
      line = `${e.event} ${JSON.stringify(d)}`;
  }
  return `${c.dim(time)} ${line}`;
}

function activeDeviceText(a) {
  if (a.type === 'any_device') return 'all devices';
  if (a.type === 'mobility') return 'the mobile';
  if (a.type === 'device') return [a.userAgent, a.contactUri].filter(Boolean).join(' ') || 'a device';
  return a.type;
}

// ---- commands

const callIdArg = {args: [1, 1]};
const simple = (path, summary) => ({
  summary,
  usage: `wx phone ${path.slice(1, -1)} <callId>`,
  options: {},
  ...callIdArg,
  async run(ctx) {
    return pbxAction(ctx, 'POST', path, {sipCallId: checkCallId(ctx.positionals[0])});
  },
  text: actionText,
});

const phone = {
  summary: 'live calls on your PBX: place, answer, hold, transfer, DTMF, record; your devices; watch live',
  auth: true,
  commands: {
    me: {
      summary: 'who the calls are made as: extension, name, e-mail, role, PBX (from the login, no request)',
      usage: 'wx phone me',
      options: {},
      args: [0, 0],
      async run(ctx) {
        const claims = jwtClaims(ctx.token);
        const pbx = pbxUrl(ctx.token, ctx.env);
        return {
          extension: claims['custom:pbx_user_extension'] ?? null,
          name: claims.name ?? null,
          email: claims.email ?? null,
          role: claims['custom:pbx_user_role'] ?? null,
          license: claims['custom:pbx_license'] ?? null,
          pbx,
        };
      },
      text(r) {
        const rows = [
          ['Extension', r.extension],
          ['Name', r.name],
          ['E-mail', r.email],
          ['Role', r.role],
          ['License', r.license],
          ['PBX', r.pbx],
        ];
        return table(rows.filter(([, v]) => v !== null && v !== undefined && v !== ''));
      },
    },
    list: {
      summary: 'your current calls: sipCallId, numbers, names, state, seconds (--sip: as SIP sees them)',
      usage: 'wx phone list [--sip]',
      details:
        'REST (default): {calls: [{sipCallId, callerNumber, callerName, calleeNumber, calleeName, state, duration}], total}; state is the PBX channel state (Up also when held).\n' +
        '--sip: {calls: [{id, direction, state ringing|answered|held, remoteNumber, remoteName, tags, recording}]} over a short SIP registration (it shows hold and the number dialled).',
      options: {
        sip: {type: 'boolean', description: 'the calls as SIP sees them (held, direction, recording, number dialled)'},
      },
      args: [0, 0],
      async run(ctx) {
        if (!ctx.values.sip) return pbxCall(ctx, 'GET', '/list-calls/');
        const cc = await openSip(ctx);
        const calls = cc.getActiveCalls().map(callView);
        await cc.disconnect();
        return {calls};
      },
      text: (r, ctx) => callsText(r.calls, ctx),
    },
    call: {
      summary:
        'place a call from your device: it rings first and dials when you pick up, or starts at once on --device',
      usage: 'wx phone call <number> [--mobile | --any | --device CONTACT]',
      details:
        'Click-to-call. A number is an extension, a phone number (spaces, dashes, dots and brackets are dropped) or a code like *76.\n' +
        'Without an option the PBX rings the active device (else the first device online, never the SIP watcher) and dials\n' +
        'the number when you pick up. With --device and your active device, the call starts on it at once, without\n' +
        'ringing you first.',
      options: {
        mobile: {type: 'boolean', description: 'ring your mobile number (from the PBX settings) first'},
        any: {type: 'boolean', description: 'ring all your devices first'},
        device: {
          type: 'string',
          placeholder: 'CONTACT',
          description: 'place the call on this device (contact from wx phone devices); on the active one at once',
        },
      },
      args: [1, 1],
      async run(ctx) {
        const {values} = ctx;
        const destination = normNumber(ctx.positionals[0]);
        if ([values.mobile, values.any, values.device !== undefined].filter(Boolean).length > 1)
          throw new UsageError('give one of --mobile, --any, --device', ctx.usage());
        const body = {destination};
        if (values.mobile) body.callType = 'mobility';
        else if (values.any) body.callType = 'any';
        else if (values.device !== undefined)
          Object.assign(body, {callType: 'device', deviceContact: checkContact(values.device)});
        else {
          // With no active device the PBX takes the first registered one, which may be a SIP watcher (it turns every
          // call down). Pick the device here: the active one, else the first real one.
          const list = await pbxCall(ctx, 'GET', '/list-devices/');
          const real = (list?.devices ?? []).filter((d) => !isWatcher(d.userAgent));
          const device = [...real.filter((d) => d.active), ...real][0]?.contact;
          if (!device)
            throw new PbxError(
              'no device of this user is online to place the call from: open x-bees or a Wildix phone, or call through the mobile (--mobile)',
            );
          body.deviceContact = device;
        }
        return pbxAction(ctx, 'POST', '/make-call/', body);
      },
      text(r, ctx) {
        if (ctx.values.device !== undefined)
          return [
            actionText(r),
            'The call is placed on the device you named (on your active device it starts at once).',
          ];
        const where = ctx.values.mobile ? 'your mobile' : ctx.values.any ? 'your devices' : 'your device';
        return [actionText(r), `The PBX rings ${where} first; it dials the number when you pick up.`];
      },
    },
    answer: {
      summary: 'answer a ringing call (on a device that can answer remotely: a Wildix phone, x-bees)',
      usage: 'wx phone answer <callId> [--device CONTACT]',
      options: {
        device: {
          type: 'string',
          placeholder: 'CONTACT',
          description: 'answer on this device (its contact from wx phone devices)',
        },
      },
      ...callIdArg,
      async run(ctx) {
        const body = {sipCallId: checkCallId(ctx.positionals[0])};
        if (ctx.values.device !== undefined) body.deviceContact = checkContact(ctx.values.device);
        return pbxAction(ctx, 'POST', '/answer/', body);
      },
      text: actionText,
    },
    hold: simple('/hold/', 'put a call on hold'),
    unhold: simple('/unhold/', 'resume a held call'),
    hangup: simple('/hangup/', 'hang up a call'),
    transfer: {
      summary: 'blind transfer: the call goes to <number> and leaves you',
      usage: 'wx phone transfer <callId> <number>',
      options: {},
      args: [2, 2],
      async run(ctx) {
        const [id, number] = ctx.positionals;
        return pbxAction(ctx, 'POST', '/blind-transfer/', {
          sipCallId: checkCallId(id),
          destination: normNumber(number),
        });
      },
      text: actionText,
    },
    'attended-transfer': {
      summary: 'join a call to another current call of yours (consultation done), then leave both',
      usage: 'wx phone attended-transfer <callId> <otherCallId>',
      options: {},
      args: [2, 2],
      async run(ctx) {
        const [a, b] = ctx.positionals.map(checkCallId);
        if (a === b) throw new UsageError('a call cannot be transferred to itself');
        return pbxAction(ctx, 'POST', '/attendant-transfer/', {sipCallId: a, destination: b});
      },
      text: actionText,
    },
    dtmf: {
      summary: 'send DTMF tones: 0-9, * and # (longer sequences in parts of 10)',
      usage: 'wx phone dtmf <callId> <digits>',
      options: {},
      args: [2, 2],
      async run(ctx) {
        const id = checkCallId(ctx.positionals[0]);
        const digits = checkDigits(ctx.positionals[1]);
        let out;
        for (let i = 0; i < digits.length; i += DTMF_PART)
          out = await pbxAction(ctx, 'POST', '/dtmf/', {sipCallId: id, digits: digits.slice(i, i + DTMF_PART)});
        return out;
      },
      text: actionText,
    },
    'show-as': {
      summary: 'change the name and/or number your own phone shows for the other party (they see nothing)',
      usage: 'wx phone show-as <callId> [--name NAME] [--number NUMBER]',
      options: {
        name: {type: 'string', placeholder: 'NAME', description: `the name to show (1 to ${NAME_MAX} characters)`},
        number: {type: 'string', placeholder: 'NUMBER', description: 'the number to show'},
      },
      ...callIdArg,
      async run(ctx) {
        const {values} = ctx;
        const body = {sipCallId: checkCallId(ctx.positionals[0])};
        if (values.name === undefined && values.number === undefined)
          throw new UsageError('give --name, --number or both', ctx.usage());
        if (values.name !== undefined) {
          if (!values.name || values.name.length > NAME_MAX)
            throw new UsageError(`--name takes 1 to ${NAME_MAX} characters`);
          body.name = values.name;
        }
        if (values.number !== undefined) body.number = normNumber(values.number);
        return pbxAction(ctx, 'POST', '/update-contact-info/', body);
      },
      text: actionText,
    },
    devices: {
      summary: 'your registered devices: contact, user agent, which one is active (the SIP watcher marked)',
      usage: 'wx phone devices',
      options: {},
      args: [0, 0],
      async run(ctx) {
        const r = await pbxCall(ctx, 'GET', '/list-devices/');
        if (Array.isArray(r?.devices))
          r.devices = r.devices.map((d) => (isWatcher(d.userAgent) ? {...d, watcher: true} : d));
        return r;
      },
      text: (r, ctx) => devicesText(r.devices, ctx),
    },
    use: {
      summary: 'choose what rings and places your calls: a registered device, the mobile, or all devices',
      usage: 'wx phone use <contact> | --mobile | --any',
      options: {
        mobile: {type: 'boolean', description: 'mobility mode: calls go through your mobile number'},
        any: {type: 'boolean', description: 'ring all your devices'},
      },
      args: [0, 1],
      async run(ctx) {
        const {values, positionals} = ctx;
        if ([values.mobile, values.any, positionals.length > 0].filter(Boolean).length !== 1)
          throw new UsageError('give one device contact, --mobile or --any', ctx.usage());
        let body;
        if (values.mobile) body = {deviceType: 'mobility'};
        else if (values.any) body = {deviceType: 'any'};
        else {
          const contact = checkContact(positionals[0]);
          // The PBX wants the device's user agent too: take it from the registration of that contact.
          const list = await pbxCall(ctx, 'GET', '/list-devices/');
          const ua = (list?.devices ?? []).find((d) => d.contact === contact)?.userAgent;
          if (!ua)
            throw new PbxError(`no registered device of this user has the contact ${contact} (see: wx phone devices)`);
          if (isWatcher(ua)) throw new PbxError('this is a SIP watcher, not a phone: it cannot carry a call');
          body = {deviceType: 'device', contact, userAgent: ua};
        }
        return pbxAction(ctx, 'PUT', '/set-active-device/', body);
      },
      text: actionText,
    },
    watch: {
      summary: 'follow your calls, devices, presence and ringing mode live, one line per event, until stopped',
      usage: 'wx phone watch [--calls-only] [--for SECONDS]',
      details:
        'Events ({"event": NAME, "data": …} per line with --output json): READY (extension, calls, devices, presence, activeDevice), ' +
        'CALL_START, CALL_UPDATE, CALL_END (id, direction, state ringing|answered|held|ended, remoteNumber, remoteName, tags, recording, endReason), ' +
        'DEVICES, PRESENCE (status, message, until), ACTIVE_DEVICE (type device|any_device|mobility, contactUri, userAgent), RECONNECTING, RECONNECTED, ERROR.\n' +
        'It is a registered SIP user of your extension while it runs (it turns every call offered to it down); stop it with Ctrl-C.',
      options: {
        'calls-only': {type: 'boolean', description: 'only the calls (no devices, presence, ringing mode)'},
        for: {type: 'string', placeholder: 'SECONDS', description: 'stop after this many seconds (0: until stopped)'},
      },
      args: [0, 0],
      async run(ctx) {
        const {values} = ctx;
        if (values.for !== undefined && !/^\d{1,7}$/.test(values.for))
          throw new UsageError(`--for takes whole seconds: ${values.for}`);
        const seconds = Number(values.for ?? 0);
        const all = !values['calls-only'];
        const emit = (event, data) => ctx.emit({event, data: data ?? {}});
        let readyOnce = false;
        const cc = await openSip(ctx, (cc, extension) => {
          cc.on('callStart', (c) => emit('CALL_START', callView(c)));
          cc.on('callUpdate', (c) => emit('CALL_UPDATE', callView(c)));
          cc.on('callEnd', (c) => emit('CALL_END', callView(c)));
          cc.on('reconnecting', (r) => emit('RECONNECTING', r));
          cc.on('error', (e) => emit('ERROR', {message: e?.message ?? String(e)}));
          cc.on('ready', () => {
            emit(readyOnce ? 'RECONNECTED' : 'READY', {
              extension,
              calls: cc.getActiveCalls().map(callView),
              ...(all
                ? {
                    devices: cc.getDevices().map(deviceView),
                    presence: cc.getPresence(),
                    activeDevice: cc.getActiveDevice(),
                  }
                : {}),
            });
            readyOnce = true;
          });
          if (all) {
            cc.on('devicesChanged', (d) => readyOnce && emit('DEVICES', d.map(deviceView)));
            cc.on('presenceChanged', (p) => readyOnce && emit('PRESENCE', p));
            cc.on('activeDeviceChanged', (a) => readyOnce && emit('ACTIVE_DEVICE', a));
          }
        });
        await waitUntil(ctx.signal, seconds);
        await cc.disconnect();
      },
      textEvent: eventText,
    },
    record: {
      summary: 'start, stop, pause or resume the recording of a call (SIP; needs your right to record)',
      usage: `wx phone record <callId> ${RECORD_ACTIONS.join('|')}`,
      options: {},
      args: [2, 2],
      async run(ctx) {
        const id = checkCallId(ctx.positionals[0]);
        const action = ctx.positionals[1];
        if (!RECORD_ACTIONS.includes(action))
          throw new UsageError(`record takes ${RECORD_ACTIONS.join(', ')}: ${action}`, ctx.usage());
        return sipCommand(ctx, 'record', id, (cc) => cc.record(id, action));
      },
      text: (r, ctx) => `record ${ctx.positionals[1]}: the PBX took it (call ${r.callId})`,
    },
    'conference-transfer': {
      summary: 'join the call and <number> in a conference; when you hang up the other two stay (SIP)',
      usage: 'wx phone conference-transfer <callId> <number>',
      options: {},
      args: [2, 2],
      async run(ctx) {
        const id = checkCallId(ctx.positionals[0]);
        const destination = normNumber(ctx.positionals[1]);
        return sipCommand(ctx, 'conference-transfer', id, (cc) => cc.conferenceTransfer(id, destination));
      },
      text: (r) => `conference transfer: the PBX took it (call ${r.callId})`,
    },
  },
};

// Named exports only: test/dev.mjs would take a default export with `commands` for a list of single commands.
export {phone};
export const groups = {phone};
