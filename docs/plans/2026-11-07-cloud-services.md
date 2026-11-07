# Cloud services (CPA token) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wx-admin cloud <service> <operation>` over the knowledge base, voicebots, WIM tools and Wilma with the PBX's CPA token, and hand-made `wx-admin kb …` commands for the knowledge base.

**Architecture:** `packages/wx-admin/src/cloud/` holds one module per concern: `env.mjs` (services and their base URLs per environment), `token.mjs` (the CPA token from the PBX, in memory), `client.mjs` (requests with the token, only to the service), `specs.mjs` (the bundled OpenAPI specs as operation tables). `src/commands/cloud.mjs` is the generic command; `src/commands/kb.mjs` the knowledge base group. A new global option `--env` reaches commands as `ctx.cloudEnv` through a small core change.

**Tech Stack:** Node 22+ ESM, `node:test`, pnpm workspace, Biome.

**Spec:** `docs/specs/2026-11-07-cloud-services-design.md`

## Global Constraints

- Node 22+; no runtime dependency besides `wldx-core`; English in code, comments, commits; no attribution in commits.
- `pnpm run check` passes at the end of every task (Biome without warnings, all tests, pack).
- Tests: `node:test`, injected `fetch`, no network.
- The CPA route: `GET /PBX/integration/x-bees?skip-basic-auth-header=true`, answer `{token, portal}`.
- The CPA token: memory only; never in output, errors, logs or a command line; sent only to the base URL of the service called.
- Environments: `prod`, `stable`, `stage`; default from `portal` (`-stage.` → stage, `-stable.` → stable, else prod).
- Base URLs (spec 2.2): kb prod `https://kb.wim.wildix.com`, stage `https://kb.wim-stage.wildix.com`, **no stable**; voicebots `https://wim{,-stable,-stage}.wildix.com`; tools `https://tools.wim{,-stable,-stage}.wildix.com`; wilma `https://api{,-stable,-stage}.wilma.wildix.com`.
- `--yes`: every delete, `kb source clean`, `kb update --source`, any non-GET of `wx-admin cloud`.
- Answers masked with `maskSecrets` (`src/commands/trunk.mjs`) unless `--show-secrets`.
- Live checks only on the stage of a test PBX; writes only on objects named `wx-test-…`, deleted at the end of the task.

## Review Focus

- **The CPA token in an error** (a service echoing the Authorization header, a fetch error with the URL) → cut out (Task 4 test `the token never appears in an error`).
- **`--env stable` with `kb`** → "the knowledge base has no stable environment: prod or stage" before any request (Task 2 test `kb has no stable`).
- **A name that matches several knowledge bases or data sources** → asks for the id, never picks one (Task 7 test `an ambiguous name asks for the id`).
- **`doc upload` of a credential file or a hidden file** → refused before CreateDocument (Task 9 test `an unsafe file is refused before anything is created`).
- **The token expiring during a long `source status --watch`** → taken again from the PBX, the watch goes on (Task 3 test `a token near its end is taken again`).

---

### Task 0: Base

- [ ] **Step 1:** `main` must contain the config-transfer branch (it brings `wldx-core/secret` and `wldx-core/select`). If it does: `git rebase main` on `cloud-services`. If it does not yet: stop and ask.
- [ ] **Step 2:** `pnpm install && pnpm run check` → PASS.

### Task 1: A global option may name its context key (core)

**Files:** Modify `packages/core/src/cli.mjs` (`takeGlobals`, the `own` map of `runCommand`), `packages/core/src/registry.mjs` (comment); Test `packages/core/test/spec.test.mjs`.

**Interfaces:** Produces: a global option `{…, key: 'cloudEnv'}` is stored in `io.globals.cloudEnv` and given to commands as `ctx.cloudEnv`; without `key`, the camel-cased name as now. `env` is reserved (ctx.env is the process environment): a global named `env` without `key` throws at startup.

- [ ] **Step 1:** Test `a global option with key reaches ctx under that key`: spec global `env: {type: 'string', choices: ['prod','stage'], key: 'cloudEnv'}`, a command returning `{cloudEnv: ctx.cloudEnv, hasEnv: typeof ctx.env === 'object'}`; `run(['show', '--env', 'stage'])` → `{cloudEnv: 'stage', hasEnv: true}`; `--env other` → exit 64.
- [ ] **Step 2–4:** FAIL → implement → `pnpm run check` PASS. **Step 5:** Commit `core: a global option may name its key in the context`.

### Task 2: Services and environments

**Files:** Create `packages/wx-admin/src/cloud/env.mjs`; Test `packages/wx-admin/test/cloud-env.test.mjs`.

**Interfaces:** Produces: `SERVICES: {kb, voicebots, tools, wilma}` each `{label, bases: {prod?, stable?, stage?}}` with the URLs of Global Constraints; `envOf(portal: string) → 'prod'|'stable'|'stage'`; `baseOf(service, env) → string` (UsageError for an unknown service, and for an environment the service lacks: `the knowledge base has no stable environment: prod or stage`).

- [ ] **Step 1:** Tests: `envOf` for `https://wim-console-stage.wildix.com` → stage, `…-stable…` → stable, `https://wim-console.wildix.com` → prod, `undefined` → prod; `baseOf('kb','stage')` → `https://kb.wim-stage.wildix.com`; `kb has no stable`; every base is `https://…wildix.com` with no path.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin: cloud services and their environments`.

### Task 3: The CPA token

**Files:** Create `packages/wx-admin/src/cloud/token.mjs`; Test `packages/wx-admin/test/cloud-token.test.mjs`.

**Interfaces:**
- Consumes: `pbxClient(ctx)` (`src/pbx.mjs`), `jwtClaims` (`wldx-core/auth`).
- Produces: `cloudToken(ctx) → Promise<{token, company, companyName, portal, expiresAt (ms), pbx (host)}>`; cache: a module `Map` keyed by PBX host, reused while `expiresAt - ctx.clock() > 60_000`; `AuthError` on a 401/403 of the PBX with `The PBX gives its cloud token only to an administrator: use an access with the Admin role (wx-admin pbx check)`; `Error` when the answer has no JWT `token`.

- [ ] **Step 1:** Tests with a fake PBX fetch answering the CPA route with `{token: fakeJwt({'custom:company_id': 'it_x', 'custom:company_name': 'X', exp}), portal}`: `reads company, portal and expiry`; `a second call in the same process asks the PBX once`; `a token near its end is taken again` (clock moved to `exp*1000 - 30_000` → second request); `a 403 of the PBX is the administrator hint`; `the token is not in the message of any error` (answer without `token`).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin: the CPA token of the PBX, in memory`.

### Task 4: The cloud client

**Files:** Create `packages/wx-admin/src/cloud/client.mjs`; Test `packages/wx-admin/test/cloud-client.test.mjs`.

**Interfaces:**
- Consumes: `cloudToken`, `SERVICES`, `envOf`, `baseOf`; `query` from `wldx-core/http`.
- Produces: `cloudClient(ctx, service) → Promise<{env, company, base, call(method, path, {query?, json?}) → Promise<any>, raw(method, url, {headers?, body?}) → Promise<Response>}>`. `env` = `ctx.cloudEnv ?? envOf(portal)`. `call` sends `Authorization: Bearer <token>`, `accept: application/json`, `redirect: 'error'`, JSON body; answers parsed JSON (empty body → `null`). `raw` never sends the token (presigned URLs). Errors: `HttpError`-like `Error` with `exitCode` 1, message `<service> answered <status>: <reason>`; 401/403 → `AuthError("the cloud refused the token of <company> for <service> (<status>)")`; every message has the token replaced by `<token>`.
- [ ] **Step 1:** Tests (fake fetch per host): `sends the token only to the base of the service` (a `call` with a path starting `//evil.com` or a full URL → UsageError, no request); `env from --env over portal`; `the token never appears in an error` (service answers 500 with the Authorization header echoed in its body); `401 is an AuthError naming the company`; `raw sends no Authorization`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin: the client of the cloud services`.

### Task 5: Bundled specs

**Files:** Create `tools/fetch-cloud-specs.mjs`, `packages/wx-admin/specs/{kb,voicebots,tools,wilma}.openapi.json`, `packages/wx-admin/src/cloud/specs.mjs`; Modify `packages/wx-admin/package.json` (`files` + `"specs/"`), `tools/pack.mjs` (`ALLOWED` + `specs\/[a-z-]+\.openapi\.json`); Test `packages/wx-admin/test/cloud-specs.test.mjs`.

**Interfaces:**
- `tools/fetch-cloud-specs.mjs`: downloads `https://docs.wildix.com/codegen/api/<name>-client.openapi.json` for `wim-knowledge-base`, `wim-voicebots`, `wim-tools`, and the Wilma areas `agents, artifacts, assistant, audit, copilot, copilot-sessions, sandbox, secrets, skills, tools, traces, voice` (merged into one `wilma` file, an `operationId` clash → the area prefixed: `secrets.ListSecrets`); keeps `info`, `servers`, `paths` with only operations whose security lists `wildix.auth.pbx`, their parameters and request body schemas (`$ref`s resolved), drops responses and examples.
- Produces: `operationsOf(service) → Map<operationId, {method, path, summary, params: [{name, in: 'path'|'query', required}], body: boolean}>`, read once from `specs/<service>.openapi.json` beside `src/`.
- [ ] **Step 1:** Run the tool; review the diff of the four files (no secrets, no internal hosts beyond the documented servers).
- [ ] **Step 2:** Tests: `kb has its 33 operations`; `ListDocuments has the query parameters limit, offset, sort, search, originalId, status and the path parameter dataSourceId`; `CreateKnowledgeBase takes a body, GetKnowledgeBase does not`; `wilma operations are unique`.
- [ ] **Step 3–4:** FAIL → implement → PASS (`pnpm run pack` lists `specs/` in the wldx-admin-cli tarball). **Step 5:** Commit `wx-admin: the OpenAPI of the cloud services, bundled`.

### Task 6: `wx-admin cloud` and `--env`

**Files:** Create `packages/wx-admin/src/commands/cloud.mjs`; Modify `packages/wx-admin/src/commands/index.mjs` (GROUPS/COMMANDS, `GLOBAL_OPTIONS.env = {type: 'string', choices: ['prod','stable','stage'], key: 'cloudEnv', description: 'the environment of the cloud services (default: the one of the PBX)'}`), `packages/wx-admin/src/cli.mjs` (help lines; `completers.cloudOps`); Test `packages/wx-admin/test/cloud-command.test.mjs`.

**Interfaces:** Command `wx-admin cloud [<service> [<operation>]] [--param NAME=VALUE]... [--data JSON | --data-file FILE|-] [--yes] [--show-secrets]`: no service → the services with their environments; a service alone → its operations (`operationId  METHOD path  summary`); an operation → `client.call` with path params substituted with `apiPath`, query from the other `--param`s, the body from `--data`/`--data-file` (`readJsonInput`); answer through `maskSecrets` unless `--show-secrets`; text output: `JSON.stringify(r, null, 2)`.
- [ ] **Step 1:** Tests on a fake PBX + fake cloud: `lists the services`; `lists the operations of kb`; `GET with path and query params`; `an unknown operation lists the known ones (exit 64)`; `a missing required parameter is named`; `a body for an operation without one is refused`; `POST without --yes is refused before any request`; `apiKey of a data source is masked; --show-secrets shows it`; `--env stable kb … is refused`.
- [ ] **Step 2–4:** FAIL → implement → PASS (README reference regenerated). **Step 5:** Commit `wx-admin cloud: any operation of the knowledge base, voicebots, WIM tools and Wilma`.

### Task 7: `kb` — knowledge bases, search, answers

**Files:** Create `packages/wx-admin/src/commands/kb.mjs` (group `kb`, used by Tasks 8–9); Modify `src/commands/index.mjs`; Test `packages/wx-admin/test/kb.test.mjs` (a fake cloud helper `fakeKb(state)` in `test/fake-cloud.mjs`, created here).

**Interfaces:**
- Produces (exported for Tasks 8–9): `findKb(client, ref)`, `findSource(client, ref)`, `findDoc(client, sourceId, ref)` → the object; by id, else exact name (`pickByName` of `src/match.mjs`; several → UsageError asking for the id; none → UsageError with the list command).
- Commands of spec 3.1, operations as listed there. `kb ask`: `SearchKnowledgeBase` per `--kb` (`searchLimit: --limit`, default 5), results merged by score, then `GenerateSearchAnswer {searchQuery, searchResults, model?}`; text: the answer, then `Sources:` with title and URL, then tokens and duration dimmed.
- [ ] **Step 1:** Tests: `list shows data sources by name`; `create by source names`; `update --source needs --yes`; `delete needs --yes`; `an ambiguous name asks for the id`; `search sends query and searchLimit`; `ask searches each kb then generates from the merged results`; `history and stats`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin kb: knowledge bases, search and answers`.

### Task 8: `kb source`

**Files:** Modify `packages/wx-admin/src/commands/kb.mjs`; Test `packages/wx-admin/test/kb-source.test.mjs`.

**Interfaces:**
- Consumes: `findSource`, `readSecret` (`wldx-core/secret`).
- Commands of spec 3.2. `configure` builds `{config: {confluence: {baseUrl, username, apiKey, spaceId, pages: {enabled: [...]}}}}` (apiKey from `readSecret(ctx, 'Confluence API token: ')`, asked only when the type is confluence and `--url`/`--user` change or no key is set) or `{config: {website: {url}}}`; `--schedule` one of the spec's `syncSchedule` values (taken from the bundled spec). `create --type gdrive` → UsageError "Connect Google Drive in the WIM console (OAuth); then wx-admin kb source sync". `status --watch`: every 5 s until `status` is not `running`/`syncing`, Ctrl-C stops (ctx.signal).
- [ ] **Step 1:** Tests: `list masks apiKey`; `create confluence then configure with the key from stdin, never in output`; `gdrive create is refused`; `browse sends describe with the space`; `sync --full sends syncType full`; `clean and delete need --yes`; `status --watch stops when idle`; `logs passes level, search and limit`; `stats and clone`; `get shows the sync status too`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin kb source: data sources, configuration, sync`.

### Task 9: `kb doc`

**Files:** Modify `packages/wx-admin/src/commands/kb.mjs`; Test `packages/wx-admin/test/kb-doc.test.mjs`.

**Interfaces:**
- Consumes: `findSource`, `findDoc`, `client.raw`, `readForUpload`, `refuseUnsafeWrite` (`wldx-core/files`).
- `doc upload <ds> <file> [--title]`: read the file with `readForUpload` first; `CreateDocument {title: --title ?? basename, originalName: basename, originalFormat: extension without the dot}`; `GetDocumentUploadUrl`; `client.raw('PUT', uploadUrl, {body: bytes})`; answer the document. `doc download`: `GetDocumentDownloadUrl`, `client.raw('GET', url)`, write a new file (`flag: 'wx'`, `refuseUnsafeWrite`). `doc markdown --to FILE`: the same file rules.
- [ ] **Step 1:** Tests: `upload: create, upload URL, PUT without Authorization`; `an unsafe file is refused before anything is created`; `download never overwrites`; `markdown to stdout and to a file`; `delete needs --yes`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin kb doc: documents, upload and download`.

### Task 10: Live, docs, review

**Files:** Modify `packages/wx-admin/README.md` (section "Cloud services": the CPA token, who gets it, `--env`, the finding about Confluence keys stated neutrally as "answers may hold secrets: masked"), `packages/wx-admin/CHANGELOG.md` (`## Unreleased`), `packages/wx-admin/AGENTS.md` (`src/cloud/`, rules), `packages/wx-admin/announce/*.md` (a line).

- [ ] **Step 1:** Live on stage of the test PBX: every read command; `kb source create wx-test-src --type files`, `kb create wx-test-kb --source wx-test-src`, `doc upload` of a small text file, `kb search`, `kb ask`, `doc delete`, `kb delete`, `source delete`; check nothing `wx-test-` is left (`kb list`, `kb source list`). Check whether a Company API Key may read the CPA route if one is at hand; note the result in the README.
- [ ] **Step 2:** Docs; regenerate the reference; `pnpm run check` → PASS.
- [ ] **Step 3:** A fresh reviewer over the branch diff (security first: the token's paths); fix confirmed findings with tests.
- [ ] **Step 4:** Commit `docs: cloud services in wx-admin`.
