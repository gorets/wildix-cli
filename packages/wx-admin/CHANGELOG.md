# Changelog

## 1.6.0 — 2026-11-08

- Added: `wx-admin integration`, the integrations of the WIM console (its Integrations page) for the company of the
  PBX, with the PBX's cloud token. `list` (`--service`), `get`, `logs` (30 newest, `--all`), `enable`, `disable`
  (`--yes`), `delete` (`--yes`; `--force` for Salesforce Omni only), `settings` (the settings of a CRM connector;
  `--from FILE --yes` replaces them, a file with masked values is refused), `traces`, `trace` (what each step sent
  and got only with `--full`), `stats`. `webhook events|create|update`: HTTP webhooks; the signing secret is made by
  wx-admin and printed once, `update` sends only what changes (`--url`, `--event`, `--add-event`, `--remove-event`,
  `--rotate-secret --yes`). `app list|create|update|swap`: the iframe apps of x-bees (`update` sends the whole app
  back, as the service rebuilds it from what it gets). `hub`: the integrations hub (Red Cactus): `company`,
  `company-set` (`--yes` to put the company in), `company-delete --yes`, `user-list|get|create|update|delete` (the
  password typed hidden or piped; an active user takes a license: `--yes`). As in the WIM console, the hub gets the
  events of the company by a webhook (`<WIM host>/v2/integrations-hub/events/wildix`, 6 call events): `company-set`
  makes it when it is missing (also on a company already in the hub: a repair), `company-delete` removes it. The
  webhooks of Salesforce Omni and of the hub are not changed, disabled or removed by hand. An integration by id or by
  its label in the list.
- The console API returns the signing secrets of webhooks, the keys of SQS webhooks and the ids of Nango (CRM)
  connections in clear: they are masked unless `--show-secrets`; who connected a CRM or created a webhook (names,
  e-mails) only with `--full`. Masking: a `key` next to a `secret` and a `connectionId` next to a `providerConfigKey`
  are secrets now, in `wx-admin cloud` answers too.
- Not here: installing OAuth connectors (HubSpot, Salesforce, Zoho, Gong, Microsoft 365: a browser, the WIM console),
  Google Calendar and Microsoft presence installs, SQS webhooks, the templates of x-bees apps, the deprecated events
  `call:start|update|end`. `wx-admin cloud` does not offer the console API (it has no OpenAPI).
- Checked live (stage, read only, on a company with webhooks, x-bees apps, HubSpot, Salesforce, Zoho CRM, Microsoft
  presence and the hub): `list`, `get` (secrets masked), `logs --all`, `traces`, `trace`, `stats`, `app list`, `hub
  company`, `hub user-list`. Writes, on another test PBX with temporary objects deleted after: a webhook (create,
  update of URL and events, secret rotation: the stored secret is the one printed, disable, enable, delete), two
  x-bees apps (create, update keeps what was not changed, swap, delete); the webhook of the hub refused; the hub:
  `company-set` (a change and back, the webhook of the hub found, not made again), two users (create with a password
  and without, inactive; get; update of name, admin, active, password; delete). Only with tests: `settings --from`,
  `company-set` making a missing webhook, `company-delete`.
- A password of the hub follows the rules of the WIM console (8 to 40 characters, an uppercase and a lowercase
  letter, a digit, a symbol): Red Cactus answers a weaker one with an error 500. `hub user-delete` checks every user
  before deleting any.

## 1.5.0 — 2026-11-08

- Added: `wx-admin wilma`, Wilma (the agent platform of the Wildix cloud) for the company of the PBX, with the PBX's
  cloud token. `agent`, `skill`, `tool`: list, get (the draft or `--version N`), export (a new file; a skill: a new
  folder with `skill.json` and its files), create from an export, update (from an export and/or flags such as
  `--instructions FILE`; the `revision` read is sent; an export older than the last change, or of another object, is
  refused), versions, diff (default: the latest version against the draft), publish, restore (`--yes`), delete
  (`--yes`, and `--force` when agents use the object). Agents also: `deploy <agent> <version>[=PERCENT]... --yes` (or
  `--reset`), and their API keys (`keys`, `key-create`: the secret is printed once, `key-delete`). `connector`:
  catalog (deprecated definitions only with `--all`), definition, list, get, export, create, update, delete. `secret`:
  list, get, create and rotate (the value typed hidden or piped, never an option), update, delete; never a value.
  `connection`: list, get (the owner of a user connection only with `--full`), verify, delete. `audit list|get|uses`
  (who changed what, who uses an object), `trace list|get|model-call` (callers' numbers and names only with `--full`),
  `usage` (tokens, call seconds, sessions, errors by service, agent or channel). Objects by id or exact name; a name
  several objects share asks for the id. Answers are masked unless `--show-secrets`; a file with masked values, even a
  masked token inside a URL, is refused by `create` and `update` (it would write the mask over a secret). A skill
  folder holds its files: no links, no hidden paths. Not here: deprecated operations, voicebots and WIM tools (the
  legacy stack), sandbox and the copilot library (later), running tools, per-user runtime: `wx-admin cloud wilma
  <operation>`.
- Checked live on the stage of two test PBXs: every read on a company with Wilma objects (agents, versions,
  deployment, skills, tools, connectors, catalog, secrets, connections, audit, traces, usage); on the other, with
  temporary objects deleted after: a secret (create, update, rotate), an agent (create from an export, publish twice,
  update with `--instructions -`, diff, deploy 70/30 then 100, a stale export refused, restore, API key created and
  deleted), a skill with a file (created from a folder, exported back byte for byte, publish, delete refused while an
  agent used it), a tool and a connector (create, update, publish; delete refused while an agent used the connector).
  Only with tests: `--show-secrets` exports, deploy `--reset`, `connection verify` and `delete`, `trace model-call`.
- Fixed: the masking of the cloud answers hid what only names or points to a secret. `wx-admin cloud wilma
  ListSecrets` showed `"secrets": "********"` in place of the list of secrets (names and metadata: Wilma never returns
  their values), and a connector showed its definition (`hubspot`) as `********`. Now visible: Wilma secret records
  and references (`{id}`), connection references, the metadata of an agent API key, the authorization modes and scopes
  of a connector, a `key` that names a thing (`{key, version}`, `{id, key}`), ids, types and statuses. Still masked:
  passwords, tokens, API keys, client secrets, the secret of a new agent API key, service account credentials (whole),
  secret header values, custom headers, sandbox environment values, and any `value` inside a field named as a secret.
- Fixed: the changes of `CompareAgentVersions`, `CompareToolVersions` and the audit log (`{path, before, after}`)
  showed a secret value when its path named one (a custom header, an SQS key): both sides are now masked. A `key`
  inside a field named as a secret is masked even next to a name.

## 1.4.0 — 2026-11-07

- Added: `wx-admin login [<host>]` signs in to the PBX itself, with a menu that puts first a **Company API Key**
  (recommended, and why) and then the **WMS login and password** of an administrator. With a login and password,
  `wx-admin` uses **Basic** when the PBX takes it (`ALLOW_BASIC_AUTH=true`), else the **WMS sign-in for tools**
  (`/api/v1/auth/login/`, WMS builds from November 2026) with the 2FA code of an authenticator app, e-mail or SMS,
  renewed by its refresh token. The password is saved (0600) so that it moves to Basic when an administrator turns
  it on and signs in again by itself when the PBX forgets an idle session (36 hours, or a restart): then only a 2FA
  code is asked. Flags for scripts and agents: `--api-key`, `--password [--user] [--code] [--no-basic]`, `--basic`,
  `--token`. One attempt of each kind per command (the PBX may lock an account after failed attempts).
- Added: `wx-admin logout [<host>]` ends a WMS sign-in on the PBX and forgets the access; `wx-admin status [--check]`
  shows the PBX signed in to, the default one, the access and until when.
- Changed: the PBX of a command is `--pbx`, else the default PBX (the first one signed in to, or `pbx use`), else the
  only one signed in to. A 403 from the PBX exits 2 (the access was refused), as the help says. `acl list` and
  `acl get` (were `acl groups` and `acl group`). `user list` shows the e-mail of each user (phones still with `--full`).
- **Removed:** the x-bees login from `wx-admin` (`login <e-mail>`, its `logout`, `profile`, `--profile`, the PBX of
  the x-bees login): customer administrators have no x-bees account. `wx` keeps it. Removed `pbx add` and
  `pbx remove` (`login` and `logout`) and `pbx use --login`. Access saved by 1.3.0 with Basic is not read: sign in
  again.

## 1.3.0 — 2026-11-07

- Cloud services with the CPA token of the PBX (Cognito PBX Auth: the cloud identity the PBX gives its
  administrator, on the internal route `GET /api/v1/PBX/integration/x-bees`): `wx-admin kb` for the knowledge base
  (knowledge bases, search, answers, data sources with configuration, browse and sync, documents with upload and
  download) and `wx-admin cloud <service> <operation>` for any operation of the knowledge base, voicebots, WIM tools
  and Wilma that takes the token, checked against their OpenAPI bundled in `specs/` (`tools/fetch-cloud-specs.mjs`).
  `--env prod|stable|stage` (default: the environment of the PBX). The token stays in memory, goes only to the
  service called, never into output or errors; answers are masked unless `--show-secrets`.
- Checked live on the stage of a test PBX: every read of `kb`; on temporary objects that were deleted: a files data
  source, a knowledge base, a document uploaded, searched, answered from, downloaded (identical) and deleted. Not
  checked: a Company API Key on the CPA route; Confluence `configure` with a new token; websites.
- Answers of the cloud are masked with `maskCloud` (`src/cloud/mask.mjs`): besides keys, tokens and passwords, whole
  credentials (a Dialogflow service account), secret headers in `[{name, value}]`, every custom header, every sandbox
  `env` value, a key or token in the query of a URI; the cursors and page tokens of paged lists are kept.
- Found: the knowledge base answers the API token of a Confluence data source in clear text (`ListDataSources`,
  `GetDataSource`); `wx-admin` masks it.

## 1.2.1 — 2026-11-07

- `wx-admin` says when a newer version is on npm (once a day, one line after the command; `WX_NO_UPDATE_CHECK=1`
  turns it off).

## 1.2.0 — 2026-11-07

- `wx-admin config export | import | copy`: carry a chosen part of the configuration to another PBX without
  anything bound to the source (LDAP ids, the serial, passwords), unlike a WMS backup restored elsewhere. A list to
  tick (an object brings what it needs), references kept by name and turned into the ids of the target, a plan
  (new, the same, differs, blocked with the reason), trunk passwords typed on import, writes in dependency order,
  the next steps (where in WMS, which command) and a dated log. Users optional (`--users`), portable fields only.
- Checked live on the test PBX (WMS 7.11): export of everything (the serial nowhere in the folder); import of it
  back as a dry run (28 the same); a real import of four temporary objects (ACL group, queue, switch, dialplan
  pointing at them and at itself), checked and deleted. Found live: the parameters that point at objects in every
  dialplan application; a user is created without a password but needs `role` and `dialplan`; an ACL group's
  `wcgrp` is unique per PBX; the PBX answers `0` or `"0"` for the same value; the dialplan database has no list of
  its families. Only with tests: users, trunks, trunk groups and price lists written to a PBX; `copy` between two
  PBX.

## 1.1.0 — 2026-11-07

- The first published version. It starts at 1.1.0, the version of `wx` and of their shared core: the three are
  released together from the pnpm workspace of `gorets/wildix-cli` (`packages/wx-admin`). The router, output,
  completion, login, profiles, file checks and HTTP are `wldx-core`, the only dependency, shared with `wx`.
- Fixed: the fish completion script called `wx` instead of `wx-admin`.
- First version: `wx-admin pbx add|list|use|remove|check` (several PBX: Company API Key, Simple Token, Basic, or the
  x-bees login; `--pbx`, a default PBX, `WILDIX_PBX_API_KEY` for CI), `wx-admin dialplan list|get|create|update|
  delete|rules|rule-add|rule-remove|export|import|apps`, `wx-admin api` for any PBX API operation, and the x-bees
  login of `wx` (`login`, `logout`, `status`, `profile`).
- Dialplans follow the PBX OpenAPI (`/PBX/Dialplans/`): rules are `numbers` with `apps: [{name, params}]`. The
  endpoints per rule and import/export described by the earlier dev skill do not exist on the PBX (checked live).
- Checked live on a test PBX (Basic access): every dialplan command, on temporary dialplans that were deleted
  afterwards; the PBX wants every parameter of an application (found live, filled by wx-admin). Checked live on the
  PBX of an x-bees login without the Admin role: the 403 and its hint. Company API Keys only with tests.
- Groups for the rest of the PBX, by what an administrator works on (not the tags of the OpenAPI): `system`
  (version, license, settings, SMTP, NTP, proxy, trusted IPs, ports, upgrade, reboot), `user` (colleagues, presence,
  SIP registrations, groups, departments), `acl`, `queue` (one group for the three queue APIs: configuration,
  runtime and managers), `dialplan settings`, `timetable`, `ivr`, `switch`, `paging`, `db`, `trunk` (SIP, PSTN, FXO,
  groups, price lists), `device`, `phonebook` (with CSV/JSON export and import), `sound`, `records` (call history,
  recordings, voicemails, downloads). `--all-pbx` runs a command that reads on every PBX.
- Secrets: SMTP, proxy and trunk passwords, SIP register strings and device tokens are never in text and are
  masked in JSON unless `--show-secrets`; new passwords are typed hidden or piped, never arguments. Changes that
  affect the whole PBX, stop calls or cannot be undone need `--yes`.
- Checked live on the test PBX (WMS 7.11, Basic access): every read of every group; writes only on temporary
  objects that were deleted (an ACL group, a queue with a dynamic member that is no real person, timetables, IVR,
  switches, paging groups, dialplan-database keys, a phonebook with fake contacts, sounds and folders, one tiny
  batch of recordings). Only with tests: PBX-wide settings, upgrade, reboot, SMTP test, every device write, every
  trunk write, user create/update/delete, presence changes, call forwarding, voicemail deletion.
- The PBX differs from its OpenAPI, found live and handled: trusted IPs are at `/PBX/settings/trusted-ips/`;
  `device verify` takes a query; ACL filters are `permissions[]=`; there is no GET by id for call groups, timetables,
  IVR, switches, paging groups or trunks, and writes answer "Success" without the object; every PUT wants every
  field; validation errors come as `{field: {code, reason}}` (now printed); `/spoolview/` is at the root of the PBX
  and files in Cloud Data Storage are a redirect to a presigned link (fetched without the PBX credentials); the
  call-group manager routes are at `/api/v2`.
- `wx-admin config backup --to DIR`: the configuration of a PBX as files, one JSON per object (dialplans with included
  dialplans by name, dialplan settings, timetables, IVR, switches, paging, queues, trunks with masked passwords,
  trunk groups, ACL groups; ids and runtime fields left out), and `config diff DIR` or `--with PBX`: what was added,
  removed or changed, by path. Nothing is written to a PBX. Checked live: a backup of the test PBX and its diff (none),
  a diff between two PBX, `--all-pbx` against one folder.
- `--pbx` takes `name.wildixin.com`, a bare `name`, an IP, or the serial of a known PBX (bare or as
  `<serial>.wildixin.com`); `pbx add` and `pbx check` record the serial, the x-bees login carries it. Checked live: two
  PBX by serial; `<serial>.wildixin.com` is not in DNS for them, so an unknown serial asks to add the PBX by name.
- **Security** (an independent review before the release; each case has a test): `WILDIX_PBX_API_KEY` goes only to
  `WILDIX_PBX_HOST` (never to another `--pbx`, and `--all-pbx` is refused with it); `pbx add` checks the new access
  in memory and saves it only after the check; every `--from`/`--data-file` is read like an upload (no credentials,
  nothing hidden in the home folder, no keychains) and a parse error never repeats the content; CSV exports guard
  cells a spreadsheet would run as formulas; replacing all rules, members, routes or rights needs `--yes`
  (`dialplan update --from`, `import --replace`, `queue update --member`, `trunk group-update --trunk`,
  `acl update` of rules); a name that matches several objects asks for the id; `api` masks passwords and tokens
  unless `--show-secrets`; a new SMTP, proxy or trunk host needs its password too; phonebook and contact ids are
  checked before they enter a path; the Windows Startup folder is refused for writes.
- API-key scopes come from the spec's `x-wildix-companyApiKeyScope`; where a route has none (dialplan database,
  some ACL, device, voicemail and folder routes) the scope is a guess and a key may be refused there.
