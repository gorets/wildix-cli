# Wildix command lines — `wx` and `wx-admin`

Unofficial command lines for Wildix, MIT. Not made or supported by Wildix.

| Command | npm | For | |
| --- | --- | --- | --- |
| `wx` | [`wldx-cli`](https://www.npmjs.com/package/wldx-cli) | everyone: chats, calls and meetings on record, queue reports, what is going on now, your phone; acts as you | [README](packages/wx/README.md) |
| `wx-admin` | [`wldx-admin-cli`](https://www.npmjs.com/package/wldx-admin-cli) | PBX administrators, no x-bees account needed (a Company API Key, or the WMS login and password with 2FA): the PBX REST API, several PBX at once, configuration as files and moved to another PBX, the cloud services of the company (knowledge base, voicebots, WIM tools, Wilma) | [README](packages/wx-admin/README.md) |

```sh
npm i -g wldx-cli          # wx
npm i -g wldx-admin-cli    # wx-admin
npx wldx-cli --help        # without installing
```

`wx` signs in with the x-bees login (`wx login`, a code by e-mail; the same sessions in `~/.wildix/tokens` as the
Wildix agent skills). `wx-admin` signs in to the PBX itself (`wx-admin login mypbx`: a Company API Key, or the WMS login
and password of an administrator); it needs no x-bees account. Both share the output (text for people,
`--output json` for scripts and agents), prompts and shell completion. That shared part is the third package, [`wldx-core`](packages/core), on which both depend at the same
version. Node.js 22 or newer; no other dependencies.

## Development

A pnpm workspace:

```
packages/core       wldx-core       router, output, completion, login and profiles, file checks, HTTP
packages/wx         wldx-cli        the commands of wx
packages/wx-admin   wldx-admin-cli  the commands of wx-admin
tools/              pack.mjs (the tarballs of a release, checked), version.mjs (one version everywhere)
```

```sh
pnpm install          # links the core into both command lines
pnpm test             # the tests of the three packages: node:test, no network
pnpm lint             # Biome (biome.json): formatting and the linter, without changing files; a warning fails too
pnpm format           # Biome formats the code (120 columns)
pnpm run check        # lint, tests, then the tarballs in dist/ as they would be published
node packages/wx/bin/wx.mjs status
```

Rules for changes (and for AI agents that make them): [AGENTS.md](AGENTS.md), and the `AGENTS.md` of each package.

## Releasing

The three packages are released together with one version; a command line depends on the core of exactly its
version.

1. `node tools/version.mjs X.Y.Z` (the three `package.json` and the version line of their READMEs), a `CHANGELOG.md`
   entry in each package that changed.
2. Commit, tag `vX.Y.Z`, push the tag: `.github/workflows/release.yml` checks the versions against the tag, runs the
   tests, packs the tarballs and **stages** each package with provenance through npm trusted publishing (no npm
   token in the repository). A version that is already on npm is skipped.
3. Approve with 2FA, the core first: `npm stage list wldx-core`, `npm stage approve <stage-id>`, then the same for
   `wldx-cli` and `wldx-admin-cli` (`npm stage download <stage-id>` to look at a tarball first).

The trusted publisher of each package on npmjs.com (package settings → Trusted publishing): GitHub Actions,
`gorets/wildix-cli`, workflow `release.yml`, permission "npm stage publish". A trusted publisher can be configured
only for a package that exists, so the first version of a package is published by hand from the tarball of
`pnpm run pack`: `npm publish ./dist/<package>-X.Y.Z.tgz --access public`.
