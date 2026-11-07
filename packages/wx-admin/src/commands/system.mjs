// wx-admin system: the PBX itself — version and license, PBX-wide settings (features, SMTP, NTP, HTTP proxy, trusted
// IPs), open ports, upgrades and reboot, over the PBX REST API.
// Operations (OpenAPI tags PBX, License, SMTP, NTP, HTTP Proxy, TrustedIP, Upgrade, System):
//   GET /PBX/version/, GET /PBX/ping/, GET /PBX/Ports/Status/        scope info (ping: no scope in the spec, guessed)
//   GET /PBX/settings/license/, GET|PUT /PBX/settings/                scope pbx
//   GET|PUT /PBX/settings/ntp/, GET|PUT /PBX/settings/httpProxy/      scope pbx
//   GET|PUT /PBX/settings/smtp/, POST /PBX/settings/smtp/test/,
//   GET /PBX/settings/smtp/test/status/{testId}/                      scope smtp
//   GET|PUT /PBX/settings/trusted-ips/                                scope security (guessed; the spec says /TrustedIP/,
//                                                                     which answers 404: the path of its curl sample works)
//   GET|POST /PBX/Upgrade/, GET|POST|… /PBX/Upgrade/Check/, GET /PBX/Upgrade/Settings/   scope pbx
//   PUT /PBX/System/Reboot/                                           scope pbxpower
// Passwords in the answers (SMTP, HTTP proxy) are never printed as text, and in JSON only with --show-secrets.
import {UsageError} from 'wldx-core/errors';
import {localTime, oneLine, paint, table} from 'wldx-core/format';
import {apiPath} from 'wldx-core/http';
import {pbxClient} from '../pbx.mjs';
import {readSecret} from 'wldx-core/secret';

// The features PUT /PBX/settings/ takes (one per request).
export const FEATURES = [
  'callControl',
  'cloudAnalytics',
  'mfa',
  'allowCollaboration6',
  'keepCallDialogAfterCall',
  'sms',
  'zabbixAgent',
  'xcaracal',
];
// msmtp's "auth" values; the PBX answers "off" when there is none (the spec says false/true).
const SMTP_AUTH = ['off', 'on', 'plain', 'login', 'cram-md5', 'digest-md5', 'gssapi', 'ntlm'];
const SMTP_TIMEOUTS = ['2', '5', '10', '15', '20', '60'];
const ON_OFF = ['on', 'off'];
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$|^\[?[0-9a-fA-F:]+\]?$/;
const IP_OR_NET = /^[0-9a-fA-F:.]{2,45}(\/\d{1,3})?$/;

const yesOption = (what) => ({yes: {type: 'boolean', description: `yes, ${what}`}});
const showSecrets = {
  'show-secrets': {
    type: 'boolean',
    description: 'with --output json: keep the password in the answer (never shown as text)',
  },
};

const need = (ctx, why) => {
  if (!ctx.values.yes) throw new UsageError(`${why}: confirm with --yes`, ctx.usage());
};

// The data without its password fields, unless JSON with --show-secrets; `passwordSet` says whether there is one.
function hidePasswords(data, ctx, keys = ['password']) {
  if (!data || typeof data !== 'object') return data;
  if (ctx.values['show-secrets'] && ctx.output === 'json') return data;
  const out = {...data};
  for (const k of keys) {
    if (k in out) {
      out[`${k}Set`] = Boolean(out[k]);
      delete out[k];
    }
  }
  return out;
}

const checkHost = (v, name) => {
  if (v !== '' && !HOST.test(v)) throw new UsageError(`--${name} is a host name or an IP address: ${v}`);
  return v;
};

const checkPortValue = (v, name = 'port') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--${name} is a port (1-65535): ${v}`);
  return n;
};

const onOff = (v) => (v === undefined ? undefined : v === 'on');

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, {once: true});
  });

// Polls read() until done(result) or --wait seconds (default: seconds) have passed (or Ctrl-C); returns {result, finished}.
async function poll(ctx, read, done, seconds) {
  const wait = Number(ctx.values.wait ?? seconds);
  if (!Number.isFinite(wait) || wait < 0) throw new UsageError(`--wait is seconds: ${ctx.values.wait}`);
  const until = ctx.clock() + wait * 1000;
  for (;;) {
    const result = await read();
    if (done(result)) return {result, finished: true};
    const left = until - ctx.clock();
    if (left <= 0 || ctx.signal?.aborted) return {result, finished: false};
    await sleep(Math.min(2000, left), ctx.signal);
  }
}

const waitOption = (seconds) => ({
  wait: {type: 'string', placeholder: 'SECONDS', description: `how long to wait for the result (default ${seconds})`},
});

// "1797206400" (unix seconds) → the local date; "*" → "no end".
const untilDate = (v) =>
  v === '*' ? 'no end' : /^\d+$/.test(String(v ?? '')) ? localTime(Number(v) * 1000).slice(0, 10) : String(v ?? '');

// The license types with a total or a use: [[type, used, total]].
const licenseRows = (l) => {
  const totals = l?.limitations?.licenseTypes ?? {};
  const used = l?.licenseUsage ?? {};
  return [...new Set([...Object.keys(totals), ...Object.keys(used)])]
    .filter((t) => Number(totals[t]) || Number(used[t]))
    .map((t) => [t, Number(used[t] ?? 0), Number(totals[t] ?? 0)]);
};

// The HTML of the upgrade logs (<b>…</b>) as plain text.
const plain = (s) => String(s ?? '').replace(/<[^>]*>/g, '');

const featureLine = (f, c) => [
  f.name,
  f.enabled ? c.green('on') : c.dim('off'),
  oneLine(
    `${f.label ?? ''}${f.available === false ? ' (not available)' : ''}${f.error ? ` — ${f.error}` : ''}${f.message ? ` (${f.message})` : ''}`,
    80,
  ),
];

async function current(client, path, scope) {
  return (await client.call('GET', path, undefined, {scope})) ?? {};
}

export const groups = {
  system: {
    summary:
      'the PBX itself: version, license, settings (features, SMTP, NTP, proxy, trusted IPs), ports, upgrade, reboot',
    commands: {
      info: {
        summary: 'version, ping and license summary of the PBX in one',
        usage: 'wx-admin system info',
        options: {},
        args: [0, 0],
        async run(ctx) {
          const client = await pbxClient(ctx);
          const version = await client.call('GET', '/PBX/version/', undefined, {scope: 'info'});
          const start = ctx.clock();
          const ping = await client.call('GET', '/PBX/ping/', undefined, {scope: 'info'});
          const pingMs = ctx.clock() - start;
          let license;
          let licenseError;
          try {
            const l = await client.call('GET', '/PBX/settings/license/', undefined, {scope: 'pbx'});
            license = {
              activated: l?.activated,
              domain: l?.domain,
              licenses: licenseRows(l).map(([type, used, total]) => ({type, used, total})),
            };
          } catch (e) {
            if (!e.status) throw e;
            licenseError = e.message.split('\n')[0]; // e.g. an API key without pbx:read
          }
          return {host: client.target.host, version, ping, pingMs, license, licenseError};
        },
        text: (r, ctx) => {
          const c = paint(ctx);
          const lines = [`${c.bold(r.host)}  WMS ${r.version}  ping ${r.ping} (${r.pingMs} ms)`];
          if (r.license) {
            const list = r.license.licenses.map((l) => `${l.type} ${l.used}/${l.total}`).join(' · ');
            lines.push(
              `license ${r.license.activated ? 'activated' : c.red('not activated')}${list ? ` · ${list}` : ''}`,
            );
          } else lines.push(c.dim(`license: not readable (${r.licenseError})`));
          return lines;
        },
      },
      license: {
        summary: 'the license of the PBX: limits, license types used and bought, options and until when',
        usage: 'wx-admin system license',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/settings/license/', undefined, {scope: 'pbx'});
        },
        text: (l, ctx) => {
          const c = paint(ctx);
          const lim = l.limitations ?? {};
          const options = Object.entries(lim).filter(([, v]) => v && typeof v === 'object' && 'state' in v);
          return [
            `${c.bold(l.domain ?? '')} · ${l.activated ? 'activated' : c.red('not activated')}${lim.serial ? ` · serial ${lim.serial}` : ''}`,
            `limits: ${lim.phones ?? '?'} phones · ${lim.trunks ?? '?'} trunks · ${lim.calls ?? '?'} calls · ${lim.rooms ?? '?'} rooms`,
            ...table([['license', 'used', 'total'], ...licenseRows(l)]),
            ...(options.length
              ? [
                  'options:',
                  ...table(
                    options.map(([k, v]) => [
                      `  ${k}`,
                      v.state ? c.green('on') : c.dim('off'),
                      v.state ? `until ${untilDate(v.until)}` : '',
                    ]),
                  ),
                ]
              : []),
          ];
        },
      },
      settings: {
        summary: 'the settings of the PBX: name, version, cloud, language, license, features, network interfaces',
        usage: 'wx-admin system settings',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/settings/', undefined, {scope: 'pbx'});
        },
        text: (s, ctx) => {
          const c = paint(ctx);
          const lic = s.license ?? {};
          return [
            `${c.bold(s.pbxName ?? '')} (${s.host ?? ''}) · WMS ${s.version ?? '?'} · ${s.isCloud ? 'cloud' : 'on-premise'} · language ${s.defaultLanguage ?? '?'}${s.wmsNetworkRole && s.wmsNetworkRole !== 'null' ? ` · WMS network ${s.wmsNetworkRole}` : ''}`,
            `license: ${lic.activated ? 'activated' : 'not activated'}${lic.maximumAvailableLicenseType ? `, up to ${lic.maximumAvailableLicenseType}` : ''}${lic.subscription ? ', subscription' : ''}`,
            'features (system settings-set):',
            ...table((s.features ?? []).map((f) => featureLine(f, c))).map((l) => `  ${l}`),
            ...((s.integrations ?? []).length
              ? [`integrations: ${s.integrations.map((i) => `${i.name} ${i.enabled ? 'on' : 'off'}`).join(', ')}`]
              : []),
            ...((s.networkInterfaces ?? []).length
              ? [
                  'network:',
                  ...table(
                    s.networkInterfaces.map((n) => [
                      `  ${n.name}`,
                      n.alias ?? '',
                      n.activate ?? '',
                      n.address ? `${n.address}/${n.netmask}` : '',
                    ]),
                  ),
                ]
              : []),
          ];
        },
      },
      'settings-set': {
        summary: 'turn a PBX feature on or off (needs --yes: it changes the whole PBX)',
        usage: 'wx-admin system settings-set --feature NAME (--enable | --disable) --yes',
        details:
          'One feature per request, as the API takes it. The features and their state: wx-admin system settings.',
        options: {
          feature: {type: 'string', choices: FEATURES, description: 'the feature to change'},
          enable: {type: 'boolean', description: 'turn it on'},
          disable: {type: 'boolean', description: 'turn it off'},
          ...yesOption('change the PBX'),
        },
        args: [0, 0],
        async run(ctx) {
          const {feature, enable, disable} = ctx.values;
          if (!feature) throw new UsageError('--feature is needed', ctx.usage());
          if (Boolean(enable) === Boolean(disable)) throw new UsageError('Give --enable or --disable', ctx.usage());
          need(ctx, `Turning ${feature} ${enable ? 'on' : 'off'} changes the whole PBX`);
          const result = await (await pbxClient(ctx)).call(
            'PUT',
            '/PBX/settings/',
            {features: [{name: feature, enabled: Boolean(enable)}]},
            {scope: 'pbx'},
          );
          return {feature, enabled: Boolean(enable), result};
        },
        text: (r) => `${r.feature} turned ${r.enabled ? 'on' : 'off'}`,
      },
      smtp: {
        summary: 'the SMTP settings the PBX sends mail with (the password is never shown)',
        usage: 'wx-admin system smtp [--show-secrets]',
        options: {...showSecrets},
        args: [0, 0],
        async run(ctx) {
          return hidePasswords(await current(await pbxClient(ctx), '/PBX/settings/smtp/', 'smtp'), ctx);
        },
        text: (s) => smtpLines(s),
      },
      'smtp-set': {
        summary: 'change the SMTP settings (needs --yes: mail of the whole PBX goes through them)',
        usage:
          'wx-admin system smtp-set [--host HOST] [--port N] [--from EMAIL] [--user NAME] [--password] [--auth METHOD] [--tls on|off] [--starttls on|off] [--timeout S] [--domain NAME] [--cloud-default on|off] --yes',
        details:
          'What is not given is kept. --password reads the new password hidden from the terminal, or the first line of stdin.',
        options: {
          host: {type: 'string', placeholder: 'HOST', description: 'the SMTP server'},
          port: {type: 'string', placeholder: 'N', description: 'its port'},
          from: {type: 'string', placeholder: 'EMAIL', description: 'the sender of the mail of the PBX'},
          user: {type: 'string', placeholder: 'NAME', description: 'the SMTP user'},
          password: {type: 'boolean', description: 'set a new password, typed hidden or read from stdin'},
          auth: {type: 'string', choices: SMTP_AUTH, description: 'the authentication method (off: none)'},
          tls: {type: 'string', choices: ON_OFF, description: 'TLS from the start'},
          starttls: {type: 'string', choices: ON_OFF, description: 'STARTTLS'},
          timeout: {type: 'string', choices: SMTP_TIMEOUTS, description: 'seconds to wait for the server'},
          domain: {type: 'string', placeholder: 'NAME', description: 'the HELO domain'},
          'cloud-default': {
            type: 'string',
            choices: ON_OFF,
            description: 'use the default SMTP of Wildix (cloud PBX only)',
          },
          ...yesOption('change the SMTP settings'),
        },
        args: [0, 0],
        async run(ctx) {
          const v = ctx.values;
          const change = {};
          if (v.host !== undefined) change.host = checkHost(v.host, 'host');
          if (v.port !== undefined) change.port = checkPortValue(v.port);
          if (v.from !== undefined) change.from = v.from;
          if (v.user !== undefined) change.user = v.user;
          if (v.auth !== undefined) change.auth = v.auth;
          if (v.tls !== undefined) change.tls = onOff(v.tls);
          if (v.starttls !== undefined) change.tlsStartTls = onOff(v.starttls);
          if (v.timeout !== undefined) change.timeout = Number(v.timeout);
          if (v.domain !== undefined) change.domain = v.domain;
          if (v['cloud-default'] !== undefined) change.isDefaultSettings = onOff(v['cloud-default']);
          if (!Object.keys(change).length && !v.password) throw new UsageError('Nothing to change', ctx.usage());
          need(ctx, 'The SMTP settings carry the mail of the whole PBX');
          // A new host with the old password would send that password to the new host.
          if (v.host !== undefined && !v.password)
            throw new UsageError(
              'A new --host needs the password for it too: add --password (the current one is not sent to another host)',
              ctx.usage(),
            );
          if (v.password) change.password = await readSecret(ctx, 'SMTP password: ');
          const client = await pbxClient(ctx);
          // The PUT wants auth, port and timeout: the current settings (password included, so it is kept) plus the change.
          const body = {...(await current(client, '/PBX/settings/smtp/', 'smtp')), ...change};
          const result = await client.call('PUT', '/PBX/settings/smtp/', body, {scope: 'smtp'});
          return hidePasswords(result && typeof result === 'object' ? result : {...body, result}, {...ctx, values: {}});
        },
        text: (s) => ['SMTP settings saved', ...smtpLines(s)],
      },
      'smtp-test': {
        summary: 'send a test e-mail with the SMTP settings and show the log of the SMTP server',
        usage: 'wx-admin system smtp-test --to EMAIL [--from EMAIL] [--body TEXT] [--wait SECONDS]',
        details:
          '--from defaults to the sender of the SMTP settings. The test runs on the PBX; its status is read until it is done.',
        options: {
          to: {type: 'string', placeholder: 'EMAIL', description: 'where to send the test e-mail'},
          from: {
            type: 'string',
            placeholder: 'EMAIL',
            description: 'the sender (default: the one of the SMTP settings)',
          },
          body: {type: 'string', placeholder: 'TEXT', description: 'the text of the e-mail'},
          ...waitOption(60),
        },
        args: [0, 0],
        async run(ctx) {
          const {to, body} = ctx.values;
          if (!to || !/^[^\s@]+@[^\s@]+$/.test(to)) throw new UsageError('--to is an e-mail address', ctx.usage());
          const client = await pbxClient(ctx);
          const from = ctx.values.from ?? (await current(client, '/PBX/settings/smtp/', 'smtp')).from;
          if (!from) throw new UsageError('The SMTP settings have no sender: give --from');
          const started = await client.call(
            'POST',
            '/PBX/settings/smtp/test/',
            {mailto: to, from, body: body ?? `Test e-mail from the PBX ${client.target.host} (wx-admin)`},
            {scope: 'smtp'},
          );
          const testId = started?.testId || 'default';
          const {result, finished} = await poll(
            ctx,
            () => client.call('GET', apiPath`/PBX/settings/smtp/test/status/${testId}/`, undefined, {scope: 'smtp'}),
            (s) => s && s.queued === false,
            60,
          );
          return {to, from, testId, finished, ...(result ?? {})};
        },
        text: (r) => [
          `Test e-mail to ${r.to} from ${r.from}: ${r.finished ? 'done' : 'still queued'}`,
          ...String(r.content ?? '')
            .split('\n')
            .filter(Boolean)
            .map((l) => `  ${l}`),
        ],
      },
      ntp: {
        summary: 'the NTP servers of the PBX and its time',
        usage: 'wx-admin system ntp',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/settings/ntp/', undefined, {scope: 'pbx'});
        },
        text: (n) => [`primary    ${n.pntp || '-'}`, `secondary  ${n.sntp || '-'}`, `PBX time   ${n.time ?? ''}`],
      },
      'ntp-set': {
        summary: 'change the NTP servers (needs --yes: the clock of the whole PBX follows them)',
        usage: 'wx-admin system ntp-set [--primary HOST] [--secondary HOST] --yes',
        options: {
          primary: {type: 'string', placeholder: 'HOST', description: 'the primary NTP server (name or IP)'},
          secondary: {
            type: 'string',
            placeholder: 'HOST',
            description: 'the secondary NTP server (empty to remove it)',
          },
          ...yesOption('change the NTP servers'),
        },
        args: [0, 0],
        async run(ctx) {
          const {primary, secondary} = ctx.values;
          if (primary === undefined && secondary === undefined)
            throw new UsageError('Give --primary and/or --secondary', ctx.usage());
          if (primary !== undefined && !primary) throw new UsageError('--primary cannot be empty');
          need(ctx, 'The NTP servers set the clock of the whole PBX');
          const client = await pbxClient(ctx);
          const now = await current(client, '/PBX/settings/ntp/', 'pbx');
          const body = {
            pntp: primary === undefined ? (now.pntp ?? '') : checkHost(primary, 'primary'),
            sntp: secondary === undefined ? (now.sntp ?? '') : checkHost(secondary, 'secondary'),
          };
          const result = await client.call('PUT', '/PBX/settings/ntp/', body, {scope: 'pbx'});
          return {...body, result};
        },
        text: (n) => `NTP servers: ${n.pntp}${n.sntp ? `, ${n.sntp}` : ''}`,
      },
      proxy: {
        summary: 'the HTTP proxy of the PBX (for the support VPN; the password is never shown)',
        usage: 'wx-admin system proxy [--show-secrets]',
        options: {...showSecrets},
        args: [0, 0],
        async run(ctx) {
          return hidePasswords(await current(await pbxClient(ctx), '/PBX/settings/httpProxy/', 'pbx'), ctx);
        },
        text: (p) => proxyLines(p),
      },
      'proxy-set': {
        summary: 'change the HTTP proxy (needs --yes: the support VPN of the PBX goes through it)',
        usage:
          'wx-admin system proxy-set [--enable | --disable] [--host HOST] [--port N] [--auth none|basic|ntlm] [--login NAME] [--password] --yes',
        details:
          'What is not given is kept. --password reads the new password hidden from the terminal, or the first line of stdin.',
        options: {
          enable: {type: 'boolean', description: 'use the proxy'},
          disable: {type: 'boolean', description: 'do not use the proxy'},
          host: {type: 'string', placeholder: 'HOST', description: 'the proxy host'},
          port: {type: 'string', placeholder: 'N', description: 'the proxy port'},
          auth: {type: 'string', choices: ['none', 'basic', 'ntlm'], description: 'how to sign in to the proxy'},
          login: {type: 'string', placeholder: 'NAME', description: 'the proxy user'},
          password: {type: 'boolean', description: 'set a new password, typed hidden or read from stdin'},
          ...yesOption('change the proxy'),
        },
        args: [0, 0],
        async run(ctx) {
          const v = ctx.values;
          if (v.enable && v.disable) throw new UsageError('Give --enable or --disable, not both');
          const change = {};
          if (v.enable || v.disable) change.enable = Boolean(v.enable);
          if (v.host !== undefined) change.host = checkHost(v.host, 'host');
          if (v.port !== undefined) change.port = String(checkPortValue(v.port));
          if (v.auth !== undefined) change.auth_method = v.auth;
          if (v.login !== undefined) change.login = v.login;
          if (!Object.keys(change).length && !v.password) throw new UsageError('Nothing to change', ctx.usage());
          need(ctx, 'The HTTP proxy carries the support VPN of the PBX');
          if (v.host !== undefined && !v.password)
            throw new UsageError(
              'A new --host needs the password for it too: add --password (the current one is not sent to another host)',
              ctx.usage(),
            );
          if (v.password) change.password = await readSecret(ctx, 'Proxy password: ');
          const client = await pbxClient(ctx);
          const body = {...(await current(client, '/PBX/settings/httpProxy/', 'pbx')), ...change};
          if (body.enable && (!body.host || !body.port))
            throw new UsageError('An enabled proxy needs --host and --port');
          const result = await client.call('PUT', '/PBX/settings/httpProxy/', body, {scope: 'pbx'});
          return hidePasswords(result && typeof result === 'object' ? result : body, {...ctx, values: {}});
        },
        text: (p) => ['HTTP proxy saved', ...proxyLines(p)],
      },
      'trusted-ip': {
        summary: 'the trusted IP addresses of the PBX',
        usage: 'wx-admin system trusted-ip',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/settings/trusted-ips/', undefined, {scope: 'security'});
        },
        text: (r) => (r?.rows?.length ? r.rows : 'No trusted IPs'),
      },
      'trusted-ip-set': {
        summary: 'add or remove trusted IP addresses (needs --yes: the security of the whole PBX)',
        usage: 'wx-admin system trusted-ip-set [--add IP]... [--remove IP]... [--clear] --yes',
        details: 'An IP is an address or a network (192.168.0.0/24). --clear removes all of them first.',
        options: {
          add: {type: 'string', multiple: true, placeholder: 'IP', description: 'trust this address or network'},
          remove: {type: 'string', multiple: true, placeholder: 'IP', description: 'stop trusting it'},
          clear: {type: 'boolean', description: 'remove all of them first'},
          ...yesOption('change the trusted IPs'),
        },
        args: [0, 0],
        async run(ctx) {
          const add = ctx.values.add ?? [];
          const remove = ctx.values.remove ?? [];
          if (!add.length && !remove.length && !ctx.values.clear)
            throw new UsageError('Give --add, --remove or --clear', ctx.usage());
          for (const ip of [...add, ...remove])
            if (!IP_OR_NET.test(ip)) throw new UsageError(`Not an IP address or network: ${ip}`);
          need(ctx, 'Trusted IPs change the security of the whole PBX');
          const client = await pbxClient(ctx);
          const now = ctx.values.clear
            ? []
            : ((await current(client, '/PBX/settings/trusted-ips/', 'security')).rows ?? []);
          const missing = remove.filter((ip) => !now.includes(ip));
          if (missing.length && !ctx.values.clear) throw new UsageError(`Not trusted now: ${missing.join(', ')}`);
          const rows = [
            ...now.filter((ip) => !remove.includes(ip)),
            ...add.filter((ip, i) => !now.includes(ip) && add.indexOf(ip) === i),
          ];
          const result = await client.call('PUT', '/PBX/settings/trusted-ips/', {rows}, {scope: 'security'});
          return result && typeof result === 'object' && Array.isArray(result.rows) ? result : {rows};
        },
        text: (r) => (r.rows.length ? ['Trusted IPs:', ...r.rows.map((ip) => `  ${ip}`)] : 'No trusted IPs'),
      },
      ports: {
        summary: 'whether the ports of the PBX are open from outside (HTTP, SIP, RTP), as last checked',
        usage: 'wx-admin system ports',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/Ports/Status/', undefined, {scope: 'info'});
        },
        text: (r, ctx) => {
          const c = paint(ctx);
          const state = (s) =>
            String(s) === '1' ? c.green('open') : String(s) === '0' ? c.red('closed') : String(s ?? '?');
          return r?.records?.length
            ? table(
                r.records.map((p) => [
                  p.protocol,
                  p.transport,
                  p.port,
                  state(p.status),
                  `checked ${p.lastcheck ?? '?'}`,
                ]),
              )
            : 'No ports checked';
        },
      },
      upgrade: {
        summary: 'the state of the last upgrade of the PBX and its log',
        usage: 'wx-admin system upgrade',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/Upgrade/', undefined, {scope: 'pbx'});
        },
        text: (u) => [
          `upgrade ${u.isRunning ? `running, ${u.progress ?? 0}%` : 'not running'}${!u.isRunning && u.completed ? ' · the last one completed' : ''}`,
          ...(u.log ?? [])
            .map(plain)
            .filter((l) => l.trim())
            .map((l) => `  ${l}`),
        ],
      },
      'upgrade-check': {
        summary: 'look for a new WMS version and packages (runs the check on the PBX and waits for it)',
        usage: 'wx-admin system upgrade-check [--status] [--wait SECONDS]',
        details:
          'The check updates the package lists of the PBX; it installs nothing. --status reads the last result (the PBX starts a new check when the last one is older than 3 minutes).',
        options: {
          status: {type: 'boolean', description: 'do not start a check: read the last result'},
          ...waitOption(300),
        },
        args: [0, 0],
        async run(ctx) {
          const client = await pbxClient(ctx);
          const read = () => client.call('GET', '/PBX/Upgrade/Check/', undefined, {scope: 'pbx'});
          if (ctx.values.status) return read();
          await client.call('POST', '/PBX/Upgrade/Check/', undefined, {scope: 'pbx'});
          const {result, finished} = await poll(ctx, read, (r) => r?.check?.isRunning === false, 300);
          if (!finished) ctx.info('The check is still running: wx-admin system upgrade-check --status');
          return result;
        },
        text: (r, ctx) => {
          const c = paint(ctx);
          const check = r.check ?? {};
          const news = r.newVersion
            ? `new version ${c.bold(r.newVersion)}`
            : r.newPackages
              ? 'new packages'
              : 'up to date';
          return [
            `repository ${r.repository ?? '?'} · ${check.isRunning ? 'check running' : news}${r.upgrade?.isRunning ? ' · an upgrade is running' : ''}`,
            ...(check.isRunning
              ? []
              : [
                  `check ${check.withoutError === false ? c.red('had errors') : 'without errors'} · file system ${check.fileSystemStatus === false ? c.red('not ok') : 'ok'}`,
                ]),
            ...(check.log ?? [])
              .map(plain)
              .filter((l) => l.trim())
              .map((l) => `  ${l}`),
          ];
        },
      },
      'upgrade-settings': {
        summary: 'how the PBX upgrades: repository, automatic upgrades, custom firmware server',
        usage: 'wx-admin system upgrade-settings',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/Upgrade/Settings/', undefined, {scope: 'pbx'});
        },
        text: (s) => {
          const w = s.wmsrelease ?? {};
          const f = s.customFirmwareServer ?? {};
          return [
            `repository ${w.repository ?? '?'} · automatic upgrade ${w.enabled ? `on, ${w.howly ?? '?'}` : 'off'}${w.email ? ` · log to ${w.email}` : ''}`,
            `custom firmware server ${f.enabled ? `${f.url}${f.checkTls ? ' (TLS checked)' : ' (TLS not checked)'}` : 'off'}`,
          ];
        },
      },
      'upgrade-start': {
        summary: 'start the upgrade of the PBX (needs --yes); then follow it with system upgrade, and reboot',
        usage: 'wx-admin system upgrade-start --yes',
        details:
          'Run system upgrade-check first. The upgrade runs in the background: system upgrade shows its progress; when it is done, system reboot --yes.',
        options: yesOption('upgrade the PBX'),
        args: [0, 0],
        async run(ctx) {
          need(
            ctx,
            'An upgrade changes the software of the whole PBX and is followed by a reboot that stops all calls',
          );
          return (await pbxClient(ctx)).call('POST', '/PBX/Upgrade/', undefined, {scope: 'pbx'});
        },
        text: (r) =>
          r?.status === false
            ? 'The PBX did not start the upgrade'
            : 'Upgrade started: follow it with wx-admin system upgrade',
      },
      reboot: {
        summary: 'reboot the PBX (needs --yes: every call stops)',
        usage: 'wx-admin system reboot --yes',
        options: yesOption('reboot the PBX now'),
        args: [0, 0],
        async run(ctx) {
          need(ctx, 'A reboot stops every call and every device of the PBX for some minutes');
          const result = await (await pbxClient(ctx)).call('PUT', '/PBX/System/Reboot/', undefined, {
            scope: 'pbxpower',
          });
          return {rebooting: true, result};
        },
        text: () => 'The PBX is rebooting',
      },
    },
  },
};

function smtpLines(s) {
  return [
    `server    ${s.host || '-'}:${s.port ?? ''}${s.tls ? ' TLS' : ''}${s.tlsStartTls ? ' STARTTLS' : ''}${s.isDefaultSettings ? ' (the default SMTP of Wildix)' : ''}`,
    `from      ${s.from || '-'}`,
    `auth      ${s.auth ?? '?'}${s.user ? ` as ${s.user}` : ''}${s.passwordSet ? ' (password set)' : ''}`,
    `HELO      ${s.domain || '-'} · timeout ${s.timeout ?? '?'} s`,
  ];
}

function proxyLines(p) {
  return [
    `HTTP proxy ${p.enable ? 'on' : 'off'}${p.host ? ` · ${p.host}:${p.port ?? ''}` : ''} · auth ${p.auth_method ?? 'none'}${p.login ? ` as ${p.login}` : ''}${p.passwordSet ? ' (password set)' : ''}`,
  ];
}
