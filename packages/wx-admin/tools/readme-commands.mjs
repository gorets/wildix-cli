#!/usr/bin/env node
// Prints the command reference of the README from the definitions of the commands (usage and summary of each), so
// the README follows the code. test/readme.test.mjs checks that every usage line is in the README.
//   node tools/readme-commands.mjs > /tmp/commands.md   then paste it between the markers of README.md
import {SPEC} from '../src/cli.mjs';

const {groups: GROUPS, commands: COMMANDS} = SPEC;

const cell = (s) => String(s).replace(/\|/g, '\\|');
const out = [];
for (const [name, g] of Object.entries(GROUPS)) {
  out.push(
    `### wx-admin ${name}`,
    '',
    `${g.summary[0].toUpperCase()}${g.summary.slice(1)}.`,
    '',
    '| Command | What it does |',
    '| --- | --- |',
  );
  for (const cmd of Object.values(g.commands)) out.push(`| \`${cell(cmd.usage)}\` | ${cell(cmd.summary)} |`);
  out.push('');
}
out.push('### Login and profiles', '', '| Command | What it does |', '| --- | --- |');
for (const cmd of Object.values(COMMANDS)) out.push(`| \`${cell(cmd.usage)}\` | ${cell(cmd.summary)} |`);
out.push(
  '| `wx-admin completion [bash\\|zsh\\|fish]` | the shell completion script (default: the shell of `$SHELL`) |',
);
process.stdout.write(`${out.join('\n')}\n`);
