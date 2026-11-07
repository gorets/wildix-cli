// The Wildix login of the user (x-bees, x-hoppers, Collaboration 7): Cognito CUSTOM_AUTH with a one-time code sent
// by e-mail. Shared with the wildix-auth agent skill: one file per profile (e-mail) in $WILDIX_CONFIG_DIR/tokens (default
// ~/.wildix/tokens), named <e-mail with @ as _at_>.prod.json, holding the Cognito set {IdToken, AccessToken,
// RefreshToken, ExpiresIn, email, savedAt}. An expired IdToken is renewed with the RefreshToken and written back in
// the same format, so the skill and the CLI keep using one session.
//
// The tokens are never printed and never put on a command line or into the environment of a child process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AuthError} from './errors.mjs';
import {loginHint, program, userAgent} from './program.mjs';

export const CLIENT_ID = '2un9vsk5ghu0ocurajqe4a6l1e';
export const COGNITO_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/';
const RENEW_EARLY_MS = 60_000;
// Cognito keeps the session of a sign-in that waits for its code for 3 minutes.
export const PENDING_TTL_MS = 3 * 60_000;

export const configDir = (env = process.env) => env.WILDIX_CONFIG_DIR || path.join(os.homedir(), '.wildix');
export const tokensDir = (env = process.env) => path.join(configDir(env), 'tokens');

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function checkEmail(email) {
  if (typeof email !== 'string' || !EMAIL.test(email) || email.includes('..'))
    throw new AuthError(`Not a valid e-mail: ${email}`);
  return email.toLowerCase();
}

// The e-mail becomes part of a file name: letters, digits and . _ % + - @ only, no "..".
export function tokenFile(email, env = process.env) {
  if (!/^[A-Za-z0-9._%+@-]+$/.test(email) || email.includes('..')) throw new AuthError(`Not a valid e-mail: ${email}`);
  return path.join(tokensDir(env), `${email.replace(/@/g, '_at_')}.prod.json`);
}

// A sign-in that waits for its code (wx login --send-code, then --code): the Cognito session, privately.
export const pendingFile = (email, env = process.env) =>
  path.join(tokensDir(env), `.${email.replace(/@/g, '_at_')}.pending.json`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// When the IdToken of a saved set stops being valid, in ms: its `exp` claim, else savedAt + ExpiresIn, else 0.
export function expiresAt(set) {
  const exp = jwtClaims(set?.IdToken).exp;
  if (Number.isFinite(exp)) return exp * 1000;
  const saved = Date.parse(set?.savedAt ?? '');
  return Number.isFinite(saved) && Number.isFinite(set?.ExpiresIn) ? saved + set.ExpiresIn * 1000 : 0;
}

// The saved sessions: [{email, expiresAt}], never the tokens.
export function sessions(env = process.env) {
  const dir = tokensDir(env);
  let names;
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.prod.json') && !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
  return names
    .map((n) => readJson(path.join(dir, n)))
    .filter((set) => typeof set?.email === 'string')
    .map((set) => ({email: set.email, expiresAt: expiresAt(set)}));
}

// ── profiles ─────────────────────────────────────────────────────────────────────────────────────────────────
// A profile is an e-mail logged in to Wildix. The default one is kept in $WILDIX_CONFIG_DIR/wx.json ({"defaultProfile":
// e-mail}, 0600); the wildix-auth skill does not read it.
export const settingsFile = (env = process.env) => path.join(configDir(env), 'wx.json');
const readSettings = (env) => readJson(settingsFile(env)) ?? {};
const sameEmail = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The default profile, when it is still logged in; else undefined.
export function defaultProfile(env = process.env) {
  const wanted = readSettings(env).defaultProfile;
  return wanted ? sessions(env).find((s) => sameEmail(s.email, wanted))?.email : undefined;
}

export function setDefaultProfile(email, env = process.env) {
  const settings = readSettings(env);
  if (email) settings.defaultProfile = email;
  else delete settings.defaultProfile;
  writePrivate(settingsFile(env), settings);
}

// Which profile, and why: --profile, else WILDIX_EMAIL, else the default profile, else the only one logged in.
// Returns {email, by: 'option'|'environment'|'default'|'only'}.
export function chooseProfile(env = process.env, profile) {
  const list = sessions(env);
  const given = profile || env.WILDIX_EMAIL;
  // An e-mail given in another case is the saved session of that e-mail.
  if (given)
    return {email: list.find((s) => sameEmail(s.email, given))?.email ?? given, by: profile ? 'option' : 'environment'};
  if (!list.length) throw new AuthError(`Not logged in to Wildix. ${loginHint()}`);
  const byDefault = defaultProfile(env);
  if (byDefault) return {email: byDefault, by: 'default'};
  if (list.length === 1) return {email: list[0].email, by: 'only'};
  throw new AuthError(
    `Several profiles are logged in and none is the default. Choose one for this command with --profile, or set the default: ${program.name} profile use <e-mail>\n${list.map((s) => `  ${s.email}`).join('\n')}`,
  );
}

export const pickProfile = (env = process.env, profile) => chooseProfile(env, profile).email;

// The format of the skill: whole seconds, no milliseconds (its bash parses it with `date -f %Y-%m-%dT%H:%M:%SZ`).
export const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function writePrivate(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // not ours to change: the file itself is still 0600
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, file);
}

// Writes a token set privately (0600) and atomically; a set without IdToken, RefreshToken and ExpiresIn is refused.
export function saveTokens(file, set) {
  if (typeof set?.IdToken !== 'string' || typeof set?.RefreshToken !== 'string' || typeof set?.ExpiresIn !== 'number') {
    throw new AuthError('The answer carried no complete set of tokens: nothing was saved.');
  }
  writePrivate(file, set);
}

// One call to the Cognito identity provider. Returns the answer; throws AuthError with Cognito's reason.
export async function cognito(target, payload, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(COGNITO_URL, {
    method: 'POST',
    headers: {
      'user-agent': userAgent(),
      'content-type': 'application/x-amz-json-1.1',
      'cache-control': 'no-store',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.__type) {
    const err = new AuthError(body?.message || body?.__type || `HTTP ${res.status}`);
    err.type = body?.__type;
    throw err;
  }
  return body ?? {};
}

async function renew(email, set, {env, fetchImpl, now}) {
  let body;
  try {
    body = await cognito(
      'InitiateAuth',
      {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {REFRESH_TOKEN: set.RefreshToken},
        ClientMetadata: {},
      },
      fetchImpl,
    );
  } catch (e) {
    if (e instanceof AuthError)
      throw new AuthError(`The session of ${email} could not be renewed (${e.message}). ${loginHint()}`);
    throw e;
  }
  const result = body.AuthenticationResult;
  if (typeof result?.IdToken !== 'string')
    throw new AuthError(`The session of ${email} could not be renewed. ${loginHint()}`);
  // Cognito sends no new RefreshToken on a refresh unless rotation is on for the client: then the new one is kept,
  // else the saved one.
  const next = {
    ...result,
    email,
    savedAt: stamp(now),
    RefreshToken: result.RefreshToken ?? set.RefreshToken,
    ExpiresIn: result.ExpiresIn ?? set.ExpiresIn,
  };
  saveTokens(tokenFile(email, env), next);
  return next;
}

// The saved token set of the profile as it is (not renewed), or undefined.
export function savedSession(email, env = process.env) {
  const set = readJson(tokenFile(email, env));
  return typeof set?.IdToken === 'string' ? set : undefined;
}

// The saved token set of the profile, renewed when its IdToken expires within a minute.
export async function getSession({profile, env = process.env, fetchImpl = globalThis.fetch, now = Date.now()} = {}) {
  const email = pickProfile(env, profile);
  const set = readJson(tokenFile(email, env));
  if (typeof set?.IdToken !== 'string') throw new AuthError(`No saved session for ${email}. ${loginHint()}`);
  if (expiresAt(set) - RENEW_EARLY_MS > now) return set;
  if (typeof set.RefreshToken !== 'string') throw new AuthError(`The session of ${email} has expired. ${loginHint()}`);
  return renew(email, set, {env, fetchImpl, now});
}

// A valid IdToken of the profile: WILDIX_ID_TOKEN as given (tests, CI), else the saved session (renewed).
export async function getToken(options = {}) {
  const env = options.env ?? process.env;
  if (env.WILDIX_ID_TOKEN) return env.WILDIX_ID_TOKEN;
  return (await getSession(options)).IdToken;
}

// ── signing in ───────────────────────────────────────────────────────────────────────────────────────────────
// Starts a sign-in: Wildix sends a one-time code to the e-mail. Returns the Cognito session that the code answers.
export async function startLogin(email, fetchImpl = globalThis.fetch) {
  let body;
  try {
    body = await cognito(
      'InitiateAuth',
      {AuthFlow: 'CUSTOM_AUTH', ClientId: CLIENT_ID, AuthParameters: {USERNAME: email}, ClientMetadata: {}},
      fetchImpl,
    );
  } catch (e) {
    if (e instanceof AuthError) throw new AuthError(`Wildix did not start a sign-in for ${email}: ${e.message}`);
    throw e;
  }
  if (typeof body.Session !== 'string') throw new AuthError(`Wildix did not start a sign-in for ${email}.`);
  return body.Session;
}

// Answers the code. Returns {saved: true} with the session stored, or {saved: false, session} when the code was not
// accepted (Cognito answers a wrong code with a new challenge and a new session, which takes the next try).
export async function finishLogin(
  email,
  session,
  code,
  {env = process.env, fetchImpl = globalThis.fetch, now = Date.now()} = {},
) {
  let body;
  try {
    body = await cognito(
      'RespondToAuthChallenge',
      {
        ChallengeName: 'CUSTOM_CHALLENGE',
        ChallengeResponses: {USERNAME: email, ANSWER: code},
        ClientId: CLIENT_ID,
        Session: session,
      },
      fetchImpl,
    );
  } catch (e) {
    if (e instanceof AuthError)
      throw new AuthError(`The sign-in of ${email} failed: ${e.message}. Start again: ${program.name} login ${email}`);
    throw e;
  }
  const result = body.AuthenticationResult;
  if (typeof result?.IdToken !== 'string') return {saved: false, session: body.Session};
  saveTokens(tokenFile(email, env), {...result, email, savedAt: stamp(now)});
  // The first profile becomes the default one; a second login does not change it.
  const isDefault = !defaultProfile(env) || sameEmail(defaultProfile(env), email);
  if (!defaultProfile(env)) setDefaultProfile(email, env);
  return {saved: true, isDefault};
}

export function savePending(email, session, {env = process.env, now = Date.now()} = {}) {
  writePrivate(pendingFile(email, env), {email, session, startedAt: now});
}

// The waiting sign-in of the e-mail, or undefined when there is none or it is older than Cognito keeps it.
export function readPending(email, {env = process.env, now = Date.now()} = {}) {
  const p = readJson(pendingFile(email, env));
  if (typeof p?.session !== 'string' || !(now - p.startedAt < PENDING_TTL_MS)) return undefined;
  return p;
}

export function dropPending(email, env = process.env) {
  fs.rmSync(pendingFile(email, env), {force: true});
}

// ── signing out ──────────────────────────────────────────────────────────────────────────────────────────────
// Revokes the refresh token of the profile (this device) and deletes its local session. With everywhere, signs the
// profile out of every device (GlobalSignOut, which needs a valid AccessToken). An error leaves the local session
// as it was: it is still valid, and the call can be repeated.
export async function logout(
  email,
  {everywhere = false, env = process.env, fetchImpl = globalThis.fetch, now = Date.now()} = {},
) {
  const file = tokenFile(email, env);
  const set = readJson(file);
  if (!set) throw new AuthError(`No saved session for ${email}.`);
  if (everywhere) {
    const fresh = await getSession({profile: email, env, fetchImpl, now});
    await cognito('GlobalSignOut', {AccessToken: fresh.AccessToken}, fetchImpl);
  } else {
    await cognito('RevokeToken', {Token: set.RefreshToken, ClientId: CLIENT_ID}, fetchImpl);
  }
  fs.rmSync(file, {force: true});
  if (sameEmail(readSettings(env).defaultProfile ?? '', email)) setDefaultProfile(undefined, env);
}
