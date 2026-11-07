// What a command line adds to the core through its spec: global options (taken anywhere, given to the command in
// ctx), values for completion, a wrapper around run(), lines of the main help; and the program name everywhere.
import assert from 'node:assert/strict';
import {test} from 'node:test';
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
