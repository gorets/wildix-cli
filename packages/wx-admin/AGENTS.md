# AGENTS.md — wx-admin

`wldx-admin-cli`, the npm package of the unofficial Wildix admin command line `wx-admin`. It manages PBX through
the PBX REST API (`https://<pbx>/api/v1`, OpenAPI at `/api/v1/doc/openapi_public.yaml` on any PBX), with saved
access (Company API Key, Simple Token, Basic) or the x-bees login.

The router, output, completion, login, profiles, file checks and HTTP are in the core (`packages/core`, npm
`wldx-core`), shared with `wx`; what a spec, a command and the context are, and the rules for every package: the
[AGENTS.md of the repository](../../AGENTS.md). This file holds what is particular to `wx-admin`.

## Layout

```
bin/wx-admin.mjs         entry: runs src/cli.mjs, sets process.exitCode
src/cli.mjs              setProgram('wx-admin') and the spec: --pbx and --all-pbx (run once per PBX), completion of PBX
src/commands/index.mjs   the groups and single commands in the order of the help, the global options, READ_ONLY
src/commands/<name>.mjs  one group {summary, commands: {name: Command}} or single commands
src/pbx.mjs              which PBX and which access (--pbx, default, login), saved access, the PBX API client
src/match.mjs            an object by name or id, refusing names that match several
src/transfer/            config export/import/copy: kinds (read, write), refs (markers, safety scan), folder
                         (JSON Lines), selection, plan, apply (ordered writes), next-steps, log, run (the import flow)
test/*.test.mjs          node:test against a fake PBX (fetch is injected); test/helpers.mjs: run(), fakeFetch(), fakeJwt()
```

## Rules

- Commands are grouped by what an administrator works on (dialplan, users, queues…), not by the tags of the PBX
  OpenAPI; a command names the operations it uses in its comment. What has no command yet goes through
  `wx-admin api`.
- A PBX command does not set `auth`: it chooses its access through `pbxClient(ctx)` (src/pbx.mjs). A command that
  only reads goes into `READ_ONLY` (src/commands/index.mjs), which lets it run with `--all-pbx`.
- **Secrets** (the x-bees token, API keys, tokens, passwords) go only to their own PBX (and the login to Cognito and
  the x-bees API); never on a command line, never into the environment of a child process, never printed (masked
  unless `--show-secrets`), never in an error message. Requests refuse redirects. A PBX command names the API-key
  scope of its routes (`{scope}`) so a 403 can say which scope is missing.
- **Config transfer:** a reference between objects is a marker (`$ref`, `$self`, `$secret`, `$external`), never
  an id of the source; a new reference site of a dialplan application is one line of `APP_REFS` (src/transfer/
  refs.mjs). Spec: docs/specs/2026-11-07-config-transfer-design.md.
- **PBX writes** follow the API: a dialplan is written whole; a change that stops calls or cannot be undone needs
  `--yes`. Test against the fake PBX of the tests; live checks only on a test PBX, on objects the test creates and
  deletes.
