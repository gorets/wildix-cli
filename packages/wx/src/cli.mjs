// wx: the spec of the command line (its commands, its lines in the help) on the router of wldx-core.
import {createMain} from 'wldx-core/cli';
import {complete as completeOf} from 'wldx-core/completion';
import {setProgram} from 'wldx-core/program';
import {COMMANDS, GROUPS} from './commands/index.mjs';
import {VERSION} from './version.mjs';

setProgram({name: 'wx', pkg: 'wldx-cli', version: VERSION});

export const SPEC = {
  groups: GROUPS,
  commands: COMMANDS,
  help: {exitCodes: 'Exit codes: 0 done, 1 error, 2 not logged in, 3 nothing to show (no transcript), 64 wrong usage.'},
};

export const main = createMain(SPEC);
export const complete = (words, env = process.env) => completeOf(words, env, SPEC);
