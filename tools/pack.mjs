#!/usr/bin/env node
// Packs the three packages into dist/ with pnpm (which writes the exact version of wldx-core in place of
// "workspace:*") and checks what goes out: one version for all, the dependency on that very version, only bin/,
// src/, the README, the license and package.json in the tarballs. The release publishes these tarballs.
//   node tools/pack.mjs            (pnpm run pack)
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const PACKAGES = ['core', 'wx', 'wx-admin'];
const ALLOWED =
  /^package\/(package\.json|README\.md|LICENSE|CHANGELOG\.md|bin\/.+\.mjs|src\/.+\.mjs|specs\/[a-z-]+\.openapi\.json)$/;

fs.rmSync(dist, {recursive: true, force: true});
fs.mkdirSync(dist);
const manifests = PACKAGES.map((dir) =>
  JSON.parse(fs.readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8')),
);
const versions = new Set(manifests.map((m) => m.version));
if (versions.size !== 1)
  throw new Error(`The packages must have one version: ${manifests.map((m) => `${m.name}@${m.version}`).join(', ')}`);
const [version] = versions;

for (const [i, dir] of PACKAGES.entries()) {
  const m = manifests[i];
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(root, 'packages', dir, 'LICENSE'));
  execFileSync('pnpm', ['pack', '--pack-destination', dist], {
    cwd: path.join(root, 'packages', dir),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const file = path.join(dist, `${m.name}-${version}.tgz`);
  const list = execFileSync('tar', ['-tzf', file], {encoding: 'utf8'}).trim().split('\n');
  const stray = list.filter((f) => !ALLOWED.test(f));
  if (stray.length) throw new Error(`${m.name}: unexpected files in the tarball: ${stray.join(', ')}`);
  const packed = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], {encoding: 'utf8'}));
  for (const [name, range] of Object.entries(packed.dependencies ?? {})) {
    if (name === 'wldx-core' && range !== version)
      throw new Error(`${m.name}: depends on wldx-core ${range}, not ${version}`);
    if (name !== 'wldx-core') throw new Error(`${m.name}: an unexpected dependency ${name}`);
  }
  console.log(`${path.relative(root, file)}  ${list.length} files`);
}
