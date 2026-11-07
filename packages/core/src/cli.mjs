// The router: `<program> <group> <command> [options]` and `<program> <command> [options]`, for the commands of a
// spec (src/registry.mjs). What run() returns is printed on stdout: as text by default (the command's text()
// formatter, else toText()), as JSON with --output json (--pretty indents it). A streaming command prints one
// line per event with ctx.emit() (text, or one JSON object per line) and returns nothing. Like the internal Wildix
// CLI, the global options (--output, --pretty, --no-color, --profile and those of the spec) may stand anywhere.
//
// The context of run():
//   values, positionals     parsed options and arguments
//   token                   a valid IdToken when the command needs auth (undefined otherwise)
//   freshToken()            a valid IdToken again (renewed when it expired): for long-running commands
//   profile                 the --profile value (or undefined)
//   <global>                the value of each global option of the spec, camel-cased (--all-pbx: ctx.allPbx)
//   client(factory)         factory({token, env, fetchImpl}): a service client bound to the token
//   emit(data)              print one JSON line on stdout now (streaming commands)
//   info(text)              print a line for the person on stderr (progress, prompts); never data
//   signal                  aborted on Ctrl-C / SIGTERM: long-running commands stop and return
//   output ('text'|'json'), color (colors allowed)
//   env, stdin, stdout, stderr, fetch, WebSocket, now (ms at the start), clock() (ms now), cwd
import path from 'node:path';
import {parseArgs} from 'node:util';
import {getToken} from './auth.mjs';
import {SHELLS, TOP_LEVEL, complete, completionScript, completionUsage} from './completion.mjs';
import {AuthError, UsageError} from './errors.mjs';
import {clean, toText} from './format.mjs';
import {program} from './program.mjs';
import {
  COMMON_OPTIONS,
  GLOBAL_OPTIONS,
  commandOf,
  commandsOf,
  globalsOf,
  groupOf,
  isGroup,
  singleOf,
} from './registry.mjs';
import {startUpdateCheck} from './update.mjs';

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// Takes the global options out of the arguments, wherever they stand (up to a "--"). A string option given twice
// with different values is refused (except one with choices: the last one counts).
export function takeGlobals(argv, globals = GLOBAL_OPTIONS) {
  const g = {output: 'text', pretty: false, color: true};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    const name = a.startsWith('--') ? a.slice(2).split('=')[0] : undefined;
    const o = name !== undefined && Object.hasOwn(globals, name) ? globals[name] : undefined;
    if (!o || (o.type === 'boolean' && a !== `--${name}`)) {
      rest.push(a);
      continue;
    }
    if (o.type === 'boolean') {
      if (name === 'no-color') g.color = false;
      else g[o.key ?? camel(name)] = true;
      continue;
    }
    const value = a === `--${name}` ? argv[(i += 1)] : a.slice(name.length + 3);
    if (o.choices) {
      if (!o.choices.includes(value))
        throw new UsageError(
          `--${name} must be one of ${o.choices.join(', ')}${value === undefined ? '' : `: ${value}`}`,
        );
    } else {
      if (!value || value.startsWith('--')) throw new UsageError(`--${name} needs ${o.needs ?? 'a value'}`);
      const before = g[o.key ?? camel(name)];
      if (before !== undefined && before.toLowerCase() !== value.toLowerCase())
        throw new UsageError(`--${name} given twice: ${before} and ${value}`);
    }
    g[o.key ?? camel(name)] = value;
  }
  return {globals: g, rest};
}

// The text (or JSON) of a result, ready to print: terminal escapes taken out of the text.
export function render(data, formatter, ctx, pretty) {
  if (ctx.output === 'json') return JSON.stringify(data, null, pretty ? 2 : 0);
  const t = formatter ? formatter(data, ctx) : toText(data);
  return clean(Array.isArray(t) ? t.join('\n') : String(t ?? ''));
}

export function line(stream, text) {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

function mainUsage(spec) {
  return [
    `Usage: ${program.name} <command> [options]`,
    '',
    'Commands:',
    ...Object.entries(spec.groups).map(([name, g]) => `  ${pad(name, 14)}${g.summary}`),
    ...Object.entries(spec.commands).map(([name, c]) => `  ${pad(name, 14)}${c.summary}`),
    ...Object.entries(TOP_LEVEL).map(([name, summary]) => `  ${pad(name, 14)}${summary}`),
    '',
    'Options:',
    '  --output text|json  text for people (default), JSON for scripts and agents',
    '  --pretty            indent the JSON',
    '  --no-color          no colors in the text',
    ...(spec.help?.options ?? []),
    ...(spec.profiles === false
      ? []
      : ['  --profile EMAIL     the profile (a logged-in e-mail) to use; else WILDIX_EMAIL, else the default']),
    `  -h, --help          help of ${program.name}, a command or a subcommand`,
    `  -v, --version       the version of ${program.name}`,
    '',
    spec.help?.exitCodes ?? 'Exit codes: 0 done, 1 error, 2 not logged in, 64 wrong usage.',
    `Without installing: npx ${program.pkg} <command>`,
  ].join('\n');
}

function groupUsage(name, g) {
  return [
    `Usage: ${program.name} ${name} <command> [options]`,
    '',
    ...commandsOf(g).flatMap((cmd) => [`  ${cmd.usage}`, `      ${cmd.summary}`]),
  ].join('\n');
}

function commandUsage(cmd, spec) {
  const options = Object.entries({...cmd.options, ...COMMON_OPTIONS, ...globalsOf(spec)}).map(([name, o]) => {
    const value = o.choices && o.choices.length <= 8 ? o.choices.join('|') : (o.placeholder ?? 'VALUE');
    const flag = `${o.short ? `-${o.short}, ` : ''}--${name}${o.type === 'string' ? ` ${value}` : ''}`;
    const values = o.choices && o.choices.length > 8 ? ` (one of: ${o.choices.join(', ')})` : '';
    return `  ${pad(flag, 34)}${o.description ?? ''}${o.multiple ? ' (repeatable)' : ''}${values}`;
  });
  return [
    `Usage: ${cmd.usage}`,
    '',
    cmd.summary,
    ...(cmd.details ? ['', cmd.details] : []),
    '',
    'Options:',
    ...options,
  ].join('\n');
}

function completion(args, io) {
  if (args.includes('-h') || args.includes('--help')) return line(io.stdout, completionUsage());
  if (args.length > 1) throw new UsageError(`${program.name} completion takes one shell`, completionUsage());
  const shell = args[0] ?? path.basename(io.env.SHELL ?? '');
  const script = completionScript(shell);
  if (!script)
    throw new UsageError(`No completion for the shell "${shell}": give one of ${SHELLS.join(', ')}`, completionUsage());
  line(io.stdout, script);
}

// Ctrl-C and SIGTERM abort ctx.signal once; a second Ctrl-C leaves it to Node (exit).
function stopSignal(io) {
  if (io.signal) return {signal: io.signal, dispose() {}};
  const controller = new AbortController();
  const onSignal = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {signal: controller.signal, dispose: onSignal};
}

async function runCommand(cmd, args, needsAuth, io) {
  const {spec} = io;
  const options = {...COMMON_OPTIONS, ...cmd.options};
  let parsed;
  try {
    parsed = parseArgs({args, options, allowPositionals: true, strict: true});
  } catch (e) {
    if (String(e.code).startsWith('ERR_PARSE_ARGS')) throw new UsageError(e.message, commandUsage(cmd, spec));
    throw e;
  }
  const {values, positionals} = parsed;
  if (values.help) return line(io.stdout, commandUsage(cmd, spec));
  if (io.globals.profile !== undefined) values.profile = io.globals.profile;
  for (const [name, o] of Object.entries(options)) {
    const given = values[name] === undefined ? [] : [values[name]].flat();
    const bad = o.choices && given.find((v) => !o.choices.includes(v));
    if (bad !== undefined)
      throw new UsageError(`--${name} must be one of ${o.choices.join(', ')}: ${bad}`, commandUsage(cmd, spec));
  }
  const [min, max] = cmd.args;
  if (positionals.length < min || positionals.length > max) {
    throw new UsageError(
      positionals.length < min ? 'Missing arguments' : `Unexpected argument: ${positionals[max]}`,
      commandUsage(cmd, spec),
    );
  }

  const profiles = spec.profiles !== false;
  const freshToken = () => getToken({profile: values.profile, env: io.env, fetchImpl: io.fetch, now: io.now()});
  const token = profiles && needsAuth ? await freshToken() : undefined;
  const stop = stopSignal(io);
  const own = Object.fromEntries(
    Object.entries(spec.globals ?? {}).map(([name, o]) => [o.key ?? camel(name), io.globals[o.key ?? camel(name)]]),
  );
  const ctx = {
    ...own,
    values,
    positionals,
    ...(profiles ? {token, freshToken, profile: values.profile} : {}),
    client: (factory) => factory({token, env: io.env, fetchImpl: io.fetch}),
    output: io.globals.output,
    color: io.globals.color && !io.env.NO_COLOR && Boolean(io.stdout.isTTY),
    emit: (data) => {
      const text = io.globals.output === 'json' ? JSON.stringify(data) : render(data, cmd.textEvent ?? cmd.text, ctx);
      if (text) line(io.stdout, text);
    },
    info: (text) => line(io.stderr, clean(text)),
    signal: stop.signal,
    usage: () => commandUsage(cmd, spec),
    env: io.env,
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    fetch: io.fetch,
    WebSocket: io.WebSocket, // only when injected (tests); a command falls back to globalThis.WebSocket
    now: io.now(),
    clock: io.now,
    cwd: io.cwd,
  };
  const run = async (c = ctx) => {
    const result = await cmd.run(c);
    if (result !== undefined) {
      const text = render(result, cmd.text, c, io.globals.pretty);
      if (text) line(io.stdout, text);
    }
  };
  try {
    await (spec.around ? spec.around(cmd, ctx, io, run) : run());
  } finally {
    stop.dispose();
  }
}

async function dispatch(all, io) {
  const {spec} = io;
  const {globals, rest: argv} = takeGlobals(all, globalsOf(spec));
  io.globals = globals;
  const [first, sub, ...rest] = argv;
  if (!first || first === '-h' || first === '--help' || first === 'help') return line(io.stdout, mainUsage(spec));
  if (first === '-v' || first === '--version') return line(io.stdout, program.version);
  if (first === '__complete') {
    const out = complete(argv.slice(sub === '--' ? 2 : 1), io.env, spec);
    if (out.length) line(io.stdout, out.join('\n'));
    return;
  }
  if (first === 'completion') return completion(argv.slice(1), io);

  const single = singleOf(first, spec);
  if (single) return runCommand(single, argv.slice(1), Boolean(single.auth), io);

  const group = groupOf(first, spec);
  if (!group) throw new UsageError(`Unknown command: ${first}`, mainUsage(spec));
  if (sub === '-h' || sub === '--help') return line(io.stdout, groupUsage(first, group));
  if (!sub) throw new UsageError(`${program.name} ${first} needs a command`, groupUsage(first, group));
  const cmd = commandOf(group, sub);
  if (!cmd) throw new UsageError(`Unknown command: ${first} ${sub}`, groupUsage(first, group));
  if (isGroup(cmd)) {
    const [third, ...more] = rest;
    const name = `${first} ${sub}`;
    if (third === '-h' || third === '--help') return line(io.stdout, groupUsage(name, cmd));
    if (!third) throw new UsageError(`${program.name} ${name} needs a command`, groupUsage(name, cmd));
    const inner = commandOf(cmd, third);
    if (!inner || isGroup(inner)) throw new UsageError(`Unknown command: ${name} ${third}`, groupUsage(name, cmd));
    return runCommand(inner, more, Boolean(inner.auth ?? cmd.auth ?? group.auth), io);
  }
  return runCommand(cmd, rest, Boolean(cmd.auth ?? group.auth), io);
}

// main(argv, io) runs the program of the spec with the arguments and returns the exit code: 0 done, 1 error, 2 not
// logged in (or the access was refused), 3 nothing to show (an error with exitCode 3), 64 wrong usage.
// io replaces the process streams, environment, fetch, clock and (in tests) the commands themselves:
// io.registry = {groups, commands} takes the place of those of the spec.
// Context keys a global option may not take: the context has its own fields of these names.
const RESERVED = new Set([
  'env',
  'values',
  'positionals',
  'token',
  'profile',
  'output',
  'color',
  'signal',
  'stdin',
  'stdout',
  'stderr',
  'fetch',
  'now',
  'cwd',
]);

export function createMain(spec) {
  for (const [name, o] of Object.entries(spec.globals ?? {})) {
    const key = o.key ?? camel(name);
    if (RESERVED.has(key))
      throw new Error(`The global option --${name} would be ctx.${key}, a field of the context: give it a key`);
  }
  if (spec.profiles === false) {
    const needing = [
      ...Object.entries(spec.commands ?? {}).filter(([, c]) => c.auth),
      ...Object.entries(spec.groups ?? {}).filter(([, g]) => g.auth || commandsOf(g).some((c) => c.auth)),
    ].map(([n]) => n);
    if (needing.length)
      throw new Error(`profiles: false, but these need the x-bees login (auth): ${needing.join(', ')}`);
  }
  return async function main(argv, io = {}) {
    io = {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      env: process.env,
      fetch: globalThis.fetch,
      now: Date.now,
      cwd: process.cwd(),
      ...io,
    };
    io.spec = io.registry ? {...spec, ...io.registry} : spec;
    const update = startUpdateCheck(argv, io); // a newer version on npm: one line after the command
    const code = await run(argv, io);
    await update.finish();
    return code;
  };
}

// The command, its errors turned into the exit code: 0 done, 1 error, 2 not logged in, 3 nothing to show, 64 usage.
async function run(argv, io) {
  try {
    await dispatch(argv, io);
    return 0;
  } catch (e) {
    line(io.stderr, `${program.name}: ${clean(e.message)}`);
    if (e instanceof UsageError) {
      if (e.usage) line(io.stderr, `\n${e.usage}`);
      return 64;
    }
    if (e instanceof AuthError) return 2;
    if (Number.isInteger(e.exitCode)) return e.exitCode;
    if (io.env.WX_DEBUG === '1' && e.stack) line(io.stderr, e.stack);
    return 1;
  }
}
