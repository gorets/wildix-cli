// wx-admin device: the devices (phones, W-AIR bases, Wizyconf…) of the PBX, over the PBX REST API.
// Operations (OpenAPI tags Devices, Device), scope devices (the spec names none for PUT, DELETE, connect and
// disconnect: devices:*):
//   GET /Devices/                        the devices (count, start)
//   POST /Devices/                       add devices by MAC {macs}
//   PUT /Devices/{mac}/                  change {description, user, multipleUsers, settings: {dns, ntp, syslogServer…}}
//   DELETE /Devices/{mac}/               delete
//   POST /Devices/scan/                  look for devices in a range of addresses {range}
//   GET /Devices/verify/                 check one device: ?address=&port= (the spec says a body with range and port;
//                                        the PBX reads the query, and "address", not "range")
//   POST|DELETE /Devices/{mac}/connect/  open or close the remote web access to a device
//   POST /Device/ResetToken/             reset the token of a Wizyconf device {pin}
// A MAC is given with or without separators (9C:75:14:02:8F:24, 9c7514028f24); the PBX takes 12 lower-case hex digits.
// The token of a device (its password for provisioning) is never shown as text, and in JSON only with --show-secrets.
import {readJsonInput as readJsonFile} from 'wldx-core/files';
import {UsageError} from 'wldx-core/errors';
import {oneLine, paint, table} from 'wldx-core/format';
import {apiPath, query} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';

const SCOPE = {scope: 'devices'};
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$|^[0-9a-fA-F:]+$/;
const EXTENSION = /^[0-9A-Za-z*#+_-]{1,32}$/;

// "9C:75:14:02:8F:24" → "9c7514028f24".
export function normalizeMac(input) {
  const mac = String(input ?? '')
    .toLowerCase()
    .replace(/[:.-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(mac)) throw new UsageError(`Not a MAC address: ${input}`);
  return mac;
}

const showSecrets = {
  'show-secrets': {type: 'boolean', description: 'with --output json: keep the device tokens (never shown as text)'},
};

// A device without its token, unless JSON with --show-secrets; tokenSet says whether it has one.
function hideToken(d, ctx) {
  if (!d || typeof d !== 'object' || (ctx.values['show-secrets'] && ctx.output === 'json')) return d;
  const {token, ...rest} = d;
  return 'token' in d ? {...rest, tokenSet: Boolean(token)} : rest;
}

async function readJsonInput(ctx, from) {
  const data = await readJsonFile(ctx, from); // no credentials, nothing hidden in the home folder
  return data;
}

const count = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} is a whole number: ${v}`);
  return n;
};

const checkHost = (v, name) => {
  if (v !== '' && !HOST.test(v)) throw new UsageError(`--${name} is a host name or an IP address: ${v}`);
  return v;
};

const users = (d) =>
  [...new Set([d.user, ...(Array.isArray(d.multipleUsers) ? d.multipleUsers : [])].filter(Boolean))].join(',');

const deviceRow = (d, c) => [
  d.mac ?? '',
  d.model ?? '',
  users(d) || c.dim('no user'),
  d.isOnline ? c.green('online') : c.dim('offline'),
  d.address ?? '',
  d.firmware ?? '',
  oneLine(d.description ?? '', 40),
];

export const groups = {
  device: {
    summary: 'devices of the PBX: list, add, change, delete, scan the network, remote access, Wizyconf token',
    commands: {
      list: {
        summary: 'the devices of the PBX: MAC, model, users, online, address, firmware',
        usage: 'wx-admin device list [--count N] [--start N] [--show-secrets]',
        options: {
          count: {type: 'string', placeholder: 'N', description: 'at most this many devices'},
          start: {type: 'string', placeholder: 'N', description: 'skip this many first'},
          ...showSecrets,
        },
        args: [0, 0],
        async run(ctx) {
          const q = query({count: count(ctx.values.count, 'count'), start: count(ctx.values.start, 'start')});
          const r = await (await pbxClient(ctx)).call('GET', `/Devices/${q}`, undefined, SCOPE);
          return {...r, records: (r?.records ?? []).map((d) => hideToken(d, ctx))};
        },
        text: (r, ctx) => (r.records.length ? table(r.records.map((d) => deviceRow(d, paint(ctx)))) : 'No devices'),
      },
      add: {
        summary: 'add devices by MAC address (they get their configuration from the PBX)',
        usage: 'wx-admin device add <mac>...',
        options: {},
        args: [1, 100],
        async run(ctx) {
          const macs = ctx.positionals.map(normalizeMac);
          return (await pbxClient(ctx)).call('POST', '/Devices/', {macs}, SCOPE);
        },
        text: (r) => {
          const recs = r?.records ?? [];
          if (!recs.length) return 'No devices added';
          return ['Added:', ...table(recs.map((x) => [`  ${x.mac}`, x.value?.vendor ?? '', x.value?.model ?? '']))];
        },
      },
      update: {
        summary: 'change a device: description, user(s), DNS, NTP, syslog, or anything from a JSON file',
        usage:
          'wx-admin device update <mac> [--description TEXT] [--user EXT] [--users EXT,EXT] [--dns PRIMARY[,SECONDARY]] [--ntp HOST] [--timezone TZ] [--syslog HOST] [--from FILE|-]',
        details: [
          'Only what is given is sent. --from takes the fields of the API as JSON, e.g.',
          '{"settings": {"voiceVLAN": {"voice": "on", "data": 10}, "useDst": true}}; the options win over it.',
        ].join('\n'),
        options: {
          description: {type: 'string', placeholder: 'TEXT', description: 'the description of the device'},
          user: {
            type: 'string',
            placeholder: 'EXT',
            description: 'the extension of the user of the device (empty: none)',
          },
          users: {
            type: 'string',
            placeholder: 'EXT,EXT',
            description: 'the extensions of the users of a device with several (W-AIR)',
          },
          dns: {type: 'string', placeholder: 'PRIMARY[,SECONDARY]', description: 'the DNS servers of the device'},
          ntp: {type: 'string', placeholder: 'HOST', description: 'the time server of the device'},
          timezone: {type: 'string', placeholder: 'TZ', description: 'the time zone of the device'},
          syslog: {type: 'string', placeholder: 'HOST', description: 'the log server of the device'},
          from: {type: 'string', placeholder: 'FILE', description: 'fields as JSON (a file, or - for stdin)'},
        },
        args: [1, 1],
        async run(ctx) {
          const v = ctx.values;
          const mac = normalizeMac(ctx.positionals[0]);
          const body = v.from ? await readJsonInput(ctx, v.from) : {};
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UsageError('--from is a JSON object');
          delete body.token; // a token reset is device reset-token, not a field to send by accident
          const settings = {...(body.settings ?? {})};
          if (v.description !== undefined) body.description = v.description;
          if (v.user !== undefined) {
            if (v.user && !EXTENSION.test(v.user)) throw new UsageError(`Not an extension: ${v.user}`);
            body.user = v.user;
          }
          if (v.users !== undefined) {
            const list = v.users
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            for (const e of list) if (!EXTENSION.test(e)) throw new UsageError(`Not an extension: ${e}`);
            body.multipleUsers = list;
          }
          if (v.dns !== undefined) {
            const [primary, secondary] = v.dns.split(',').map((s) => checkHost(s.trim(), 'dns'));
            settings.dns = {...(settings.dns ?? {}), primary, ...(secondary !== undefined ? {secondary} : {})};
          }
          if (v.ntp !== undefined || v.timezone !== undefined) {
            settings.ntp = {
              ...(settings.ntp ?? {}),
              ...(v.ntp !== undefined ? {server: checkHost(v.ntp, 'ntp')} : {}),
              ...(v.timezone !== undefined ? {timezone: v.timezone} : {}),
            };
          }
          if (v.syslog !== undefined) settings.syslogServer = checkHost(v.syslog, 'syslog');
          if (Object.keys(settings).length) body.settings = settings;
          else delete body.settings;
          if (!Object.keys(body).length) throw new UsageError('Nothing to change', ctx.usage());
          const result = await (await pbxClient(ctx)).call('PUT', apiPath`/Devices/${mac}/`, body, SCOPE);
          return {mac, changed: body, result};
        },
        text: (r) => `Updated the device ${r.mac}: ${Object.keys(r.changed).join(', ')}`,
      },
      delete: {
        summary: 'delete a device from the PBX (needs --yes: it stops working with the PBX)',
        usage: 'wx-admin device delete <mac> --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete it'}},
        args: [1, 1],
        async run(ctx) {
          const mac = normalizeMac(ctx.positionals[0]);
          if (!ctx.values.yes)
            throw new UsageError('A deleted device stops working with the PBX: confirm with --yes', ctx.usage());
          const result = await (await pbxClient(ctx)).call('DELETE', apiPath`/Devices/${mac}/`, undefined, SCOPE);
          return {deleted: mac, result};
        },
        text: (r) => `Deleted the device ${r.deleted}`,
      },
      scan: {
        summary: 'look for devices in a range of addresses of the network of the PBX',
        usage: 'wx-admin device scan <range>',
        details:
          'A range as WMS takes it: 192.168.1.1-254, or one address. Then: wx-admin device verify <address> --port N.',
        options: {},
        args: [1, 1],
        async run(ctx) {
          const range = ctx.positionals[0];
          if (!/^[0-9a-fA-F.:/-]{3,64}$/.test(range)) throw new UsageError(`Not a range of addresses: ${range}`);
          return (await pbxClient(ctx)).call('POST', '/Devices/scan/', {range}, SCOPE);
        },
        text: (r) =>
          r?.records?.length ? r.records.map((d) => `${d.address}${d.port ? `:${d.port}` : ''}`) : 'No devices found',
      },
      verify: {
        summary: 'check a device at an address: its MAC, model, and whether the PBX may provision it',
        usage: 'wx-admin device verify <address> [--port N]',
        options: {port: {type: 'string', placeholder: 'N', description: 'the port of its web interface (default 80)'}},
        args: [1, 1],
        async run(ctx) {
          const address = checkHost(ctx.positionals[0], 'address');
          const port = Number(ctx.values.port ?? 80);
          if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new UsageError(`--port is a port (1-65535): ${ctx.values.port}`);
          return (await pbxClient(ctx)).call('GET', `/Devices/verify/${query({address, port})}`, undefined, SCOPE);
        },
        text: (r) =>
          `${r.address}:${r.port}  ${r.mac || 'no MAC'}  ${r.model || 'unknown model'}  ${r.allow ? 'can be provisioned' : 'cannot be provisioned'}`,
      },
      connect: {
        summary: 'open the remote access to the web interface of a device, through the PBX',
        usage: 'wx-admin device connect <mac>',
        options: {},
        args: [1, 1],
        async run(ctx) {
          const mac = normalizeMac(ctx.positionals[0]);
          return {
            mac,
            ...((await (await pbxClient(ctx)).call('POST', apiPath`/Devices/${mac}/connect/`, undefined, SCOPE)) ?? {}),
          };
        },
        text: (r) =>
          `Connected to ${r.mac}${r.host ? ` (${r.host}${r.port ? `:${r.port}` : ''}${r.ssl ? ', TLS' : ''})` : ''}${r.opt ? `: ${r.opt}` : ''} — close it with wx-admin device disconnect ${r.mac} --yes`,
      },
      disconnect: {
        summary: 'close the remote access to a device (needs --yes: whoever uses it loses it)',
        usage: 'wx-admin device disconnect <mac> --yes',
        options: {yes: {type: 'boolean', description: 'yes, close it'}},
        args: [1, 1],
        async run(ctx) {
          const mac = normalizeMac(ctx.positionals[0]);
          if (!ctx.values.yes)
            throw new UsageError('Closing the remote access cuts whoever uses it: confirm with --yes', ctx.usage());
          const result = await (await pbxClient(ctx)).call(
            'DELETE',
            apiPath`/Devices/${mac}/connect/`,
            undefined,
            SCOPE,
          );
          return {disconnected: mac, result};
        },
        text: (r) => `Closed the remote access to ${r.disconnected}`,
      },
      'reset-token': {
        summary: 'reset the token of a Wizyconf device, by the PIN it shows, to provision it again (needs --yes)',
        usage: 'wx-admin device reset-token <pin> --yes',
        options: {yes: {type: 'boolean', description: 'yes, reset it'}},
        args: [1, 1],
        async run(ctx) {
          const pin = ctx.positionals[0];
          if (!/^\d{4,12}$/.test(pin)) throw new UsageError('The PIN is the digits the Wizyconf device shows');
          if (!ctx.values.yes)
            throw new UsageError(
              'The device must be provisioned again after its token is reset: confirm with --yes',
              ctx.usage(),
            );
          const result = await (await pbxClient(ctx)).call('POST', '/Device/ResetToken/', {pin}, SCOPE);
          return {reset: true, result};
        },
        text: () => 'The token of the device was reset: provision it again',
      },
    },
  },
};
