#!/usr/bin/env node
// Runs commands that are not listed in src/commands/index.mjs yet, against the real services, for development:
//   node test/dev.mjs <module> <args of wx...>
// The module (path from the repository root) default-exports {groups?, commands?} or named exports `groups` and
// `commands`; they are added to the listed ones. Example:
//   node test/dev.mjs src/commands/calls.mjs calls list --limit 5
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SPEC, main} from '../src/cli.mjs';

const [modulePath, ...args] = process.argv.slice(2);
if (!modulePath) {
  console.error('usage: node test/dev.mjs <module> <args of wx...>');
  process.exit(64);
}
const mod = await import(pathToFileURL(path.resolve(modulePath)).href);
const extra = mod.default && (mod.default.groups || mod.default.commands) ? mod.default : mod;
const registry = {
  groups: {...SPEC.groups, ...(extra.groups ?? {})},
  commands: {...SPEC.commands, ...(extra.commands ?? {})},
};
process.exitCode = await main(args, {registry});
