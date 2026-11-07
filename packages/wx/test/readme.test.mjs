import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {SPEC} from '../src/cli.mjs';

const {groups: GROUPS, commands: COMMANDS} = SPEC;

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const cell = (s) => s.replace(/\|/g, '\\|');

test('the README lists every command with its usage (node tools/readme-commands.mjs)', () => {
  const usages = [...Object.values(GROUPS).flatMap((g) => Object.values(g.commands)), ...Object.values(COMMANDS)].map(
    (c) => c.usage,
  );
  const missing = usages.filter((u) => !readme.includes(`\`${cell(u)}\``));
  assert.deepEqual(missing, []);
});

test('every command has a summary, a usage that starts with its name, and options with a description', () => {
  for (const [group, g] of Object.entries(GROUPS)) {
    for (const [name, c] of Object.entries(g.commands)) {
      assert.ok(c.summary, `${group} ${name}: summary`);
      assert.ok(c.usage.startsWith(`wx ${group} ${name}`), `${group} ${name}: usage ${c.usage}`);
      for (const [o, def] of Object.entries(c.options ?? {}))
        assert.ok(def.description, `${group} ${name} --${o}: description`);
      assert.ok(
        !['output', 'pretty', 'no-color', 'account', 'profile'].some((o) => Object.hasOwn(c.options ?? {}, o)),
        `${group} ${name}: a global option name`,
      );
      assert.ok(Array.isArray(c.args) && c.args.length === 2, `${group} ${name}: args`);
    }
  }
});
