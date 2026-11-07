# Config transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wx-admin config export | import | copy`: carry a chosen part of a PBX configuration to another PBX, interactively, without anything bound to the source PBX, with a plan, a log and the next steps.

**Architecture:** A zero-dependency checkbox picker and the hidden secret input live in `wldx-core`. In `wx-admin`, `src/transfer/` holds one module per stage: kinds (read and write each kind), refs (markers in and out, safety scan), format (JSON Lines folder), plan (against the target), apply (ordered writes), next-steps, log. `src/commands/config.mjs` wires them into three commands next to `backup` and `diff`.

**Tech Stack:** Node 22+ ESM, `node:test`, pnpm workspace, Biome.

**Spec:** `docs/specs/2026-11-07-config-transfer-design.md`

## Global Constraints

- Node 22+; no runtime dependency besides `wldx-core`; English in code, comments, commits; no attribution in commits.
- `pnpm run check` passes at the end of every task (Biome without warnings, all tests, pack).
- Tests use `node:test` and an injected `fetch` (fake PBX); no network.
- Folder format id: `"format": "wx-admin-export/1"`; one `<kind>.jsonl` per kind, a line is `{"name": …, "data": …}`.
- Markers exactly: `{"$ref": "<kind>/<name>", "as": "id"|"name"|"dn"}`, `{"$self": "pbx"}`, `{"$secret": "<field>"}`, `{"$external": "<what>", "value": …}`.
- The source serial is never written to the folder, the log or the output.
- Log file: `wx-admin-import-<host B>-<YYYY-MM-DDTHH-MM-SS>.log`, mode `0600`, flag `wx` (never over a file).
- Secrets never in the folder, the log, the output, a next step or a command line.
- Live checks only on the test PBX `v-gorobets-cloud`; writes only on objects named with the prefix `wx-transfer-test-`, deleted at the end of the task.
- Kind ids (used in files, `--only`, `$ref`): `acl-groups`, `users`, `trunks-sip`, `trunk-groups`, `price-lists`, `timetables`, `ivr`, `switches`, `paging`, `queues`, `dialplan-db`, `dialplans`, `dialplan-settings`.

## Review Focus

- **Ctrl-C or an exception while the picker is open** → the terminal is back in cooked mode, nothing written (Task 2 test `restores the terminal on cancel and on error`).
- **Names with `/` or odd characters** (dialplan-db keys `family/a/b`, titles with spaces) → `$ref` splits at the first `/` only and names round-trip (Task 4 test `ref names keep slashes`).
- **Two source objects with the same name** → both `blocked` "duplicate name on the source", none written (Task 7 test `duplicate names are blocked`).
- **A kind the target refuses to read** (scope missing) → that kind's objects `blocked` with the PBX's reason, not `new` (Task 7 test `an unreadable target kind blocks its objects`).
- **A broken line in a large `.jsonl`** → an error naming the file and line, nothing written (Task 5 test `a broken line is named`).

---

### Task 0: Confirm user creation without a password (live)

**Files:**
- Modify: `docs/specs/2026-11-07-config-transfer-design.md` (5.4)

- [ ] **Step 1:** On the test PBX, create a user `wx-transfer-test-user` with a free extension, a license the PBX has, **no e-mail**, no password: `wx-admin --pbx v-gorobets-cloud user create --extension <free> --name wx-transfer-test-user --license <type>`.
- [ ] **Step 2:** Record the answer: accepted or not; does `user get` show it; any password requirement in the error.
- [ ] **Step 3:** Delete it: `wx-admin --pbx v-gorobets-cloud user delete wx-transfer-test-user --yes`; check it is gone.
- [ ] **Step 4:** Replace "to be confirmed live…" in spec 5.4 with what was seen. If the PBX requires a password, 5.4 says: the import generates a random one per user (crypto), never shows or logs it, and the next steps tell the admin to reset passwords.
- [ ] **Step 5:** Commit `docs: users are created without a password (checked live)`.

### Task 1: Hidden secret input moves to the core

**Files:**
- Create: `packages/core/src/secret.mjs` (content of `packages/wx-admin/src/secret.mjs`)
- Delete: `packages/wx-admin/src/secret.mjs`
- Modify: every `import … from '../secret.mjs'` / `'./secret.mjs'` in `packages/wx-admin/src` → `'wldx-core/secret'`
- Test: `packages/core/test/secret.test.mjs`

**Interfaces:**
- Produces: `readSecret(ctx, prompt: string) → Promise<string>` (unchanged), from `wldx-core/secret`.

- [ ] **Step 1:** Tests: `reads the first line of stdin when it is not a terminal` (stdin `"pw\nrest"` → `"pw"`); `hides typing in a terminal, backspace and enter` (fake TTY stdin with `setRawMode` spy, chunks `"ab\x7fc\r"` → `"ac"`, raw mode set then unset); `Ctrl-C cancels with a UsageError and restores raw mode`.
- [ ] **Step 2:** Run `node --test packages/core/test/secret.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Move the file, fix imports.
- [ ] **Step 4:** `pnpm run check` → PASS.
- [ ] **Step 5:** Commit `core: readSecret moves to wldx-core/secret`.

### Task 2: The picker (`wldx-core/select`)

**Files:**
- Create: `packages/core/src/select.mjs`
- Test: `packages/core/test/select.test.mjs`

**Interfaces:**
- Produces:
  - `createModel({groups, requires}) → Model` where `groups: [{id, label, items: [{id, label, badge?, note?, checked?, disabled?: string}]}]` (`disabled` holds the reason) and `requires(itemId) → itemId[]`.
  - `Model`: `toggle(itemId)`, `toggleGroup(groupId)`, `setFilter(text)`, `move(delta)`, `expand(groupId, open)`, `selected() → Set<itemId>`, `rows() → [{kind: 'group'|'item', id, label, badge, note, checked, disabled, cursor}]`.
  - `select(io, {title, groups, requires}) → Promise<Set<itemId>>` where `io = {stdin, stderr}`; rejects `UsageError('Cancelled')` on Esc/Ctrl-C; throws `UsageError` when `stdin.isTTY` or `stderr.isTTY` is false.
- Behaviour: ticking an item ticks `requires(item)` transitively (only items that are not `disabled`); unticking an item that a ticked item requires is refused and the row's note says `needed by <label>`; a `disabled` item never toggles. Keys: `\x1b[A`/`k` up, `\x1b[B`/`j` down, space toggle, `\x1b[C`/`\x1b[D` expand/collapse, `a` toggle group, `/` then text then Enter filter, `\r` confirm, `\x1b` or `\x03` cancel. Drawn on stderr, redrawn in place (cursor up + clear), at most `stderr.rows - 4` rows with scrolling.

- [ ] **Step 1:** Model tests: `ticking an item ticks what it requires`; `an item a ticked one requires cannot be unticked` (note contains `needed by`); `a disabled item never toggles`; `toggleGroup ticks every enabled item, again unticks them`; `filter keeps matching items and their groups`.
- [ ] **Step 2:** TTY tests with a fake stdin (EventEmitter + `isTTY`, `setRawMode` spy) and a sink stderr (`isTTY`, `rows: 20`, `columns: 80`): `space and enter return the ticked ids`; `restores the terminal on cancel and on error` (`\x03` → rejects `Cancelled`, `setRawMode(false)` called; a `requires` that throws → rejects, raw mode off); `refuses without a terminal`.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `pnpm run check` → PASS. Commit `core: a checkbox picker without dependencies (wldx-core/select)`.

### Task 3: Kinds — read and write each kind

**Files:**
- Create: `packages/wx-admin/src/transfer/kinds.mjs`
- Test: `packages/wx-admin/test/transfer-kinds.test.mjs` (with `test/fake-pbx.mjs`, created here)
- Create: `packages/wx-admin/test/fake-pbx.mjs`

**Interfaces:**
- Produces:
  - `TRANSFER_KINDS: {[kind]: Kind}` in write order (the Global Constraints list order), each `Kind = {group: 'routing'|'users'|'trunks', label, scope, single?: true, read(client) → Promise<Array<{id, name, data}>>, create(client, data) → Promise<id>, update(client, id, data) → Promise<void>, strip: string[]}`.
  - `readKinds(client, kinds, info) → Promise<{[kind]: Array<{id, name, data}> | {error: string}>}` (a kind the PBX refuses is `{error}`, not missing).
  - `fakePbx(state) → {fetch, calls, state}` in the test folder: GET/POST/PUT/DELETE on the paths below, writes answering `{type:'result', result:'Success'}` where the real PBX does, new ids from a counter.
- Per kind (paths and quirks from the existing commands; reuse their helpers where exported):
  - `acl-groups` `/PBX/AclGroups/` (no GET of one; POST, PUT `{name, inherits, rules, adminRules}`), name `name`.
  - `users` `/PBX/Colleagues/` (all pages), name `extension`; strip `id, uid, jid, login, password, sipPassword` plus fields the scan flags.
  - `trunks-sip` `/Trunks/Sip/`, name `title`; `trunk-groups` `/Trunks/Groups/`, name `name`; `price-lists` `/Trunks/Prices/` with the CSV from `/Trunks/Prices/{ID}/export` as `data.csv`, written back as the multipart form of `trunk price-create`.
  - `timetables` `/Dialplan/timeTables/`, `ivr` `/Dialplan/Ivr/`, `switches` `/Dialplan/Switches/`, `paging` `/Dialplan/PagingGroups/`, `queues` `/Dialplan/CallGroups/`: name `title`; create = POST then re-read the list for the id by title.
  - `dialplan-db` keys of `/Dialplan/DB/`, name `family/key`, write PUT `{value}`.
  - `dialplans` `/PBX/Dialplans/` + `/{id}/`, name `name`; create = POST `{name, description, numbers: [], includedDialplans: []}`, update = PUT with every field.
  - `dialplan-settings` `/Dialplan/GeneralSettings/`, `single`, name `settings`.
  - Every kind strips `id`, `dn`, `status`.

- [ ] **Step 1:** Tests per kind against `fakePbx`: `read gives name and data without ids`; `create answers the new id (re-read for kinds whose POST says Success)`; `update sends the whole object`; `an unreadable kind is {error}`; `users are read over every page`.
- [ ] **Step 2:** Run `node --test test/transfer-kinds.test.mjs` (in `packages/wx-admin`) → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm run check` → PASS. Commit `wx-admin: the kinds of a config transfer, read and written`.

### Task 4: References — markers in and out, safety scan

**Files:**
- Create: `packages/wx-admin/src/transfer/refs.mjs`
- Test: `packages/wx-admin/test/transfer-refs.test.mjs`

**Interfaces:**
- Consumes: the `{[kind]: Array<{id, name, data}>}` of Task 3.
- Produces:
  - `APP_REFS: {[app]: {[param]: kind}}` — exactly the table of spec 4.2 (`Timetable.timetableId→timetables`, `Timetable.dialplan→dialplans`, `IVR.ivrName→ivr`, `GotoIfSwitchIsOn.switchId→switches`, `GotoIf3SwitchIsOnOrBlinking.{switchId→switches, dialplanOn, dialplanBlinking→dialplans}`, `FeaturePaging.groupId→paging`, `Queue.queueId→queues`, `Queue.mohClass→moh`, `DialTrunk.trunk→trunks-sip`, `DialHuntGroup.huntGroup→trunk-groups`, `GotoIfUserStatus.user→users`, `Goto|GotoIf|GotoIfBusyCongested|VerifyCaller|CorrectOutgoingNumber|GotoIfGroupCount|DialRemotePbx.dialplan→dialplans`, `LookUpCidNameInPhonebook|LookUpDestCidNameInPhonebook.phonebookId→phonebooks`, `Playback.filename→sounds`); `EXTERNAL: {VoiceBot: {botId: 'voicebot'}, DialRemotePbx: {pbx: 'remote-pbx'}}`.
  - `toPortable(snapshot, {serial, host}) → {kinds: {[kind]: Array<{name, data}>}, bound: Array<{kind, name, path, found}>, external: Array<{kind, name, path, what}>, unresolved: Array<{kind, name, path, value}>, needs: {[kind/name]: Array<"kind/name">}}` — markers per spec 4.1/4.2, ACL `gid=…` and `inherits.dn` → `as: "dn"`, `pbxid=<serial>,dc=wildix` → `{"$self":"pbx"}`, secret fields of trunks (`maskSecrets`'s `SECRET_KEY`) → `{"$secret": field}`, queue `settings.aclGroup`, queue members → `needs users/<ext>`, user `groupDn`/`dialplan`; built-ins literal (negative dialplan ids, `all`, `""`, `${…}`); id tried before name; the safety scan of spec 4.3 last.
  - `fromPortable(kind, data, resolve) → data` where `resolve({kind, name, as}) → value | undefined`, `resolve.self() → "pbxid=<serial B>,dc=wildix"`, `resolve.secret(field) → string | undefined`.
  - `refsOf(data) → Array<{kind, name, path}>` (every `$ref` in an object).
- [ ] **Step 1:** Tests: `queueId becomes a $ref as id and back to the target's id`; `ivrName becomes a $ref as name`; `ACL rules by gid become $ref as dn; pbxid becomes $self`; `negative dialplan ids, all, empty and ${…} stay literal`; `a value that matches nothing is unresolved and kept`; `trunk secrets become $secret`; `VoiceBot botId is external`; `ref names keep slashes` (`dialplan-db/fam/a/b`); `the serial or host left in any string marks the object bound with its path`; `the serial never appears in the output` (JSON.stringify of the result has no serial).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm run check` → PASS.
- [ ] **Step 5:** Commit `wx-admin: references of a config transfer as markers, and the safety scan`.

### Task 5: The folder (JSON Lines)

**Files:**
- Create: `packages/wx-admin/src/transfer/folder.mjs`
- Test: `packages/wx-admin/test/transfer-folder.test.mjs`

**Interfaces:**
- Produces: `writeExport(ctx, dir, {source: {host, wms}, portable}) → {dir, counts}` (refuses a non-empty folder and unsafe paths via `refuseUnsafeWrite`, files `0600`, flag `wx`); `readExport(ctx, dir) → {manifest, kinds}` (checks `format`, reads `.jsonl` line by line with `node:readline`, each file through `readForUpload`-equivalent checks; a bad line → `UsageError("<file>:<line> is not JSON")` without the content).
- [ ] **Step 1:** Tests: `writes one .jsonl per kind and a manifest without the serial`; `reads back what it wrote`; `a broken line is named`; `5000 users round-trip`; `refuses a used folder and a hidden folder`; `refuses a folder of another format`.
- [ ] **Step 2–4:** FAIL → implement → `pnpm run check` PASS.
- [ ] **Step 5:** Commit `wx-admin: the folder of a config transfer, JSON Lines`.

### Task 6: `config export`

**Files:**
- Modify: `packages/wx-admin/src/commands/config.mjs` (new command `export`; keep `backup`, `diff`)
- Create: `packages/wx-admin/src/transfer/selection.mjs`
- Test: `packages/wx-admin/test/config-export.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–5; `readSerial(client)` from `src/pbx.mjs`.
- Produces: `parseOnly(spec) → Array<{kind, name: string | '*'}>` (UsageError on unknown kinds); `closure(portable, ids) → Set<"kind/name">` (adds `needs` transitively); `pickerGroups(portable, {users}) → groups` for `select` (groups `Routing`, `Users and rights`, `Trunks`; bound objects `disabled` with their path).
- Command: `wx-admin config export --to DIR [--all | --only SPEC] [--users]`, `readOnly` false, scopes per kind; picker when stdin and stderr are TTYs and neither `--all` nor `--only`; otherwise `UsageError('Without a terminal, choose with --all or --only')`. Text result: the folder and the counts per kind, warnings (bound, external, unresolved).
- [ ] **Step 1:** Tests (fakePbx with the anonymised fixture of the test PBX: 4 dialplans, 5 queues, 5 ACL groups, 3 SIP trunks): `--all exports everything but users`; `--users adds users`; `--only dialplans:main brings what main needs`; `without a terminal and without --all/--only it refuses`; `the picker's choice is what is written` (inject `select` via `ctx.select` for the test).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Live: `wx-admin --pbx v-gorobets-cloud config export --all --users --to <scratchpad>/exp`; check no file holds `221100001bab`; note counts. Commit `wx-admin config export: choose what to carry over, a folder without the source PBX in it`.

### Task 7: The plan against the target

**Files:**
- Create: `packages/wx-admin/src/transfer/plan.mjs`
- Test: `packages/wx-admin/test/transfer-plan.test.mjs`

**Interfaces:**
- Consumes: `readKinds` (target), `refsOf`, the portable `kinds`.
- Produces: `makePlan(portable, target, {licenses, sounds, moh, phonebooks}) → Plan` with `Plan.items: Array<{key: "kind/name", kind, name, state: 'new'|'same'|'differs'|'blocked', reason?, needs: string[], warnings: string[], data}>`, `Plan.counts`, `Plan.welcomeMails` (new users with an e-mail). Comparison: the target object turned portable with the same `toPortable` against the target, then deep-equal of `data`.
- Rules: missing `$ref` (not in the folder, not on the target) → `blocked` with the chain; `bound` → `blocked`; duplicate names on the source → all `blocked`; an unreadable target kind → its items `blocked` with the PBX's reason; new users beyond free licenses of their type → `blocked` "no free <type> license"; an extension taken on B by a user of another name → `blocked`; references to `sounds`/`moh`/`phonebooks` missing on B → warning, not blocked; `external` → warning.
- [ ] **Step 1:** Tests: `new, same and differs`; `a missing reference blocks with its chain`; `duplicate names are blocked`; `an unreadable target kind blocks its objects`; `licenses and taken extensions`; `missing sounds are warnings`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin: the plan of a config import`.

### Task 8: Writing in order

**Files:**
- Create: `packages/wx-admin/src/transfer/apply.mjs`
- Test: `packages/wx-admin/test/transfer-apply.test.mjs`

**Interfaces:**
- Consumes: `TRANSFER_KINDS`, `fromPortable`, `Plan`.
- Produces: `applyPlan(client, plan, chosen: Set<key>, {secrets: {[key]: {[field]: string}}, selfDn, onEvent}) → Promise<Array<{key, action: 'create'|'overwrite'|'skip'|'failed', id?, error?, because?}>>`.
- Order: the Global Constraints kind order; `acl-groups` and `dialplans` in two passes (create bare, then full update). Ids table seeded from the target's existing objects. A failure marks every chosen item whose `needs` reach it `skip` with `because: key`. A trunk without its secret is `skip` with `because: 'no password'`.
- [ ] **Step 1:** Tests on fakePbx: `writes in dependency order`; `ACL groups and dialplans that reference each other in a cycle`; `a POST answering Success finds the id by re-reading`; `a failure skips what needs it and goes on`; `a second run writes nothing`; `secrets are sent and never returned in results`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin: writing a config import in dependency order`.

### Task 9: Next steps

**Files:**
- Create: `packages/wx-admin/src/transfer/next-steps.mjs`
- Test: `packages/wx-admin/test/transfer-next-steps.test.mjs`

**Interfaces:**
- Produces: `nextSteps({plan, results, source}) → Array<{what, why, objects: Array<{kind, name, where?}>, wms, command?, blocking}>` covering every row of spec 5.5; repeated steps folded ("Set the password of 12 trunks: …"); blocking first; WMS menu paths taken from the Wildix documentation (docs.wildix.com, WMS 7.x) and kept as constants in this module.
- [ ] **Step 1:** Tests: one per row of the spec 5.5 table; `folds repeated objects`; `blocking steps first`; `no secret in any step`.
- [ ] **Step 2:** Look up the WMS menu paths (trunks, sounds, music on hold, phonebooks, devices, users, licenses, ACL) in the Wildix documentation; put them in the constants with the page they come from in a comment.
- [ ] **Step 3–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin: what is left to do after a config import`.

### Task 10: The log

**Files:**
- Create: `packages/wx-admin/src/transfer/log.mjs`
- Test: `packages/wx-admin/test/transfer-log.test.mjs`

**Interfaces:**
- Produces: `openLog(ctx, {dir, host, now}) → {path, line(text), close()}`: file name per Global Constraints (`:` replaced by `-` in the time), mode `0600`, flag `wx`, `refuseUnsafeWrite` on the folder; every line prefixed with the ISO time; `line` passes text through `clean()`; writes are synchronous so a crash keeps what was written.
- [ ] **Step 1:** Tests: `the name carries host and time`; `never over an existing file`; `0600`; `refuses a hidden folder`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `wx-admin: the log of a config import`.

### Task 11: `config import` and `config copy`

**Files:**
- Modify: `packages/wx-admin/src/commands/config.mjs`, `packages/wx-admin/src/commands/index.mjs` (not `READ_ONLY`)
- Test: `packages/wx-admin/test/config-import.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Commands:
  - `wx-admin config import <dir> [--pbx B] [--all | --only SPEC] [--overwrite] [--secrets FILE] [--dry-run] [--yes] [--log DIR]`
  - `wx-admin config copy --from A --to B [--all | --only SPEC] [--users] [--overwrite] [--secrets FILE] [--dry-run] [--yes] [--log DIR]` (`--from`/`--to` take what `--pbx` takes; same host or same serial → `UsageError`)
- Flow: read (folder or export of A in memory) → target snapshot (`readKinds`), plus for the checks of `makePlan` the target's licenses (`GET /PBX/settings/license/`: `limitations.licenseTypes` and `licenseUsage`, as `system license` reads them), sounds (`/Sounds/`, as `sound list`), music on hold classes (the `mohClass` values found in its own queues and dialplan settings) and phonebooks (`/Phonebooks/`, as `phonebook list`) → `makePlan` → choose (picker: `new` checked, `differs` unchecked, `same` hidden, `blocked` disabled; or `--all`/`--only` with `--overwrite` deciding `differs`) → secrets (hidden prompt per chosen trunk, or `--secrets` read with `readJsonInput`) → summary + `Write to <host>? [y/N]` (or `--yes`; without a TTY and without `--yes` nothing is written, exit 0 with the plan) → `applyPlan` → next steps → log closed; path printed. `--dry-run` stops before writing (log marked `DRY RUN`). JSON: `{plan, results, nextSteps, log}`. Exit 1 when any result is `failed`.
- [ ] **Step 1:** Tests: `import --all --yes writes and logs`; `--dry-run writes nothing and still logs`; `without --yes and without a terminal nothing is written`; `differs is skipped unless chosen or --overwrite`; `copy refuses the same PBX by serial`; `--secrets fills trunk passwords; none in output or log`; `JSON output has plan, results, nextSteps, log`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Live on the test PBX: export `--only` of objects renamed with the prefix into a folder (edit names in the test fixture builder, not by hand), `import --dry-run` against the same PBX (all `same`), then a real import of the `wx-transfer-test-` objects, check them, delete them. Commit `wx-admin config import and copy: plan, choice, ordered writes, next steps, log`.

### Task 12: Documentation and the review

**Files:**
- Modify: `packages/wx-admin/README.md` (section "Moving configuration to another PBX"; regenerated command reference), `packages/wx-admin/CHANGELOG.md` (`## Unreleased`), `packages/core/CHANGELOG.md` (`select`, `secret`), `packages/wx-admin/AGENTS.md` (layout of `src/transfer/`), `AGENTS.md` (core layout: `select.mjs`, `secret.mjs`), `packages/wx-admin/announce/*.md` (one line about the transfer)

- [ ] **Step 1:** Write the docs; regenerate the reference (`node tools/readme-commands.mjs` in `packages/wx-admin`).
- [ ] **Step 2:** `pnpm run check` → PASS.
- [ ] **Step 3:** A fresh reviewer (security and correctness) over the branch diff; fix confirmed findings with tests.
- [ ] **Step 4:** Commit `docs: config export, import and copy`.
