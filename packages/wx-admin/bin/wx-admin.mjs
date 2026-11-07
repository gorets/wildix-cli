#!/usr/bin/env node
import {main} from '../src/cli.mjs';

// exitCode, never process.exit(): an exit right after a write cuts piped output.
process.exitCode = await main(process.argv.slice(2));
