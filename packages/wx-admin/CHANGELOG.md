# Changelog

## Unreleased

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
- Found: the knowledge base answers the API token of a Confluence data source in clear text (`ListDataSources`,
  `GetDataSource`); `wx-admin` masks it.

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
