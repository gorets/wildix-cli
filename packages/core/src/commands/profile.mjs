// profile: the profiles (logged-in e-mails) and which one is the default. No network; never prints a token.
import {defaultProfile, sessions, setDefaultProfile} from '../auth.mjs';
import {AuthError} from '../errors.mjs';
import {localTime, paint, table} from '../format.mjs';
import {program} from '../program.mjs';

const profiles = (ctx) => {
  const byDefault = defaultProfile(ctx.env);
  return sessions(ctx.env).map((s) => ({
    email: s.email,
    default: s.email === byDefault,
    tokenValidUntil: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
    expired: s.expiresAt <= ctx.now,
  }));
};

export const groups = {
  profile: {
    summary: 'your profiles (the e-mails you are logged in with) and the default one',
    commands: {
      list: {
        summary: 'your profiles; * marks the default one',
        get usage() {
          return `${program.name} profile list`;
        },
        options: {},
        args: [0, 0],
        run: (ctx) => ({profiles: profiles(ctx)}),
        text(r, ctx) {
          if (!r.profiles.length) return `Not logged in. Run: ${program.name} login <e-mail>`;
          const c = paint(ctx);
          const lines = table(
            r.profiles.map((p) => [
              p.default ? '*' : ' ',
              p.email,
              p.expired ? c.dim('token renewed on next use') : `token valid until ${localTime(p.tokenValidUntil)}`,
            ]),
          );
          if (r.profiles.length > 1 && !r.profiles.some((p) => p.default))
            lines.push(c.yellow(`No default profile: set one with ${program.name} profile use <e-mail>`));
          return lines;
        },
      },
      use: {
        summary: 'make a profile the default one (used when no --profile is given)',
        get usage() {
          return `${program.name} profile use <e-mail>`;
        },
        options: {},
        args: [1, 1],
        complete: 'profiles',
        run(ctx) {
          const wanted = ctx.positionals[0];
          const found = sessions(ctx.env).find((s) => s.email.toLowerCase() === wanted.toLowerCase());
          if (!found) throw new AuthError(`No profile ${wanted}: log in first: ${program.name} login ${wanted}`);
          setDefaultProfile(found.email, ctx.env);
          return {defaultProfile: found.email};
        },
        text: (r) => `Default profile: ${r.defaultProfile}`,
      },
    },
  },
};
