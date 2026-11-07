# AGENTS.md — wx-admin

`wldx-admin-cli`, the npm package of the unofficial Wildix admin command line `wx-admin`. It manages PBX through
the PBX REST API (`https://<pbx>/api/v1`, OpenAPI at `/api/v1/doc/openapi_public.yaml` on any PBX), with the access
saved by `wx-admin login`: a Company API Key, a login and password (Basic, else the WMS sign-in for tools with 2FA), or
a Simple Token. No x-bees login: the spec sets `profiles: false`.

The router, output, completion, prompts and pickers, file checks and HTTP are in the core (`packages/core`, npm
`wldx-core`), shared with `wx`; what a spec, a command and the context are, and the rules for every package: the
[AGENTS.md of the repository](../../AGENTS.md). This file holds what is particular to `wx-admin`.

## Layout

```
bin/wx-admin.mjs         entry: runs src/cli.mjs, sets process.exitCode
src/cli.mjs              setProgram('wx-admin') and the spec: --pbx and --all-pbx (run once per PBX), completion of PBX
src/commands/index.mjs   the groups and single commands in the order of the help, the global options, READ_ONLY
src/commands/<name>.mjs  one group {summary, commands: {name: Command}} or single commands
src/pbx.mjs              which PBX and which access (--pbx, default, the only one), saved access, the password access
                         (Basic ⇄ WMS sign-in, renewal, re-sign-in), the PBX API client (one retry after a 401)
src/wms-login.mjs        the WMS sign-in for tools (/api/v1/auth/{login,refresh,logout}/): no state, no secret in errors
src/commands/login.mjs   login (menu: API key first; password: Basic, else the WMS sign-in) and logout
src/commands/status.mjs  the PBX signed in to, how, until when; --check
src/match.mjs            an object by name or id, refusing names that match several
src/cloud/               the cloud services with the CPA token: env (services, base URLs), token (from the PBX, in
                         memory), client (only to the service), specs (the OpenAPI in specs/ as operation tables)
src/transfer/            config export/import/copy: kinds (read, write), refs (markers, safety scan), folder
                         (JSON Lines), selection, plan, apply (ordered writes), next-steps, log, run (the import flow)
test/*.test.mjs          node:test against a fake PBX (fetch is injected); test/helpers.mjs: run(), fakeFetch(), fakeJwt(),
                         terminal(); test/fake-wms.mjs: sign-in, 2FA, refresh, Basic on/off, attempt counters
```

## Rules

- Commands are grouped by what an administrator works on (dialplan, users, queues…), not by the tags of the PBX
  OpenAPI; a command names the operations it uses in its comment. What has no command yet goes through
  `wx-admin api`.
- A PBX command does not set `auth`: it chooses its access through `pbxClient(ctx)` (src/pbx.mjs). A command that
  only reads goes into `READ_ONLY` (src/commands/index.mjs), which lets it run with `--all-pbx`.
- **Sign-in:** one attempt of each kind per command (Basic, the WMS sign-in): failed attempts may count towards the
  PBX's lockout. A Basic 401 alone never means "wrong password" (it is also "Basic is off"): the WMS sign-in's answer
  decides. Basic is re-tried only at `login`, `status --check` and when a refresh is refused. An idle WMS session ends
  after 36 hours or at a restart of the PBX; the saved password signs in again (a 2FA code only in a terminal). No
  compatibility layer for older access files: wx-admin is a new tool.
- **Secrets** (API keys, tokens, passwords, refresh tokens, 2FA codes) go only to their own PBX; never on a command
  line, never into the environment of a child process, never printed (masked
  unless `--show-secrets`), never in an error message. Requests refuse redirects. A PBX command names the API-key
  scope of its routes (`{scope}`) so a 403 can say which scope is missing.
- **Cloud:** the CPA token is a secret: memory only, sent only to the base URL of the service called
  (`cloudClient`, one token per request, taken again near its end), cut out of errors, never printed or logged;
  presigned links (uploads, downloads) get no token. Answers go through `maskCloud` (`src/cloud/mask.mjs`): a new
  secret shape of a service is one rule there, with its test.
  `specs/*.openapi.json` are made by `tools/fetch-cloud-specs.mjs` (run by hand, reviewed). A command of the
  knowledge base names the operations it uses in the comment of `src/commands/kb.mjs`.
- **Config transfer:** a reference between objects is a marker (`$ref`, `$self`, `$secret`, `$external`), never
  an id of the source; a new reference site of a dialplan application is one line of `APP_REFS` (src/transfer/
  refs.mjs). Spec: docs/specs/2026-11-07-config-transfer-design.md.
- **PBX writes** follow the API: a dialplan is written whole; a change that stops calls or cannot be undone needs
  `--yes`. Test against the fake PBX of the tests; live checks only on a test PBX, on objects the test creates and
  deletes.
