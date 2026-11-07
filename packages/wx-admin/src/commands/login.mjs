// wx-admin login and logout: sign in to a PBX and out of it. Two ways, in this order of preference:
//   1. a Company API Key (made once in WMS, scoped, up to a year, no password or 2FA on this computer);
//   2. a login and password: Basic when the PBX takes it (ALLOW_BASIC_AUTH=true), else the WMS sign-in with its
//      second factor; the password is kept (0600) so that wx-admin moves between the two and signs in again by itself
//      (--no-basic: the WMS sign-in only, and the password is not kept).
// --basic forces Basic, --token takes a Simple Token (deprecated by Wildix). One attempt of each kind: failed
// attempts may count towards the PBX's lockout. Secrets are typed hidden or piped, never arguments, never printed.
import {AuthError, UsageError} from 'wldx-core/errors';
import {localTime} from 'wldx-core/format';
import {askLine, readSecret} from 'wldx-core/secret';
import {choose} from 'wldx-core/select';
import {
  API_KEY,
  accessPath,
  checkPort,
  defaultPbx,
  pbxBase,
  pbxClient,
  pbxHostOf,
  probeBasic,
  readSerial,
  removeAccess,
  saveAccess,
  savedAccess,
  savedPbxs,
  setDefaultPbx,
  signInUntil,
} from '../pbx.mjs';
import {signIn, signOut, WmsAuthError} from '../wms-login.mjs';

const terminal = (ctx) => Boolean(ctx.stdin?.isTTY && typeof ctx.stdin.setRawMode === 'function');
const KINDS = ['api-key', 'password', 'basic', 'token'];

const MENU = [
  {
    label: 'Company API Key (recommended)',
    note: [
      'Made once in WMS: PBX → Integrations → Company API Keys. Works up to a year',
      'without a password or a 2FA code, limited to the scopes you give it, and',
      "revoked in WMS without touching anyone's password. Best for scripts too.",
    ].join('\n'),
  },
  {
    label: 'WMS login and password',
    note: [
      'Nothing to set up. Uses Basic when the PBX allows it, else signs in as WMS',
      'does, with your 2FA code. The password is saved on this computer (0600),',
      'so wx-admin signs in again by itself when the PBX forgets the sign-in',
      '(unused for 36 hours, or a restart); then only a 2FA code is asked.',
    ].join('\n'),
  },
];

// The PBX of login/logout: the argument, else --pbx; both and different is a usage error.
function hostOf(ctx) {
  const [arg] = ctx.positionals;
  if (arg && ctx.pbx && pbxHostOf(arg, ctx) !== pbxHostOf(ctx.pbx, ctx))
    throw new UsageError('Give the PBX once: as the argument or as --pbx', ctx.usage());
  const ref = arg ?? ctx.pbx;
  return ref ? pbxHostOf(ref, ctx) : undefined;
}

async function kindOf(ctx, host) {
  const {values} = ctx;
  const given = KINDS.filter((k) => values[k]);
  if (values['no-basic'] && !given.length) given.push('password');
  if (given.length > 1) throw new UsageError(`Give one of ${KINDS.map((k) => `--${k}`).join(', ')}`, ctx.usage());
  if (values['no-basic'] && given[0] !== 'password') throw new UsageError('--no-basic goes with --password');
  if (values.code !== undefined && given[0] !== 'password' && given.length)
    throw new UsageError('--code goes with --password');
  if (values.user !== undefined && given.length && !['password', 'basic'].includes(given[0]))
    throw new UsageError('--user goes with --password or --basic');
  if (given.length) return given[0];
  if (!terminal(ctx))
    throw new UsageError(
      'How to sign in? Give --api-key (a Company API Key, recommended) or --password (a WMS login and password)',
      ctx.usage(),
    );
  return (await choose(ctx, {title: `How should wx-admin sign in to ${host}?`, items: MENU})) === 0
    ? 'api-key'
    : 'password';
}

// The code of a second factor: --code, else typed in a terminal, else a usage error that names --code.
const codeAsker = (ctx, host, user) => {
  let given = ctx.values.code;
  return async (factor, {resent}) => {
    if (given !== undefined) {
      const code = given;
      given = undefined;
      return code;
    }
    if (!terminal(ctx)) throw new UsageError(`${host} asks for a 2FA code (${factor}): give it with --code CODE`);
    const sent = ['email', 'sms'].includes(factor.toLowerCase());
    return readSecret(
      ctx,
      sent
        ? `${resent ? 'A new code was sent' : `${host} has sent a code`} (${factor}); the code, or Enter to send it again: `
        : `The ${factor.toLowerCase() === 'googleauthenticator' ? 'authenticator app' : factor} code for ${user} on ${host}: `,
    );
  };
};

async function passwordAccess(ctx, {host, port, kind}) {
  const {values} = ctx;
  const user = values.user ?? (terminal(ctx) ? await askLine(ctx, 'User [admin]: ', {default: 'admin'}) : 'admin');
  const password = await readSecret(ctx, `Password of ${user} on ${host}: `);
  if (!password) throw new UsageError('Nothing was entered: nothing was saved');
  const base = pbxBase(ctx, {host, port});
  const fetch = ctx.fetch ?? globalThis.fetch;
  const noBasic = Boolean(values['no-basic']);
  if (!noBasic && (await probeBasic({base, username: user, password, fetch})))
    return {host, port, auth: 'password', mode: 'basic', username: user, password};
  if (kind === 'basic')
    throw new AuthError(
      `${host} did not accept Basic for ${user}: it needs ALLOW_BASIC_AUTH=true and the right password (or sign in without --basic)`,
    );
  try {
    const t = await signIn({base, username: user, password, askCode: codeAsker(ctx, host, user), fetch});
    return {
      host,
      port,
      auth: 'password',
      mode: 'token',
      username: user,
      ...(noBasic ? {basic: false} : {password}),
      ...t,
      lastUsed: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  } catch (e) {
    if (!(e instanceof WmsAuthError)) throw e;
    if (e.kind === 'missing')
      throw new AuthError(
        noBasic
          ? `${host} does not offer the WMS sign-in for tools (a newer WMS has it): wx-admin login ${host} --api-key`
          : `${host} accepts neither Basic (ALLOW_BASIC_AUTH is off) nor the WMS sign-in for tools (a newer WMS has it): wx-admin login ${host} --api-key`,
      );
    if (e.kind === 'credentials') throw new AuthError(`${host} refused the sign-in of ${user}: ${e.message}`);
    throw e;
  }
}

async function secretAccess(ctx, {host, port, kind}) {
  if (kind === 'api-key' && terminal(ctx))
    ctx.info(
      [
        'A Company API Key is made in WMS: PBX → Integrations → Company API Keys (by a root admin; shown once).',
        'Scopes: pbx:read to read, pbx:* to change the PBX (config import needs it).',
      ].join('\n'),
    );
  const secret = (
    await readSecret(ctx, `${kind === 'api-key' ? 'Company API Key' : 'Simple Token'} for ${host}: `)
  ).trim();
  if (!secret) throw new UsageError('Nothing was entered: nothing was saved');
  if (kind === 'api-key') {
    if (!API_KEY.test(secret))
      throw new UsageError('Not a Company API Key: it is wsk-v1- and 93 letters and digits. Nothing was saved.');
    return {host, port, auth: 'apikey', key: secret};
  }
  if (/\s/.test(secret)) throw new UsageError('A token has no spaces. Nothing was saved.');
  return {host, port, auth: 'token', token: secret};
}

export const login = {
  summary: 'sign in to a PBX: a Company API Key, or a login and password (Basic, else the WMS sign-in with 2FA)',
  usage:
    'wx-admin login [<host>] [--api-key | --password [--no-basic] [--user NAME] [--code CODE] | --basic [--user NAME] | --token] [--port N] [--no-check]',
  details: [
    'host: name.wildixin.com (or just name), another host name, or an IP address; or --pbx.',
    'Without a flag, a terminal shows a menu. Secrets are typed hidden or piped (first line of stdin), never arguments.',
    '  --api-key   a Company API Key (wsk-v1-…): recommended',
    '  --password  a login and password: Basic when the PBX takes it, else the WMS sign-in (2FA); the password is saved',
    '  --no-basic  with --password: the WMS sign-in only, and the password is not saved',
    '  --basic     Basic only (needs ALLOW_BASIC_AUTH=true on the PBX; bypasses 2FA)',
    '  --token     a Simple Token (deprecated by Wildix)',
    'The first PBX signed in to becomes the default one (wx-admin pbx use changes it).',
  ].join('\n'),
  options: {
    'api-key': {type: 'boolean', description: 'a Company API Key (wsk-v1-…), recommended'},
    password: {type: 'boolean', description: 'a login and password (Basic, else the WMS sign-in with 2FA)'},
    'no-basic': {type: 'boolean', description: 'with --password: the WMS sign-in only; the password is not saved'},
    basic: {type: 'boolean', description: 'Basic only (ALLOW_BASIC_AUTH=true on the PBX)'},
    token: {type: 'boolean', description: 'a Simple Token (deprecated)'},
    user: {type: 'string', placeholder: 'NAME', description: 'the login (default admin)'},
    code: {type: 'string', placeholder: 'CODE', description: 'the 2FA code, when the PBX asks for one'},
    port: {type: 'string', placeholder: 'N', description: 'the https port of the PBX (default 443)'},
    'no-check': {type: 'boolean', description: 'save without one read of the PBX first'},
  },
  args: [0, 1],
  async run(ctx) {
    const {values} = ctx;
    let host = hostOf(ctx);
    if (!host) {
      if (!terminal(ctx)) throw new UsageError('Give the PBX: wx-admin login <host>', ctx.usage());
      host = pbxHostOf(await askLine(ctx, 'PBX (name.wildixin.com, name or IP): '), ctx);
    }
    const port = values.port === undefined ? 443 : checkPort(values.port);
    const kind = await kindOf(ctx, host);
    const access =
      kind === 'password' || kind === 'basic'
        ? await passwordAccess(ctx, {host, port, kind})
        : await secretAccess(ctx, {host, port, kind});
    // One read with the new access before it is kept (never the key of the environment, never a saved access):
    // nothing is saved, and an access saved before stays, when the PBX refuses it.
    if (!values['no-check']) {
      const client = await pbxClient(ctx, {access});
      await client.call('GET', '/Dictionaries');
      access.serial = await readSerial(client);
    }
    saveAccess(access, ctx.env);
    const madeDefault = !defaultPbx(ctx.env);
    if (madeDefault) setDefaultPbx(host, ctx.env);
    return {
      host,
      port,
      serial: access.serial ?? null,
      auth: access.auth,
      ...(access.auth === 'password'
        ? {
            mode: access.mode,
            user: access.username,
            passwordSaved: Boolean(access.password),
            ...(access.mode === 'token' ? {until: signInUntil(access)} : {}),
          }
        : {}),
      file: accessPath(host, ctx.env),
      madeDefault,
      checked: !values['no-check'],
    };
  },
  text(r) {
    const pbx = `${r.host}${r.serial ? ` (serial ${r.serial})` : ''}`;
    const how =
      r.auth === 'apikey'
        ? `Signed in to ${pbx} with a Company API Key.`
        : r.auth === 'token'
          ? `Signed in to ${pbx} with a Simple Token.`
          : r.mode === 'basic'
            ? `Signed in to ${pbx} as ${r.user} with Basic. The password is saved in ${r.file} (0600): Basic bypasses 2FA, keep this computer safe.`
            : `Signed in to ${pbx} as ${r.user} with the WMS sign-in (2FA), until about ${localTime(r.until)} (sooner if the PBX restarts); ${
                r.passwordSaved
                  ? 'the password is saved so that wx-admin can sign in again by itself (a 2FA code will be asked).'
                  : 'the password is not saved: sign in again when it ends.'
              }`;
    return `${how}${r.madeDefault ? ' It is the default PBX.' : ''}`;
  },
};

export const logout = {
  summary: 'sign out of a PBX: end the WMS sign-in on the PBX and forget the access on this computer',
  usage: 'wx-admin logout [<host>]',
  options: {},
  args: [0, 1],
  complete: 'pbxs',
  async run(ctx) {
    let host = hostOf(ctx) ?? defaultPbx(ctx.env);
    if (!host) {
      const saved = savedPbxs(ctx.env);
      if (saved.length !== 1)
        throw new UsageError(saved.length ? 'Give the PBX: wx-admin logout <host>' : 'Not signed in to any PBX');
      host = saved[0].host;
    }
    const a = savedAccess(host, ctx.env);
    if (!a) throw new UsageError(`Not signed in to ${host}`);
    let ended = null;
    if (a.auth === 'password' && a.mode === 'token' && a.refresh)
      ended = await signOut({base: pbxBase(ctx, a), refresh: a.refresh, fetch: ctx.fetch ?? globalThis.fetch});
    removeAccess(host, ctx.env);
    return {host, endedOnPbx: ended};
  },
  text: (r) =>
    `Signed out of ${r.host}${
      r.endedOnPbx === true
        ? ': the PBX ended the session.'
        : r.endedOnPbx === false
          ? ' on this computer; the PBX did not answer, its session ends by itself.'
          : '.'
    }`,
};
