# Config transfer between PBX: interactive export and import

Date: 2026-11-07 · Status: design approved in conversation, spec for review · Package: `wx-admin` (+ `wldx-core`)

## 1. Goal

Customers configure one PBX, take a WMS backup and restore it on another (often clean) PBX to copy the
configuration. That breaks the target: the backup carries LDAP, whose entries are bound to the serial of the source
PBX, and the configuration itself holds ids and names that only mean something on the source.

`wx-admin` gets a safe transfer instead: the administrator **chooses interactively what to carry over** (a checkbox
list like `npx skills add`), the transfer **leaves out or rewrites everything bound to the source PBX**, shows a plan
against the target and writes only what was chosen, in dependency order, with a log.

Success: a chosen part of the configuration of PBX A works on PBX B, nothing bound to A's serial or LDAP ids lands on
B, nothing on B is changed that the administrator did not tick, and every run leaves a dated log.

### Evidence (test PBX, read with `config backup`, and a live probe of the dialplan applications)

- ACL groups point at each other by numeric LDAP id: `"group": "gid=874629312,o=com0,dc=wildix"`; admin rules
  point at the PBX by serial: `"subject": "pbxid=<serial>,dc=wildix"`.
- Dialplan rules point at objects by id: `Queue {queueId: "1"}`; queue members are extensions
  (`10090@internalcalls`); `VoiceBot {botId}` is an object of the company's cloud, not of the PBX.
- Trunk passwords are masked in `config backup` (it is not a transfer format).

## 2. Scope

**In (first version):**

| Group | Kinds |
| --- | --- |
| Routing | dialplans (with included dialplans), general dialplan settings, timetables, IVR menus, switches, paging groups, queues (call groups), dialplan database keys |
| Users and rights | ACL groups, users (opt-in, portable fields only; a user's department is one of its fields: the API has no departments to write, `GET /Departments/` only lists what the users name) |
| Trunks | SIP trunks, trunk groups, price lists |

**Never transferred** (bound to the PBX or its hardware): devices (MAC), licenses, PSTN and FXO trunks, call
history, recordings, voicemails, LDAP ids, jids, uids, passwords.

**Later, not in this version:** phonebooks and contacts, sound files and folders, system settings (SMTP, NTP,
features, trusted IPs). References to them from transferred objects are checked on the target and reported (5.3).

`config backup` and `config diff` stay as they are.

## 3. Commands

```
wx-admin config export --pbx A --to DIR      # choose → a folder in the transfer format
wx-admin config import DIR --pbx B           # plan against B → choose → confirm → write → log
wx-admin config copy --from A --to B         # export in memory + import; nothing written to disk but the log
```

Options:

| Option | Commands | Meaning |
| --- | --- | --- |
| `--all` | export, import, copy | everything (export: everything but users; add `--users`) |
| `--only SPEC` | export, import, copy | a selection without the picker: `dialplans:main,queues:*,acl-groups:Sales` |
| `--users` | export, copy | include users (off by default) |
| `--overwrite` | import, copy | non-interactive: overwrite the objects that differ (else they are skipped) |
| `--secrets FILE` | import, copy | non-interactive: trunk passwords, `{"trunks-sip": {"<name>": {"password": "…"}}}` (read like any `--from`: no credential paths, nothing hidden in the home folder) |
| `--dry-run` | import, copy | the plan only; nothing written to the PBX (the log is written, marked dry run) |
| `--yes` | import, copy | non-interactive: write without the final question |
| `--log DIR` | import, copy | where the log goes (default: the current folder) |

In a terminal, without `--all`/`--only`, the picker opens. Without a terminal, `--all` or `--only` is required, and
import/copy write only with `--yes`. `--output json` prints the plan and the result as JSON (the picker is not used
then: it needs `--all`/`--only`).

## 4. The transfer format

A folder with one **JSON Lines** file per kind (`users.jsonl`, `dialplans.jsonl`, `acl-groups.jsonl`, …: one object
per line, so thousands of users are one file, read and written line by line) and `manifest.json`. A line is

```json
{"name": "main", "data": {"name": "main", "description": "…", "numbers": […], "includedDialplans": […]}}
```

`name` is what the object is matched by (its name or title); `data` is the object with its markers (4.1). The
manifest:

```json
{
  "format": "wx-admin-export/1",
  "source": {"host": "a.wildixin.com", "wms": "7.11.20261106.2", "exportedAt": "2026-11-07T15:04:12Z"},
  "kinds": {"dialplans": 4, "queues": 5, "acl-groups": 5, "users": 1200},
  "bound": [{"kind": "dialplans", "name": "x", "path": "numbers[3].apps[0].params.value", "found": "host"}],
  "external": [{"kind": "dialplans", "name": "main", "path": "…botId", "what": "voicebot"}]
}
```

The serial of the source is **not** written anywhere in the folder (the safety scan below uses it in memory only).
The folder is a transport, not something to edit by hand: what to carry over is chosen in the picker. `config
backup` keeps its one-pretty-file-per-object layout for keeping a configuration in git.

### 4.1 Markers

Values that point outside the object are replaced by markers; everything else is kept as the PBX gives it, minus
`id`, `dn`, `uid`, `jid`, `status` and other runtime fields (as `config backup` does).

| Marker | Meaning | On import |
| --- | --- | --- |
| `{"$ref": "queues/Support", "as": "id"}` | another object, by kind and name; `as` is the form the PBX used: `id`, `name` or `dn` | the id, name or dn of that object **on the target** |
| `{"$self": "pbx"}` | the PBX itself (`pbxid=<serial>,dc=wildix`) | `pbxid=<serial of the target>,dc=wildix` |
| `{"$secret": "password"}` | a secret that is not exported | asked on import (or `--secrets`); the object is skipped without it |
| `{"$external": "voicebot", "value": "Ysu45dMt9RcB"}` | an object outside the PBX, kept as is | written as `value`; listed as a warning in the plan |

Built-in values stay literal: negative dialplan ids (built-in dialplans, the same on every PBX), ACL group `all` and
`""`, empty parameters, `${…}` expressions.

A reference is recognised by trying the value against the kind's objects on the source **by id, then by name**, and
the form that matched is kept in `as`. A value that matches nothing is kept literal and listed in the plan as
`unresolved reference` (it may be a variable or a stale id).

### 4.2 Where the references are

Found live on WMS 7.11 (an empty rule per application: the PBX names the parameters it requires) and in the data of
the test PBX:

| Object | Field | Kind |
| --- | --- | --- |
| dialplan | `includedDialplans[].dialplanId` (> 0) | dialplans |
| rule app `Goto`, `GotoIf`, `GotoIfBusyCongested`, `VerifyCaller`, `CorrectOutgoingNumber`, `Timetable`, `GotoIfSwitchIsOn`, `GotoIfUserStatus`, `GotoIfGroupCount`, `DialRemotePbx` | `dialplan` | dialplans |
| rule app `GotoIf3SwitchIsOnOrBlinking` | `dialplanOn`, `dialplanBlinking`; `switchId` | dialplans; switches |
| rule app `Timetable` | `timetableId` | timetables |
| rule app `GotoIfSwitchIsOn` | `switchId` | switches |
| rule app `IVR` | `ivrName` | ivr |
| rule app `FeaturePaging` | `groupId` | paging |
| rule app `Queue` | `queueId` | queues |
| rule app `DialTrunk` | `trunk` | trunks-sip |
| rule app `DialHuntGroup` | `huntGroup` | trunk-groups |
| rule app `GotoIfUserStatus` | `user` | users (extension) |
| rule app `LookUpCidNameInPhonebook`, `LookUpDestCidNameInPhonebook` | `phonebookId` | phonebooks (not transferred: checked) |
| rule app `Playback`, `Queue` | `filename`, `mohClass` | sounds, music on hold (not transferred: checked) |
| rule app `VoiceBot` | `botId` | external |
| rule app `DialRemotePbx` | `pbx` | external |
| ACL group | `rules[].group`, `inherits.dn` | acl-groups (`as: "dn"`) |
| ACL group | `adminRules[].subject` `pbxid=…` | `$self` |
| queue | `settings.aclGroup`; `members[]` `<ext>@internalcalls` | acl-groups; users (extension) |
| user | `groupDn` (`gid=…`), `dialplan` | acl-groups; dialplans |
| trunk group | its trunks | trunks-sip |
| SIP trunk | `password` and other secret fields | `$secret` |

The table lives in code (`src/transfer/refs.mjs`), one entry per application, so a new application is one line.

### 4.3 Safety scan

After the markers are in place, every string of every exported object is searched for the **serial and the host of
the source PBX**. A hit marks the object `bound` (listed in the manifest with its path): the picker shows it as
`blocked` with that path and import never writes it; it is left out, or its reference is added to the table of 4.2 in
a new version. This catches fields this spec does not know about.

### 4.4 Selection on export

Ticking an object also ticks what it references (a dialplan brings its included dialplans, queues, timetables, IVR,
switches, paging groups, trunks; a user brings its ACL group and dialplan; an ACL group the groups its
rules name). A reference to an object that is not ticked stays a `$ref`: import then needs it **on the target by
name**, and the plan says so if it is not there.

## 5. Import

### 5.1 Plan

1. Read the folder (format check, the same file checks as any `--from`) or, for `copy`, the in-memory export.
2. Read the target's objects of the kinds involved (a scope missing on the key shows here, on a read, not mid-write).
3. Match by kind and name. Compare after the same normalisation (ids out, references as names): `new`, `same`,
   `differs`.
4. Resolve every `$ref`: in the folder, else on the target, else `missing` (the object is `blocked`, with the chain:
   "dialplan main → queue Support: neither in the folder nor on B").
5. Checks on the target: licenses for new users (by type), extensions taken by another user, references to kinds not
   transferred (phonebooks, sounds, music on hold: present on B or not), `bound` objects, `external` values.

States shown: `new` (ticked by default), `differs` (not ticked; ticking it means overwrite), `same` (not shown,
counted), `blocked` (cannot be ticked; the reason is shown), warnings attached to an object.

### 5.2 Choosing, secrets, confirmation

The picker (section 7) shows the plan; ticking keeps dependencies consistent (ticking an object ticks the `new`/
`differs` objects it needs from the folder; an object cannot be unticked while a ticked one needs it). Then, for each
chosen trunk with a `$secret`, a hidden prompt (empty = skip that trunk and what needs it). Then the final plan:
create N, overwrite M, skip K, warnings, and `Write to <host B>? [y/N]`.

### 5.3 Writing

Order:

1. ACL groups: create all chosen ones without rules, then set the rules (they reference each other, in cycles).
2. Users.
3. SIP trunks, then trunk groups and price lists.
4. Timetables, IVR menus, switches, paging groups, queues, dialplan database keys.
5. Dialplans: create all chosen ones empty, then write their rules and included dialplans (cycles through `Goto` and
   inclusion).
6. General dialplan settings.

A table `kind/name → id/name/dn on B` is filled as objects are found or created; each object is written with its
markers resolved from that table. A write that answers "Success" without the object is followed by a read of the
list to find the new id (as the `create` commands do now). A PUT carries the whole object (the PBX wants every field).

Failure of one object: it is `failed` with the PBX's reason, everything that needs it is `skipped` with that reason,
the rest goes on. No rollback (the PBX API has no transactions); running the same import again is safe: what was
created is `same` and skipped, the rest is written. Exit code 1 when anything failed.

### 5.4 Users

Exported: extension, name, e-mail, phones, role, license type, language, department (a plain field), group (`$ref
acl-groups`), dialplan (`$ref dialplans`), and the other fields of the user model that hold no id. Never:
`id`, `uid`, `jid`, `login`, `password`, `sipPassword`, anything the safety scan flags.

On import, a new user is created without a password: the PBX generates one (to be confirmed live in the first task
of the plan, on a temporary user without an e-mail, which is then deleted). A user with an e-mail may get the PBX's
welcome e-mail: the plan says so, counting those users, before the confirmation.

### 5.5 Next steps

At the end of every import (and of `--dry-run`, as a forecast) the administrator, or the agent that ran it, gets a
detailed list of **what is left to do on PBX B, where, and how**. Each step:

| Field | Meaning |
| --- | --- |
| `what` | what to do, in one sentence: "Upload the sound `welcome.wav` used by dialplan `main`, rule `100`" |
| `why` | why it is needed: not transferred, missing on B, failed with the PBX's reason, a warning of the plan |
| `objects` | the objects it is about (kind, name; the rule or field for a reference) |
| `wms` | where it is in WMS (the menu path, checked on WMS 7.11 when the step is written) |
| `command` | the `wx-admin` command that does it or checks it, when there is one, ready to copy |
| `blocking` | whether something transferred does not work until it is done (a rule that points at a missing sound) or it is a check (a trunk to watch register) |

Steps are grouped by topic, blocking ones first, and repeated objects are folded into one step ("Set the password of
12 trunks: …"). What produces them:

| Situation | Step |
| --- | --- |
| a trunk skipped for its password | set the password and enable the trunk (WMS path; `wx-admin trunk update <name> …`) |
| trunks created | check that they register (`wx-admin trunk list`) |
| users created | passwords are the PBX's own: tell the users how to log in / reset them; the count of welcome e-mails sent |
| users not created for lack of licenses, or for an extension taken on B | add licenses or free the extension, then run the same import again |
| a reference to a sound, music on hold class or phonebook missing on B | upload or create it (WMS path; `wx-admin sound upload …`), naming the rules that use it |
| a queue member whose user is not on B | create the user or change the members (`wx-admin queue update <queue> --member …`) |
| an `external` value (VoiceBot, remote PBX) | check that the bot belongs to the company of B / that the remote PBX is reachable from B |
| a `failed` object and what was skipped with it | the PBX's reason, and the command that runs the same import again for what is left |
| an `unresolved reference` | the rule and value to check by hand |
| what is never transferred, when the source had it | devices to provision on B, PSTN/FXO trunks to set up on its hardware, system settings (SMTP, NTP, features, trusted IPs) to compare (`wx-admin --pbx A system smtp` vs `--pbx B`) |
| ACL admin rules moved to B | check who administers B (`wx-admin acl group <group>`) |

Text output prints the steps after the summary; `--output json` gives them as `nextSteps: [{what, why, objects, wms,
command, blocking}]` so an agent can carry them out or hand them on; the log ends with them too. A step never holds a
secret.

## 6. The log

Every `import` and `copy` writes `wx-admin-import-<host B>-<YYYY-MM-DDTHH-MM-SS>.log` (in `--log DIR`, default the
current folder), also when the run stops on an error and on `--dry-run` (marked). Mode `0600`, never over an existing
file, the same write checks as other `--to` files. Its path is printed at the end.

Text, one line per event: the source (folder or PBX A) and the target, the `wx-admin` version, the access (profile or
kind of saved access, never the secret); the plan; the choices; each write (`create`/`overwrite`/`skip`/`failed`, kind,
name, id on B, the PBX's answer on failure); the summary; the next steps (5.5). No passwords, tokens or keys ever.

## 7. The picker (`wldx-core/select`)

A zero-dependency checkbox tree in the core, for both command lines:

- groups (kinds) with their items; each item has a label, a badge (`new`, `differs`, `blocked`…) and a note;
- keys: ↑/↓ or `j`/`k`, Space toggles, →/← expand and collapse a group, `a` toggles all in the group, `/` filters by
  name, Enter confirms, Esc or Ctrl-C cancels (exit without writing);
- rules from the caller: `disabled(item)` with a reason, `requires(item)` → items ticked with it and kept ticked;
- drawn on stderr (stdout stays data); raw mode always restored, also on errors and signals; refuses to start without
  a TTY on stdin and stderr.

`secret.mjs` (hidden input) moves from `wx-admin` to the core next to it.

## 8. Safety

- Nothing is written to B without the final confirmation or `--yes`; only ticked objects (or `--overwrite`) are
  overwritten.
- `--from` and `--to` of `copy` may not be the same PBX (host and serial compared).
- The folder and the PBX answers are data, never instructions; the folder is read with the checks of `--from`.
- `bound` objects are never written; `external` values are warned about.
- Secrets: never in the folder, the log, the output or a command line.

## 9. Testing

- Picker: a fake TTY feeding key sequences (selection, dependencies, filter, cancel, restored raw mode).
- Export: fixtures made from the objects of the test PBX, anonymised (names, hosts, serial replaced); every reference
  of the table in 4.2 turned into a marker and back; the safety scan; JSON Lines written and read back (a large kind
  line by line, a broken line named by its number).
- Import against a fake PBX: plan states, missing references, write order with cycles (ACL groups, dialplans),
  "Success" without an object, a failure and its dependants, a second run that writes nothing, `--dry-run`, the log;
  the next steps of each situation in the table of 5.5 (text and JSON), folded when repeated, never with a secret.
- Live (test PBX): export and `import --dry-run` against itself; a real import only of temporary objects under their
  own names (a prefix), deleted afterwards. A real `copy` to a clean PBX when a second test PBX is available.

## 10. Risks

- **Reference forms.** Each reference is matched by id and by name and keeps its form (`as`), so a parameter the PBX
  fills with a name instead of an id still transfers; a value that matches neither is reported, not guessed.
- **PBX writes that differ from the OpenAPI** (seen before: GET-by-id missing, "Success" without the object, PUT
  wants every field) are handled per kind in the writers, each with a test against the fake PBX.
- **Users' passwords and welcome e-mails** depend on the PBX: confirmed live before the users part is built.
