// login, logout: the Wildix login of the user (a one-time code sent by e-mail).
import {createInterface} from 'node:readline/promises';
import {
  PENDING_TTL_MS,
  checkEmail,
  defaultProfile,
  dropPending,
  finishLogin,
  logout as signOut,
  pickProfile,
  readPending,
  savePending,
  startLogin,
} from '../auth.mjs';
import {AuthError, UsageError} from '../errors.mjs';
import {program} from '../program.mjs';

const TRIES = 3;

// The answer of a login: the profile, and whether it is the default one (the first login makes it so).
const loggedIn = (ctx, email, r) => ({
  profile: email,
  loggedIn: true,
  default: r.isDefault,
  defaultProfile: defaultProfile(ctx.env) ?? null,
});

function checkCode(code) {
  const c = String(code).trim();
  if (!/^[A-Za-z0-9]{4,12}$/.test(c)) throw new UsageError(`Not a code from the e-mail: ${code}`);
  return c;
}

// The prompt goes to stderr (stdout is data); the answer is the next line of stdin (lines are buffered, so typed
// ahead or piped answers are not lost).
async function ask(lines, ctx, question) {
  ctx.stderr.write(question);
  const next = await lines.next();
  if (next.done) throw new AuthError('No answer: stdin was closed. Nothing was saved.');
  return next.value.trim();
}

async function interactive(ctx, emailArg) {
  const rl = createInterface({input: ctx.stdin, terminal: false});
  const lines = rl[Symbol.asyncIterator]();
  try {
    const email = checkEmail(emailArg ?? (await ask(lines, ctx, 'E-mail of your Wildix account: ')));
    let session = await startLogin(email, ctx.fetch);
    ctx.info(`A code was sent to ${email}.`);
    for (let attempt = 1; attempt <= TRIES; attempt += 1) {
      const code = checkCode(await ask(lines, ctx, 'Code from the e-mail: '));
      const r = await finishLogin(email, session, code, {env: ctx.env, fetchImpl: ctx.fetch, now: ctx.clock()});
      if (r.saved) return loggedIn(ctx, email, r);
      session = r.session;
      if (!session) break;
      if (attempt < TRIES) ctx.info('The code was not accepted. Try again.');
    }
    throw new AuthError(`The code was not accepted. Start again: ${program.name} login ${email}`);
  } finally {
    rl.close();
  }
}

export const login = {
  summary: 'log in with a one-time code sent to your e-mail',
  // Getters: the program name is read when the help is printed, after setProgram().
  get usage() {
    return `${program.name} login [<e-mail>] [--send-code | --code CODE]`;
  },
  get details() {
    return [
      `In a terminal, ${program.name} login asks for the code and waits. Without one (scripts, agents), sign in in two steps:`,
      `  ${program.name} login <e-mail> --send-code      Wildix e-mails a code`,
      `  ${program.name} login <e-mail> --code <code>    within 3 minutes`,
      'The session is shared with the wildix-auth agent skill (~/.wildix/tokens).',
    ].join('\n');
  },
  options: {
    'send-code': {type: 'boolean', description: 'only send the code; finish later with --code'},
    code: {type: 'string', placeholder: 'CODE', description: 'the code from the e-mail, after --send-code'},
  },
  args: [0, 1],
  async run(ctx) {
    const {values, positionals} = ctx;
    if (values['send-code'] && values.code) throw new UsageError('Give --send-code or --code, not both', ctx.usage());
    if (values['send-code'] || values.code) {
      if (!positionals[0]) throw new UsageError('The e-mail is needed', ctx.usage());
      const email = checkEmail(positionals[0]);
      const now = ctx.clock();
      if (values['send-code']) {
        savePending(email, await startLogin(email, ctx.fetch), {env: ctx.env, now});
        return {profile: email, codeSent: true, expiresAt: new Date(now + PENDING_TTL_MS).toISOString()};
      }
      const code = checkCode(values.code);
      const pending = readPending(email, {env: ctx.env, now});
      if (!pending)
        throw new AuthError(
          `No sign-in waits for a code for ${email} (or it is older than 3 minutes). Start with: ${program.name} login ${email} --send-code`,
        );
      const r = await finishLogin(email, pending.session, code, {env: ctx.env, fetchImpl: ctx.fetch, now});
      if (r.saved) {
        dropPending(email, ctx.env);
        return loggedIn(ctx, email, r);
      }
      if (r.session) savePending(email, r.session, {env: ctx.env, now: pending.startedAt});
      else dropPending(email, ctx.env);
      throw new AuthError(
        `The code was not accepted.${r.session ? ` Try again: ${program.name} login ${email} --code <code>` : ` Start again: ${program.name} login ${email} --send-code`}`,
      );
    }
    if (!ctx.stdin.isTTY) {
      throw new UsageError(
        `No terminal to ask for the code: use ${program.name} login <e-mail> --send-code, then ${program.name} login <e-mail> --code <code>`,
        ctx.usage(),
      );
    }
    return interactive(ctx, positionals[0]);
  },
  text(r) {
    if (r.codeSent)
      return `A code was sent to ${r.profile}. Finish before ${r.expiresAt}: ${program.name} login ${r.profile} --code <code>`;
    if (r.default) return `Logged in as ${r.profile} (the default profile)`;
    return [
      `Logged in as ${r.profile}. The default profile stays ${r.defaultProfile}.`,
      `Use it with --profile ${r.profile}, or make it the default: ${program.name} profile use ${r.profile}`,
    ];
  },
};

export const logout = {
  summary: 'log out: revoke the session of this device, or of every device',
  get usage() {
    return `${program.name} logout [--profile EMAIL] [--everywhere]`;
  },
  options: {
    everywhere: {type: 'boolean', description: 'sign out of every device and app, not only this one'},
  },
  args: [0, 0],
  async run(ctx) {
    const email = pickProfile(ctx.env, ctx.values.profile);
    const everywhere = Boolean(ctx.values.everywhere);
    try {
      await signOut(email, {everywhere, env: ctx.env, fetchImpl: ctx.fetch, now: ctx.clock()});
    } catch (e) {
      if (e instanceof AuthError)
        throw new AuthError(`${email} was NOT logged out (${e.message}). The local session is kept.`);
      throw e;
    }
    return {profile: email, loggedOut: true, everywhere};
  },
  text: (r) => `Logged out ${r.profile} (${r.everywhere ? 'every device' : 'this device'})`,
};
