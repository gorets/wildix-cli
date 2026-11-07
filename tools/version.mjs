#!/usr/bin/env node
// Sets one version in the three packages and in the "**Version X**" line of the READMEs of the command lines:
//   node tools/version.mjs 1.2.0
// Then add the CHANGELOG entries, commit, tag vX.Y.Z and push the tag (AGENTS.md, Release).
import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node tools/version.mjs X.Y.Z');
  process.exit(64);
}
const root = path.resolve(import.meta.dirname, '..');
for (const dir of ['core', 'wx', 'wx-admin']) {
  const file = path.join(root, 'packages', dir, 'package.json');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/^( {2}"version": )"[^"]+"/m, `$1"${version}"`));
  const readme = path.join(root, 'packages', dir, 'README.md');
  if (fs.existsSync(readme))
    fs.writeFileSync(
      readme,
      fs.readFileSync(readme, 'utf8').replace(/^\*\*Version [^*]+\*\*/m, `**Version ${version}**`),
    );
  console.log(`${dir}: ${version}`);
}
