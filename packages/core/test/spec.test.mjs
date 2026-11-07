// What a command line adds to the core through its spec: global options (taken anywhere, given to the command in
// ctx), values for completion, a wrapper around run(), lines of the main help; and the program name everywhere.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMain} from '../src/cli.mjs';
import {complete, completionScript, completionUsage} from '../src/completion.mjs';
import {program, setProgram} from '../src/program.mjs';
import {SPEC, run, tempConfigDir} from './helpers.mjs';

const seen = [];
const show = {
  summary: 'shows its context',
  usage: 'wx show',
  options: {},
  args: [0, 0],
  run: (ctx) => ({site: ctx.site ?? null, everywhere: ctx.everywhere ?? null}),
};
const EXT = {
  groups: {},
  commands: {
    show,
    pick: {
      summary: 'takes a site',
      usage: 'wx pick <site>',
      options: {},
      args: [1, 1],
      complete: 'sites',
      run: () => ({}),
    },
  },
  globals: {
    site: {type: 'string', placeholder: 'SITE', needs: 'a site name', description: 'the site', complete: 'sites'},
    everywhere: {type: 'boolean', description: 'on every site'},
  },
  help: {options: ['  --site SITE         the site'], exitCodes: 'Exit codes: as you like.'},
  completers: {sites: () => [['north', 'the first'], ['south']]},
  around: async (cmd, ctx, io, runIt) => {
    seen.push(cmd.usage);
    if (!ctx.everywhere) return runIt();
    for (const site of ['north', 'south']) await runIt({...ctx, site});
  },
};

test('own global options stand anywhere and reach the command; the wrapper runs it', async () => {
  let r = await run(['show', '--site', 'north'], {registry: EXT});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {site: 'north', everywhere: null});
  r = await run(['--everywhere', 'show'], {registry: EXT});
  assert.deepEqual(
    r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).site),
    ['north', 'south'],
  );
  assert.deepEqual(seen, ['wx show', 'wx show']);
  r = await run(['show', '--site'], {registry: EXT});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /--site needs a site name/);
  r = await run(['show', '--site', 'a', '--site', 'b'], {registry: EXT});
  assert.match(r.stderr, /--site given twice: a and b/);
});

test('the main help carries the lines of the spec', async () => {
  const r = await run([], {registry: EXT, output: 'text'});
  assert.match(r.stdout, /--site SITE {9}the site/);
  assert.match(r.stdout, /Exit codes: as you like\./);
  assert.match(r.stdout, /Without installing: npx wldx-cli <command>/);
});

test('completion offers the values of the completers for options and commands', () => {
  const spec = {...SPEC, ...EXT};
  assert.deepEqual(complete(['--site', ''], {}, spec), ['north\tthe first', 'south']);
  assert.deepEqual(complete(['pick', 's'], {}, spec), ['south']);
  assert.ok(complete(['--'], {}, spec).includes('--site\tthe site'));
  assert.deepEqual(complete(['--site', 'north', 'sh'], {}, spec), ['show\tshows its context']);
});

test('the program name is in the scripts, the help and the messages', async () => {
  const before = {...program};
  try {
    setProgram({name: 'wx-admin', pkg: 'wldx-admin-cli', version: '1.2.3'});
    for (const shell of ['bash', 'zsh', 'fish']) {
      const script = completionScript(shell);
      assert.doesNotMatch(script.replace(/wx-admin/g, ''), /\bwx\b/, shell);
    }
    assert.match(completionScript('bash'), /complete -F _wx_admin_complete wx-admin/);
    assert.match(completionScript('fish'), /\(wx-admin __complete --/);
    assert.match(completionUsage(), /npm i -g wldx-admin-cli/);
    const r = await run(['status'], {output: 'text', env: {WILDIX_CONFIG_DIR: tempConfigDir()}});
    assert.match(r.stdout, /^wx-admin\s+1\.2\.3/m);
    assert.match(r.stdout, /Log in with: wx-admin login <e-mail>/);
    assert.equal((await run(['--version'])).stdout, '1.2.3\n');
    assert.match((await run(['login', '-h'], {output: 'text'})).stdout, /^Usage: wx-admin login/m);
  } finally {
    setProgram(before);
  }
});

test('a global option with key reaches ctx under that key; ctx.env stays the environment', async () => {
  const show = {
    summary: 's',
    usage: 'wx show',
    options: {},
    args: [0, 0],
    run: (ctx) => ({cloudEnv: ctx.cloudEnv ?? null, hasEnv: typeof ctx.env === 'object'}),
  };
  const registry = {
    groups: {},
    commands: {show},
    globals: {env: {type: 'string', choices: ['prod', 'stage'], key: 'cloudEnv', description: 'e'}},
  };
  const r = await run(['show', '--env', 'stage'], {registry});
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {cloudEnv: 'stage', hasEnv: true});
  assert.deepEqual(JSON.parse((await run(['--env=prod', 'show'], {registry})).stdout), {
    cloudEnv: 'prod',
    hasEnv: true,
  });
  assert.equal((await run(['show', '--env', 'other'], {registry})).code, 64);
});

test('a global option whose context key would be a reserved name (env) is refused when the program is made', () => {
  assert.throws(() => createMain({groups: {}, commands: {}, globals: {env: {type: 'string'}}}), /env.*key/);
  assert.doesNotThrow(() => createMain({groups: {}, commands: {}, globals: {env: {type: 'string', key: 'cloudEnv'}}}));
});

test('a group may hold a group: three words name a command; help, errors and completion follow', async () => {
  const list = {
    summary: 'the sources',
    usage: 'wx kb source list',
    options: {all: {type: 'boolean', description: 'a'}},
    args: [0, 0],
    run: () => ({listed: true}),
  };
  const registry = {
    groups: {
      kb: {
        summary: 'knowledge',
        commands: {
          get: {summary: 'one', usage: 'wx kb get', options: {}, args: [0, 0], run: () => ({got: true})},
          source: {summary: 'data sources', commands: {list}},
        },
      },
    },
    commands: {},
  };
  assert.deepEqual(JSON.parse((await run(['kb', 'source', 'list'], {registry})).stdout), {listed: true});
  assert.deepEqual(JSON.parse((await run(['kb', 'get'], {registry})).stdout), {got: true});
  let r = await run(['kb', 'source'], {registry, output: 'text'});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /wx kb source needs a command/);
  assert.match(r.stderr, /wx kb source list/);
  r = await run(['kb', 'source', 'nope'], {registry});
  assert.match(r.stderr, /^wx: Unknown command: kb source nope$/m);
  r = await run(['kb', '-h'], {registry, output: 'text'});
  assert.match(r.stdout, /wx kb source list/);
  const spec = {...SPEC, ...registry};
  assert.deepEqual(complete(['kb', 's'], {}, spec), ['source\tdata sources']);
  assert.deepEqual(complete(['kb', 'source', ''], {}, spec), ['list\tthe sources']);
  assert.ok(complete(['kb', 'source', 'list', '--'], {}, spec).includes('--all\ta'));
});

test('profiles: false — no --profile in the help, completion or parsing, and no x-bees token in ctx', async () => {
  let seenCtx;
  const look = {
    summary: 'looks at its context',
    usage: 'wx look',
    options: {},
    args: [0, 0],
    run: (ctx) => {
      seenCtx = ctx;
      return {};
    },
  };
  const registry = {groups: {}, commands: {look}, profiles: false};
  const help = await run([], {registry, output: 'text'});
  assert.doesNotMatch(help.stdout, /--profile/);
  assert.equal((await run(['look', '--profile', 'a@b.c'], {registry})).code, 64);
  assert.equal((await run(['look'], {registry})).code, 0);
  assert.ok(!('freshToken' in seenCtx) && !('token' in seenCtx) && !('profile' in seenCtx));
  assert.ok(!complete(['--'], {}, {...SPEC, ...registry}).some((w) => w.startsWith('--profile')));
  assert.doesNotMatch((await run(['look', '-h'], {registry, output: 'text'})).stdout, /--profile/);
});

test('profiles: false refuses a command that needs the x-bees login when the program is made', () => {
  const needs = {summary: 's', usage: 'wx n', options: {}, args: [0, 0], auth: true, run: () => ({})};
  assert.throws(() => createMain({groups: {}, commands: {n: needs}, profiles: false}), /auth/);
});

test('Unknown command names the program once', async () => {
  const registry = {groups: {g: {summary: 'g', commands: {a: show}}}, commands: {}};
  const r = await run(['g', 'nope'], {registry, output: 'text'});
  assert.equal(r.code, 64);
  assert.match(r.stderr, /^wx: Unknown command: g nope$/m);
});
