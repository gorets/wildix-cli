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
src/wilma/               Wilma: api (the kinds of objects, their paths and create fields, paged lists, by id or
                         name, who uses an object), versioned (the commands of a kind: list … delete, versions,
                         diff, publish, restore), skills (export to a folder, create from it); the group is
                         src/commands/wilma.mjs
src/integration/         the WIM console integrations: api (client on the WIM host, the console API unwrapped,
                         labels, by id or label, masking and --full, webhook events), hub (the integrations hub);
                         the group is src/commands/integration.mjs
src/commands/kite.mjs    Kite widgets and the messaging channels (SMS, WhatsApp by number; Messenger, RCS by sender)
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
- **Wilma** (`src/wilma/`): lists are paged (`limit` ≤ 100, `cursor`); never send `company` (the token names it). A
  new kind is one entry of `KINDS`; its URI in the audit log is `wilma://<uri>/<id>` (a connector:
  `wilma://tools/connectors/<id>`). An update sends the `revision` read; an export carries the object's `id` and
  `revision`, and `create`/`update` refuse a file holding the mask anywhere (it would overwrite a secret). Delete
  needs `--yes`, and `--force` when something uses the object; `deploy` and `restore` need `--yes`. A secret value is
  typed hidden or piped, never an option or an answer; the secret of a new agent API key is printed once, unmasked.
  Personal data (the owner of a user connection, callers in traces) only with `--full`. Deprecated operations and
  the legacy stack (voicebots, WIM tools) get no `wilma` command.
- **Integrations** (`src/integration/`): the console API (`/console/integrations`) has no OpenAPI; its shapes come
  from the sources of the WIM console and backend. It returns secrets in clear (webhook `secret`/`key`, Nango
  `connectionId`): every answer goes through `shown()` (masked unless `--show-secrets`, people only with `--full`).
  A webhook update sends only the fields that change (the service merges `data`); an app update sends the whole app
  (the service rebuilds it). The webhooks a Salesforce Omni integration or the hub owns are never changed by hand;
  the hub's (`<WIM host>/v2/integrations-hub/events/wildix`) is made by `hub company-set` and removed by
  `hub company-delete`, as the WIM console does. The webhook events are
  the console's list without its deprecated ones. A hub user is a Red Cactus user: creating an active one takes a
  license (`--yes`). OAuth installs stay in the WIM console.
- **Kite** (`src/commands/kite.mjs`, host api*.x-bees.com): no OpenAPI takes the CPA token (the model lists no `pbx`
  auth, the service accepts it). Never send `company`. A target is `service:` / `agent:` / `bot:`; UpdateWidget
  replaces the widget, so an update sends what it has with the changes, and an export of another widget is refused.
  A channel `set --target` keeps the routes (work hours) and actions; `--from` replaces all and needs `--yes`. A number
  with no configuration takes the service whose messaging number it is (as the WIM console does). Not here: what the
  visitors of a widget use (calendar, agents, config, preview), Instagram (refused by the service).
- **Config transfer:** a reference between objects is a marker (`$ref`, `$self`, `$secret`, `$external`), never
  an id of the source; a new reference site of a dialplan application is one line of `APP_REFS` (src/transfer/
  refs.mjs).
- **PBX writes** follow the API: a dialplan is written whole; a change that stops calls or cannot be undone needs
  `--yes`. Test against the fake PBX of the tests; live checks only on a test PBX, on objects the test creates and
  deletes.
