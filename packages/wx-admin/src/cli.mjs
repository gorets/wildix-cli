// wx-admin: the spec of the command line on the router of wldx-core: its commands, the global options --pbx and
// --all-pbx, the completion of PBX names, and --all-pbx itself (a command that reads, run once per PBX).
import {createMain, line, render} from 'wldx-core/cli';
import {complete as completeOf} from 'wldx-core/completion';
import {AuthError, UsageError} from 'wldx-core/errors';
import {clean, paint} from 'wldx-core/format';
import {program, setProgram} from 'wldx-core/program';
import {COMMANDS, GLOBAL_OPTIONS, GROUPS} from './commands/index.mjs';
import {SPEC_SERVICES} from './cloud/env.mjs';
import {savedPbxs} from './pbx.mjs';
import {VERSION} from './version.mjs';

setProgram({name: 'wx-admin', pkg: 'wldx-admin-cli', version: VERSION});

// --all-pbx: a command that only reads runs once per PBX with saved access and every
// result is printed under its PBX; a PBX that fails does not stop the others. JSON: {results: [{pbx, result} |
// {pbx, error}]}. Exit 1 when one failed.
async function runOnAllPbx(cmd, ctx, io) {
  if (!cmd.readOnly)
    throw new UsageError(
      '--all-pbx runs only commands that read (a change on every PBX at once is too easy to get wrong)',
      ctx.usage(),
    );
  if (ctx.pbx) throw new UsageError('Give --pbx or --all-pbx, not both');
  if (io.env.WILDIX_PBX_API_KEY)
    throw new UsageError('--all-pbx is refused while WILDIX_PBX_API_KEY is set: that key is for one PBX only');
  const hosts = savedPbxs(io.env).map((p) => p.host);
  if (!hosts.length) throw new AuthError(`No PBX: sign in to one (${program.name} login <host>)`);
  const results = [];
  for (const pbx of hosts) {
    try {
      const result = await cmd.run({...ctx, pbx});
      results.push({pbx, result});
      if (ctx.output !== 'json') line(io.stdout, `${paint(ctx).bold(`== ${pbx}`)}\n${render(result, cmd.text, ctx)}`);
    } catch (e) {
      results.push({pbx, error: e.message});
      if (ctx.output !== 'json')
        line(io.stdout, `${paint(ctx).bold(`== ${pbx}`)}\n${paint(ctx).red(clean(e.message))}`);
    }
  }
  if (ctx.output === 'json') line(io.stdout, JSON.stringify({results}, null, io.globals.pretty ? 2 : 0));
  if (results.some((r) => r.error)) {
    const err = new Error(`${results.filter((r) => r.error).length} of ${results.length} PBX failed`);
    err.exitCode = 1;
    throw err;
  }
}

export const SPEC = {
  profiles: false, // PBX access only: no x-bees login, no --profile
  groups: GROUPS,
  commands: COMMANDS,
  globals: GLOBAL_OPTIONS,
  help: {
    options: [
      '  --pbx PBX           the PBX: name.wildixin.com, name, an IP, or the serial of a known PBX; else the',
      '                      default one (wx-admin pbx use), else the only one signed in to',
      '  --all-pbx           run a command that reads on every PBX signed in to',
      "  --env ENV           the environment of the cloud services: prod, stable or stage (default: the PBX's)",
    ],
    exitCodes: 'Exit codes: 0 done, 1 error, 2 not logged in or the access was refused, 64 wrong usage.',
  },
  // The PBX with saved access, by host and by serial.
  completers: {
    cloudServices: () => Object.entries(SPEC_SERVICES).map(([name, s]) => [name, s.label]),
    pbxs: (env) => savedPbxs(env).flatMap((p) => [[p.host, p.auth], ...(p.serial ? [[p.serial, p.host]] : [])]),
  },
  around: (cmd, ctx, io, run) => (ctx.allPbx ? runOnAllPbx(cmd, ctx, io) : run()),
};

export const main = createMain(SPEC);
export const complete = (words, env = process.env) => completeOf(words, env, SPEC);
