# wldx-admin-cli — `wx-admin`, an admin command line for the Wildix PBX

**Version 1.4.1** · unofficial · MIT

`wx-admin` manages a Wildix PBX through its REST API (`https://<pbx>/api/v1`): the system and its settings, users,
ACL, queues, dialplans and the objects they use (timetables, IVR, switches, paging, the dialplan database), trunks,
devices, phonebooks, sounds, call history, recordings and voicemails; any other operation through `wx-admin api`. It works with several PBX at once, and also manages the cloud services of the PBX's company (the knowledge base, voicebots, WIM tools, Wilma) with the cloud token the PBX gives its administrator. It signs in to the PBX itself, with a Company API Key or the WMS login and password of an administrator: no x-bees
account is needed. Its twin for the everyday user is
[`wx`](https://github.com/gorets/wildix-cli/tree/main/packages/wx) (npm `wldx-cli`), which uses the x-bees login.

```sh
npm i -g wldx-admin-cli                       # the command is wx-admin
wx-admin login mypbx                          # a menu: a Company API Key, or the WMS login and password
wx-admin status                               # where commands go, with what access, until when
wx-admin dialplan list
wx-admin dialplan rules users

npx wldx-admin-cli --help                     # without installing
```

Requires Node.js 22 or newer. One dependency: [`wldx-core`](https://github.com/gorets/wildix-cli/tree/main/packages/core), the core it shares with `wx`, from the
same repository and of the same version.

Unofficial: not made or supported by Wildix. It uses the PBX API as documented on the PBX
(`https://<pbx>/api/v1/doc/`), which may change between WMS versions.

## Signing in to a PBX

`wx-admin login mypbx` asks how, in this order of preference, and says why:

1. **A Company API Key** (`wsk-v1-…`, recommended). A root admin makes it once in WMS: **PBX → Integrations →
   Company API Keys**; it is shown once and lasts 1 hour to 1 year (WMS 7.09+). Its scopes limit what it may do:
   per group `colleagues`, `aclgroups`, `callgroups`, `dialplan`, `trunks`, `devices`, `phonebooks`, `sounds`,
   `callhistory`, `recordings`, `smtp`, `security`, `info`, `pbxpower` (`:read` for reads, `:*` for changes), or
   `pbx:read` / `pbx:*` for all (`config import` needs `pbx:*`). It acts as `admin`, or as the PBX user it is bound
   to. It needs no password or 2FA code on this computer and is revoked in WMS without touching anyone's password:
   the right choice for scripts and agents too.
2. **The WMS login and password** of an administrator. `wx-admin` finds the way itself:
   - **Basic**, when the PBX takes it (`ALLOW_BASIC_AUTH=true` in `/rw2/etc/env.custom.ini`): no expiry, and no 2FA
     either: Basic bypasses it;
   - else **the WMS sign-in for tools** (the API's `/auth/login/`, in WMS builds from November 2026 on), with the
     2FA code of your authenticator app, e-mail or SMS. It lasts while it is used at least every 36 hours and the
     PBX does not restart (15 days at most, 7 for `admin`): a PBX forgets an idle session after 36 hours.

   The password is saved (0600), so that `wx-admin` moves to Basic when an administrator turns it on, and signs in
   again by itself when the PBX forgets the session: then only a 2FA code is asked, in a terminal. `--no-basic`
   takes the WMS sign-in only and saves no password (you sign in again when it ends).

| Flag | Access | Rights |
| --- | --- | --- |
| `--api-key` | a Company API Key | the scopes of the key |
| `--password [--user NAME] [--code CODE] [--no-basic]` | a login and password: Basic, else the WMS sign-in | that user's ACL: the Admin role and the ACL of the menus |
| `--basic [--user NAME]` | Basic only | that user's ACL |
| `--token` | a Simple Token (deprecated by Wildix: no new ones can be made) | the ACL of its application |

Without a flag a terminal shows the menu; a script or an agent gives a flag. Secrets are typed hidden or read from the
first line of stdin (`... | wx-admin login mypbx --api-key`), never taken from the command line; a 2FA code may be
given with `--code`. The new access is checked with one read of the PBX before it is kept, and an access saved before
stays when the PBX refuses the new one. Each way is tried once per command: failed attempts may count towards the
PBX's lockout. `wx-admin logout mypbx` ends a WMS sign-in on the PBX and forgets the access.

For CI, `WILDIX_PBX_API_KEY` with `WILDIX_PBX_HOST` gives a Company API Key for that one PBX without saving anything:
the key is never sent to another `--pbx`, and `--all-pbx` is refused while it is set.

### Several PBX

Which PBX a command works on:

1. `--pbx PBX` (anywhere on the command line): `name.wildixin.com`, a bare `name` (= `name.wildixin.com`), an IP
   address, or the serial of a PBX signed in to, bare or as `<serial>.wildixin.com` (`login` and `pbx check` record
   the serial),
2. else the default PBX: the first one you signed in to, or the one of `wx-admin pbx use HOST`,
3. else the only PBX signed in to.

`wx-admin status` and `wx-admin pbx list` show them (`*` is the default), `wx-admin pbx check` says which one a command
would use and whether it accepts the access. Access lives in `~/.wildix/admin/pbx/<host>.json` (folder 0700, files
0600): with a login and password, the password is in it.

`--all-pbx` runs a command that only reads on every PBX signed in to and prints each result under its PBX:
`wx-admin --all-pbx system info`, `wx-admin --all-pbx user registrations`.

## Dialplans

A dialplan (procedure) is `{name, description, numbers, includedDialplans}`; its rules are `numbers`, run in order,
each `{number, apps: [{name, params}], comment}`. There is no API per rule: `rule-add` and `rule-remove` read the
dialplan and write it back whole. The PBX wants every parameter of an application, empty ones too: `wx-admin` fills
the ones it knows, and when the PBX names another missing one it adds it empty and tries again (and says so).

```sh
wx-admin dialplan rule-add users 201 --app "DialPhone number=201 timeout=20" --app Hangup --comment "Anna"
wx-admin dialplan export main --to main.json
wx-admin dialplan import --from main.json --as main-copy
wx-admin dialplan apps --used          # the applications this PBX uses, with their parameters
```

## Configuration as code

`wx-admin config backup --to DIR` writes the configuration of a PBX to a folder, one JSON file per object: dialplans,
dialplan settings, timetables, IVR menus, switches, paging groups, queues, trunks (passwords masked), trunk groups and
ACL groups. Ids and runtime fields are left out and included dialplans are named, so two PBX compare cleanly. Keep it
in git; `wx-admin config diff DIR` shows what changed on the PBX since (`+` only on the PBX, `-` only in the folder,
`~` changed, with the paths), `--with OTHERPBX` compares two PBX, `--all-pbx` compares every PBX with one folder.

## Moving configuration to another PBX

A WMS backup restored on another PBX carries LDAP and values bound to the serial of the first one, and breaks the
second. `wx-admin` carries a chosen part of the configuration instead, with nothing bound to the source:

```sh
wx-admin config export --pbx old --to ./move          # tick what to carry (or --all, --only KIND:NAME,…; --users)
wx-admin config import ./move --pbx new --dry-run      # the plan: new, the same, differs, blocked (and why)
wx-admin config import ./move --pbx new                # tick, type the trunk passwords, confirm, write
wx-admin config copy --from old --to new               # the same without the folder
```

- **What is carried:** dialplans (with included dialplans), general dialplan settings, timetables, IVR menus,
  switches, paging groups, queues, dialplan database keys (the families the dialplans use; more with
  `--db-family`), ACL groups, SIP trunks, trunk groups, price lists, and users with `--users` (portable fields
  only). **Never:** devices, licenses, PSTN and FXO trunks, call history, recordings, voicemails, LDAP ids, jids,
  passwords, system settings.
- **References** between objects are kept by name (`{"$ref": "queues/Support", "as": "id"}`) and become the ids,
  names or LDAP dns of the new PBX on import; ACL admin rules about the old PBX are about the new one. An object
  where the serial or the host of the old PBX is still found is not carried (listed as bound).
- **The folder** is one JSON Lines file per kind (`users.jsonl`: one object per line) and `manifest.json`; it holds
  no password and not the serial.
- **The import** compares every object with the new PBX by name: new ones are ticked, one that differs is
  overwritten only when ticked (or `--overwrite`), blocked ones say why (a reference to nothing, no free license,
  an extension taken). Passwords of the chosen trunks are typed hidden (or `--secrets FILE`). Objects are written in
  the order they need each other; one that fails does not stop the rest, and running the same import again writes
  only what is left.
- **At the end**, a list of what is left to do on the new PBX (where in WMS, which `wx-admin` command), the blocking
  ones first, and a log file `wx-admin-import-<host>-<time>.log` (here, or `--log DIR`), written every time, also
  with `--dry-run`. Without a terminal: `--all` or `--only`, and `--yes` to write.

## Cloud services

An administrator of a PBX also manages the cloud services of the PBX's company: the knowledge base (WIM),
voicebots, WIM tools and Wilma. The PBX gives its administrator its own cloud token, the CPA token (Cognito PBX
Auth: the PBX itself as a user of its company, valid 12 hours), and those services accept it. `wx-admin` takes it from
the PBX chosen as for every command (`--pbx`, the default PBX, the only one), keeps it in memory only
and sends it only to the service called. A PBX user without the Admin role is refused; whether a Company API Key may
take it is not checked yet.

The environment is the one of the PBX (its WIM console: production, stable or stage), or `--env prod|stable|stage`.
The knowledge base has no stable environment.

```sh
wx-admin kb list                                     # knowledge bases and their data sources
wx-admin kb ask "How do I upgrade a phone?" --kb Support
wx-admin kb source sync "Public Confluence" --full
wx-admin kb doc upload Manuals ./guide.pdf
wx-admin cloud wilma                                 # every operation of Wilma that takes the token
wx-admin cloud voicebots ListVoiceBots               # any operation, checked against the bundled OpenAPI
```

`wx-admin kb` covers knowledge bases, search and answers, data sources (Confluence, websites, files; Google Drive
is connected in the WIM console with OAuth) and documents. Everything else goes through `wx-admin cloud <service>
<operation>` with `--param NAME=VALUE` and `--data`; a method other than GET needs `--yes`. Answers of the cloud can
hold secrets (e.g. the API token of a Confluence data source): they are masked unless `--show-secrets`, and the
Confluence token is typed hidden, never given as an option.

`wx-admin wilma` manages Wilma, the agent platform: agents (draft, published versions, which versions serve new
sessions, API keys), the skills, tools and connectors they use, secrets (never their values), connections, and
reads the audit log, traces and usage. An object is given by id or exact name; `export` and `create --from` move a
definition, also to the company of another PBX (ids of secrets, connections and knowledge bases differ there).

## Commands

Every command has `-h`, takes `--pbx HOST`, and prints text or, with `--output json`, JSON.

<!-- commands:start (generated by tools/readme-commands.mjs) -->
### wx-admin system

The PBX itself: version, license, settings (features, SMTP, NTP, proxy, trusted IPs), ports, upgrade, reboot.

| Command | What it does |
| --- | --- |
| `wx-admin system info` | version, ping and license summary of the PBX in one |
| `wx-admin system license` | the license of the PBX: limits, license types used and bought, options and until when |
| `wx-admin system settings` | the settings of the PBX: name, version, cloud, language, license, features, network interfaces |
| `wx-admin system settings-set --feature NAME (--enable \| --disable) --yes` | turn a PBX feature on or off (needs --yes: it changes the whole PBX) |
| `wx-admin system smtp [--show-secrets]` | the SMTP settings the PBX sends mail with (the password is never shown) |
| `wx-admin system smtp-set [--host HOST] [--port N] [--from EMAIL] [--user NAME] [--password] [--auth METHOD] [--tls on\|off] [--starttls on\|off] [--timeout S] [--domain NAME] [--cloud-default on\|off] --yes` | change the SMTP settings (needs --yes: mail of the whole PBX goes through them) |
| `wx-admin system smtp-test --to EMAIL [--from EMAIL] [--body TEXT] [--wait SECONDS]` | send a test e-mail with the SMTP settings and show the log of the SMTP server |
| `wx-admin system ntp` | the NTP servers of the PBX and its time |
| `wx-admin system ntp-set [--primary HOST] [--secondary HOST] --yes` | change the NTP servers (needs --yes: the clock of the whole PBX follows them) |
| `wx-admin system proxy [--show-secrets]` | the HTTP proxy of the PBX (for the support VPN; the password is never shown) |
| `wx-admin system proxy-set [--enable \| --disable] [--host HOST] [--port N] [--auth none\|basic\|ntlm] [--login NAME] [--password] --yes` | change the HTTP proxy (needs --yes: the support VPN of the PBX goes through it) |
| `wx-admin system trusted-ip` | the trusted IP addresses of the PBX |
| `wx-admin system trusted-ip-set [--add IP]... [--remove IP]... [--clear] --yes` | add or remove trusted IP addresses (needs --yes: the security of the whole PBX) |
| `wx-admin system ports` | whether the ports of the PBX are open from outside (HTTP, SIP, RTP), as last checked |
| `wx-admin system upgrade` | the state of the last upgrade of the PBX and its log |
| `wx-admin system upgrade-check [--status] [--wait SECONDS]` | look for a new WMS version and packages (runs the check on the PBX and waits for it) |
| `wx-admin system upgrade-settings` | how the PBX upgrades: repository, automatic upgrades, custom firmware server |
| `wx-admin system upgrade-start --yes` | start the upgrade of the PBX (needs --yes); then follow it with system upgrade, and reboot |
| `wx-admin system reboot --yes` | reboot the PBX (needs --yes: every call stops) |

### wx-admin user

Users (colleagues): list, show, create, change, delete, copy preferences, presence, SIP registrations, groups, departments.

| Command | What it does |
| --- | --- |
| `wx-admin user list [--search TEXT] [--group GROUP] [--department NAME] [--role ROLE] [--license TYPE] [--sort FIELD [--desc]] [--limit N] [--start N] [--full]` | the users of the PBX, with filters |
| `wx-admin user get <user>` | one user: role, license, group, department, e-mail, phones, dialplan |
| `wx-admin user create --extension N --name NAME --license TYPE [--email EMAIL] [--role ROLE] [--group GROUP] [--department NAME] [... \| --from FILE\|-]` | create a user (it takes a license; the PBX may send the user a welcome e-mail) |
| `wx-admin user update <user> [--name NAME] [--email EMAIL] [--role ROLE] [--license TYPE] [--group GROUP] [... \| --from FILE\|-] [--transfer-chats]` | change fields of a user (only the ones given) |
| `wx-admin user delete <user>... --yes [--also ITEM]...` | delete users (needs --yes: it cannot be undone); --also removes their data too |
| `wx-admin user copy-preferences <from> <to>... --yes` | copy the preferences of one user to others (needs --yes: theirs are overwritten) |
| `wx-admin user presence <user>... [--full]` | the presence of users: online, status, message, until when, what their phone does |
| `wx-admin user presence-set <extension>... --status STATUS [--message TEXT] [--until "YYYY-MM-DD HH:MM"\|+2h]` | set the presence of users (what their colleagues see): available, away, dnd, mur |
| `wx-admin user registrations [<extension>...] [--full]` | the SIP registrations of users (all, or the extensions given): devices online, user agents |
| `wx-admin user groups` | the user groups (ACL groups) of the PBX |
| `wx-admin user departments` | the departments of the PBX, as a tree, with the number of users |

### wx-admin acl

ACL groups: what the users of a group may do; list, get, create, update, delete, permissions.

| Command | What it does |
| --- | --- |
| `wx-admin acl list` | the ACL groups of the PBX |
| `wx-admin acl get <group>` | one ACL group with its rules and admin rules |
| `wx-admin acl create <name> [--rule "KEY ABILITY [GROUP]"]... [--inherits GROUP] [--from FILE\|-]` | create an ACL group, empty, with --rule, or from a JSON file ({name?, inherits?, rules?}) |
| `wx-admin acl update <group> [--name NAME] [--inherits GROUP \| --no-inherits] [--rule "KEY ABILITY [GROUP]"]... [--remove-rule "KEY [GROUP]"]... [--admin-rule "SUBJECT OPERATION"]... [--remove-admin-rule SUBJECT]... [--from FILE\|-] [--yes]` | change an ACL group: name, parent, rules (added, replaced or removed) or admin rules |
| `wx-admin acl delete <group>... --yes` | delete ACL groups (needs --yes: their users lose the rights of the group) |
| `wx-admin acl permissions [--permission KEY]... [--group GROUP]...` | each permission and the groups that have it (filter by --permission and --group) |
| `wx-admin acl rules [--admin]` | the rules an ACL group can have: keys, abilities, whether they are about other groups |

### wx-admin queue

Call groups (queues): list, show, create, change, delete, stats, dynamic members, forward a call.

| Command | What it does |
| --- | --- |
| `wx-admin queue list` | the call groups of the PBX |
| `wx-admin queue get <queue>` | one call group: settings, static members, and who is in the queue now |
| `wx-admin queue create <name> [--member EXT]... [--strategy S] [--timeout SECONDS] [--wrap-up SECONDS] [--max-len N] [--from FILE\|-]` | create a call group |
| `wx-admin queue update <queue> [--name NAME] [--member EXT]... [--no-members] [--strategy S] [--timeout SECONDS] [--wrap-up SECONDS] [--max-len N] [--from FILE\|-] [--yes]` | change a call group: name, settings, static members (--member replaces them) |
| `wx-admin queue delete <queue>... --yes` | delete call groups (needs --yes: calls sent to them stop) |
| `wx-admin queue stats [<queue>...]` | the queues now: members logged in, available, busy; calls waiting (all, or the ones given) |
| `wx-admin queue member-add <queue> <member> [--penalty N] [--paused] [--manager]` | add a dynamic member (an agent) to a queue, at once, until removed |
| `wx-admin queue member-remove <queue> <member> [--manager]` | remove a dynamic member (an agent) from a queue |
| `wx-admin queue forward <queue> <sip-call-id> <destination>` | forward a call waiting in a queue to an extension or a number |

### wx-admin dialplan

Dialplans (procedures) and their rules, and the general dialplan settings.

| Command | What it does |
| --- | --- |
| `wx-admin dialplan list` | the dialplans of the PBX |
| `wx-admin dialplan get <dialplan>` | one dialplan with its rules and included dialplans |
| `wx-admin dialplan create <name> [--description TEXT] [--from FILE\|-]` | create a dialplan, empty or from a JSON file ({description, numbers, includedDialplans}) |
| `wx-admin dialplan update <dialplan> [--description TEXT] [--from FILE\|-] [--yes]` | change a dialplan: its description, or its rules and includes from a JSON file (replaces them) |
| `wx-admin dialplan delete <dialplan>... --yes` | delete dialplans (needs --yes: calls routed to them stop working) |
| `wx-admin dialplan rules <dialplan>` | the rules of a dialplan, in order: number pattern → applications |
| `wx-admin dialplan rule-add <dialplan> <number> (--app "Name key=value…"... \| --from FILE\|-) [--comment TEXT] [--position N] [--replace]` | add a rule to a dialplan (at the end, or at --position) |
| `wx-admin dialplan rule-remove <dialplan> <number> --yes` | remove the rule of a number from a dialplan (needs --yes) |
| `wx-admin dialplan export <dialplan> [--to FILE]` | a dialplan as JSON that dialplan import takes (to stdout, or to a new file) |
| `wx-admin dialplan import --from FILE\|- [--as NAME] [--replace --yes]` | create a dialplan from the JSON of dialplan export; --replace overwrites one of the same name |
| `wx-admin dialplan apps [--used]` | the dialplan applications; --used shows the ones the dialplans of the PBX use, with their parameters |
| `wx-admin dialplan settings` | the general dialplan settings (prefixes, timeouts, recording and voicemail mail, variables) |
| `wx-admin dialplan settings-set (--set KEY=VALUE... \| --from FILE\|-) --yes` | change general dialplan settings (needs --yes: they apply to every call) |

### wx-admin timetable

Timetables (the hours a dialplan checks): list, show, create, change, delete, import.

| Command | What it does |
| --- | --- |
| `wx-admin timetable list` | the timetables of the PBX with their items |
| `wx-admin timetable get <timetable>` | one timetable and its items |
| `wx-admin timetable create <title> [--state 0\|1\|2] [--item SPEC]... [--from FILE\|-]` | create a timetable (without items it covers every day, all day) |
| `wx-admin timetable update <timetable> [--title TEXT] [--state 0\|1\|2] [--item SPEC]... [--add-item SPEC]... [--from FILE\|-]` | change a timetable: title, state, items (--item replaces them all, --add-item adds) |
| `wx-admin timetable delete <timetable>... --yes` | delete timetables (needs --yes: rules that check them stop matching) |
| `wx-admin timetable import --from FILE\|- [--replace]` | create timetables from JSON (the output of timetable list or get); --replace overwrites those of the same title |

### wx-admin ivr

IVR menus (voice menus a dialplan sends calls to): list, show, create, change, delete.

| Command | What it does |
| --- | --- |
| `wx-admin ivr list` | the IVR menus of the PBX |
| `wx-admin ivr get <ivr>` | one IVR menu as a tree: keys and where they send the call |
| `wx-admin ivr create <title> --sound PATH [--times N] [--timeout SECONDS] [--timeout-to DIALPLAN/NUMBER] [--back-key K] [--key K=DIALPLAN/NUMBER]... [--from FILE\|-]` | create an IVR menu |
| `wx-admin ivr update <ivr> [--title TEXT] [--sound PATH] [--times N] [--timeout SECONDS] [--timeout-to DIALPLAN/NUMBER] [--back-key K] [--key K=DIALPLAN/NUMBER]... [--remove-key K]... [--from FILE\|-]` | change an IVR menu: title, sound, timeout, keys (--key sets one, --remove-key drops one) |
| `wx-admin ivr delete <ivr>... --yes` | delete IVR menus (needs --yes: calls sent to them stop working) |

### wx-admin switch

Switches (on/off flags dialplans branch on): list, show, create, rename, on, off, blink, delete.

| Command | What it does |
| --- | --- |
| `wx-admin switch list` | the switches of the PBX and their state |
| `wx-admin switch get <switch>` | one switch and its state |
| `wx-admin switch create <title> [--three-state] [--state off\|on\|blinking]` | create a switch (off unless --state); --three-state lets it blink too (fixed once made) |
| `wx-admin switch update <switch> [--title TEXT] [--state off\|on\|blinking [--yes]]` | rename a switch, or set its state (a state change needs --yes) |
| `wx-admin switch on <switch> --yes` | set a switch on (needs --yes: calls are routed by it) |
| `wx-admin switch off <switch> --yes` | set a switch off (needs --yes: calls are routed by it) |
| `wx-admin switch blink <switch> --yes` | set a switch blinking (needs --yes: calls are routed by it) |
| `wx-admin switch delete <switch>... --yes` | delete switches (needs --yes: rules that check them change) |

### wx-admin paging

Paging groups (the phones a page reaches): list, show, create, change, delete.

| Command | What it does |
| --- | --- |
| `wx-admin paging list` | the paging groups of the PBX and their members |
| `wx-admin paging get <group>` | one paging group and its members |
| `wx-admin paging create <title> [--member EXTENSION]...` | create a paging group |
| `wx-admin paging update <group> [--title TEXT] [--member EXTENSION]... [--add EXTENSION]... [--remove EXTENSION]...` | change a paging group: title, members (--member replaces them, --add and --remove change them) |
| `wx-admin paging delete <group>... --yes` | delete paging groups (needs --yes) |

### wx-admin db

The dialplan database (families of keys and values that dialplans read and set): list, get, set, delete.

| Command | What it does |
| --- | --- |
| `wx-admin db list <family>` | the keys and values of a family |
| `wx-admin db get <family> <key>` | the value of a key |
| `wx-admin db set <family> <key> <value>` | set the value of a key (made if missing) |
| `wx-admin db delete <family> [<key>] --yes` | delete a key, or a whole family without a key (needs --yes) |

### wx-admin trunk

Trunks (SIP, PSTN, FXO), trunk groups and price lists: list, show, create, change, delete.

| Command | What it does |
| --- | --- |
| `wx-admin trunk list [--type sip\|pstn\|fxo] [--show-secrets]` | the trunks of the PBX: kind, name, host, dialplan, registration |
| `wx-admin trunk get <trunk> [--type sip\|pstn\|fxo] [--show-secrets]` | one trunk and its settings (passwords never in text) |
| `wx-admin trunk create <title> --host HOST --user LOGIN [--secret] [--port N] [--context DIALPLAN] [--transport udp\|tcp\|tls] [--register] [--from FILE]` | create a SIP trunk |
| `wx-admin trunk update <trunk> [--type sip\|pstn\|fxo] [--title TEXT] [--context DIALPLAN] [--host HOST] [--port N] [--user LOGIN] [--transport udp\|tcp\|tls] [--secret] [--from FILE] --yes` | change a trunk (needs --yes: a wrong setting stops its calls) |
| `wx-admin trunk delete <trunk> --yes` | delete a SIP trunk (needs --yes: its calls stop) |
| `wx-admin trunk groups [<group>]` | the trunk groups (trunks tried in order for outgoing calls) |
| `wx-admin trunk group-create <name> --trunk SPEC... [--description TEXT]` | create a trunk group |
| `wx-admin trunk group-update <group> [--name NAME] [--description TEXT] [--trunk SPEC]... [--yes]` | change a trunk group: name, description, trunks (--trunk replaces them all) |
| `wx-admin trunk group-delete <group>... --yes` | delete trunk groups (needs --yes: dialplans that dial them fail) |
| `wx-admin trunk prices [<pricelist>]` | the price lists of the trunks (call costs); with one, its rates |
| `wx-admin trunk price-create <name> --file CSV` | create a price list from a CSV file (the format of price-export) |
| `wx-admin trunk price-update <pricelist> [--name NAME] [--file CSV]` | rename a price list, or replace its rates from a CSV file |
| `wx-admin trunk price-delete <pricelist>... --yes` | delete price lists (needs --yes) |
| `wx-admin trunk price-export <pricelist> [--to FILE]` | a price list as CSV (to stdout, or to a new file) |

### wx-admin device

Devices of the PBX: list, add, change, delete, scan the network, remote access, Wizyconf token.

| Command | What it does |
| --- | --- |
| `wx-admin device list [--count N] [--start N] [--show-secrets]` | the devices of the PBX: MAC, model, users, online, address, firmware |
| `wx-admin device add <mac>...` | add devices by MAC address (they get their configuration from the PBX) |
| `wx-admin device update <mac> [--description TEXT] [--user EXT] [--users EXT,EXT] [--dns PRIMARY[,SECONDARY]] [--ntp HOST] [--timezone TZ] [--syslog HOST] [--from FILE\|-]` | change a device: description, user(s), DNS, NTP, syslog, or anything from a JSON file |
| `wx-admin device delete <mac> --yes` | delete a device from the PBX (needs --yes: it stops working with the PBX) |
| `wx-admin device scan <range>` | look for devices in a range of addresses of the network of the PBX |
| `wx-admin device verify <address> [--port N]` | check a device at an address: its MAC, model, and whether the PBX may provision it |
| `wx-admin device connect <mac>` | open the remote access to the web interface of a device, through the PBX |
| `wx-admin device disconnect <mac> --yes` | close the remote access to a device (needs --yes: whoever uses it loses it) |
| `wx-admin device reset-token <pin> --yes` | reset the token of a Wizyconf device, by the PIN it shows, to provision it again (needs --yes) |

### wx-admin phonebook

Phonebooks and their contacts: list, show, create, change, delete, export, import.

| Command | What it does |
| --- | --- |
| `wx-admin phonebook list [--search TEXT]` | the phonebooks of the PBX |
| `wx-admin phonebook get <phonebook>` | one phonebook |
| `wx-admin phonebook create <name> [--type global\|personal]` | create a phonebook |
| `wx-admin phonebook update <phonebook> [--name NAME] [--type global\|personal]` | rename a phonebook or change its type |
| `wx-admin phonebook delete <phonebook> --yes` | delete a phonebook with all its contacts (needs --yes) |
| `wx-admin phonebook contacts <phonebook> [--search TEXT] [--count N] [--offset N]` | the contacts of a phonebook |
| `wx-admin phonebook contact <phonebook> <contactId>` | one contact of a phonebook: its filled fields |
| `wx-admin phonebook contact-add <phonebook> --name TEXT [--phone N] [--mobile N] [--email A] [--organization T] [--set FIELD=VALUE]...` | add a contact to a phonebook |
| `wx-admin phonebook contact-update <phonebook> <contactId> [--name TEXT] [--phone N] … [--set FIELD=VALUE]...` | change fields of a contact (the others stay) |
| `wx-admin phonebook contact-delete <phonebook> <contactId>... --yes` | delete contacts of a phonebook (needs --yes) |
| `wx-admin phonebook export <phonebook> [--to FILE] [--format csv\|json]` | the contacts of a phonebook as CSV or JSON (to stdout, or to a new file) |
| `wx-admin phonebook import <phonebook> --from FILE\|- [--format csv\|json]` | add the contacts of a CSV or JSON file to a phonebook |

### wx-admin sound

Sound files (music on hold, ring tones, prompts) and their folders: list, upload, rename, move, delete.

| Command | What it does |
| --- | --- |
| `wx-admin sound list [<folder>]` | the sounds and folders of a folder (the top one by default) |
| `wx-admin sound upload <file> [--to FOLDER] [--name NAME]` | upload a sound file (the PBX converts it to its formats) |
| `wx-admin sound rename <path> <new-name>` | rename a sound or a folder |
| `wx-admin sound move <path> <folder>` | move a sound or a folder into another folder |
| `wx-admin sound delete <path>... --yes` | delete sounds (needs --yes) |
| `wx-admin sound mkdir <folder>` | make a folder for sounds |
| `wx-admin sound rmdir <folder> --yes` | delete a folder with the sounds in it (needs --yes) |

### wx-admin records

What calls leave behind: the call history, call recordings, voicemails.

| Command | What it does |
| --- | --- |
| `wx-admin records history [--since DATE] [--until DATE] [--disposition D] [--type T] [--search TEXT] [--filter FIELD=VALUE]... [--count N] [--offset N] [--sort FIELD] [--asc]` | the call history of the whole PBX, the newest first |
| `wx-admin records history-user <extension> [the options of records history]` | the call history of one user (extension), the newest first |
| `wx-admin records call <callId>` | one call of the history: times, parties, result, its recordings and voicemail |
| `wx-admin records recordings [--since DATE] [--until DATE] [--count N] [--page TOKEN]` | the call recordings of the PBX, the newest first |
| `wx-admin records recording-download <path\|callId> --to FILE [--index N]` | save a call recording to a new file (by its path, or by the id of its call) |
| `wx-admin records recordings-batch (--since DATE --until DATE \| --task ID) [--to FILE] [--wait-seconds N]` | pack the recordings of a time range into one archive on the PBX, wait for it, optionally save it |
| `wx-admin records voicemails [--mailbox EXT] [--folder NAME]` | the voicemails of the PBX, the newest first |
| `wx-admin records voicemail-download <msg_id\|path> --to FILE` | save a voicemail message to a new file |
| `wx-admin records voicemail-delete <msg_id>... --yes` | delete voicemails for good (needs --yes) |

### wx-admin config

The configuration as files: back up and compare; export, import and copy settings to another PBX (users, routing, trunks).

| Command | What it does |
| --- | --- |
| `wx-admin config backup --to DIR [--only KIND,KIND…]` | write the configuration of the PBX to a new folder, one JSON file per object (passwords masked) |
| `wx-admin config import <dir> [--all \| --only KIND:NAME,…] [--overwrite] [--secrets FILE] [--dry-run] [--yes] [--log DIR]` | write a config export to this PBX: a plan, what to write (chosen), the passwords, a log and what is left to do |
| `wx-admin config copy --from PBX --to PBX [--all \| --only KIND:NAME,…] [--users] [--overwrite] [--secrets FILE] [--dry-run] [--yes] [--log DIR]` | carry the configuration of one PBX to another: export in memory, then import (plan, choice, log) |
| `wx-admin config export --to DIR [--all \| --only KIND:NAME,…] [--users] [--db-family FAMILY]...` | choose what to carry to another PBX and write it to a new folder, without anything bound to this PBX |
| `wx-admin config diff (<dir> \| --with PBX) [--only KIND,KIND…]` | what differs between a backup folder (or another PBX) and the PBX |

### wx-admin kb

The knowledge base of the cloud (WIM): knowledge bases, data sources, documents, search, answers.

| Command | What it does |
| --- | --- |
| `wx-admin kb list` | the knowledge bases of the company: name, data sources, last change |
| `wx-admin kb get <kb>` | one knowledge base with its data sources by name |
| `wx-admin kb create <name> --source DS... [--description TEXT]` | create a knowledge base from data sources |
| `wx-admin kb update <kb> [--name NAME] [--description TEXT] [--source DS]... [--yes]` | change a knowledge base: name, description, data sources (--source replaces them: needs --yes) |
| `wx-admin kb delete <kb>... --yes` | delete knowledge bases (needs --yes; their data sources stay) |
| `wx-admin kb search <kb> <query> [--limit N]` | search a knowledge base: the chunks found, with their document and score |
| `wx-admin kb ask <query> --kb KB... [--limit N] [--model MODEL]` | an answer from knowledge bases: search each, then generate the answer from what was found |
| `wx-admin kb history [--limit N]` | the search queries made on the knowledge bases |
| `wx-admin kb stats` | statistics of the searches on the knowledge bases |
| `wx-admin kb source list [--show-secrets]` | the data sources: type, schedule (keys masked) |
| `wx-admin kb source get <ds> [--show-secrets]` | one data source with its configuration and sync status (keys masked) |
| `wx-admin kb source create <name> --type confluence\|website\|files [--description TEXT]` | create a data source (then: kb source configure, kb source sync) |
| `wx-admin kb source configure <ds> [--url URL]... [--user EMAIL] [--space ID] [--page ID]... [--schedule SCHEDULE]` | configure a data source: Confluence (address, user, space, pages; the API token typed hidden), website, schedule |
| `wx-admin kb source browse <ds> [--space ID] [--url URL] [--folder ID]` | what a source can sync: Confluence spaces (or the pages of --space), website pages, Drive folders |
| `wx-admin kb source sync <ds> [--full]` | start a sync of a data source (incremental; --full syncs everything again) |
| `wx-admin kb source stop <ds>` | stop the sync of a data source |
| `wx-admin kb source status <ds> [--watch] [--every SECONDS]` | the sync status of a data source; --watch follows it until the sync ends |
| `wx-admin kb source logs <ds> [--level LEVEL] [--search TEXT] [--limit N]` | the sync logs of a data source |
| `wx-admin kb source stats <ds>` | the documents and chunks of a data source |
| `wx-admin kb source clone <ds>` | a copy of a data source (its configuration, not its documents) |
| `wx-admin kb source clean <ds> --yes` | remove the documents of a data source (needs --yes; the source and its configuration stay) |
| `wx-admin kb source delete <ds>... --yes` | delete data sources (needs --yes) |
| `wx-admin kb doc list <ds> [--search TEXT] [--status STATUS] [--limit N]` | the documents of a data source |
| `wx-admin kb doc get <ds> <doc>` | one document with its content and chunks |
| `wx-admin kb doc markdown <ds> <doc> [--to FILE]` | the text of a document as Markdown (to stdout, or to a new file) |
| `wx-admin kb doc upload <ds> <file> [--title TEXT]` | upload a file as a document of a data source |
| `wx-admin kb doc download <ds> <doc> --to FILE` | the original file of a document, to a new file |
| `wx-admin kb doc delete <ds> <doc>... --yes` | delete documents of a data source (needs --yes) |

### wx-admin wilma

Wilma, the agent platform of the cloud: agents, skills, tools, connectors, secrets, audit, traces.

| Command | What it does |
| --- | --- |
| `wx-admin wilma agent list [--search TEXT] [--status draft\|active] [--channel voice\|chat\|assistant]` | the agents of the company: name, channels, engine, status, latest version, last change |
| `wx-admin wilma agent get <agent> [--version N]` | one agent: its draft, or a published version |
| `wx-admin wilma agent export <agent> [--version N] --to FILE [--show-secrets]` | write the definition of an agent to a new JSON file, for create or update (masked unless --show-secrets) |
| `wx-admin wilma agent create --from FILE` | create an agent from a JSON file (an export: only the fields create takes are sent) |
| `wx-admin wilma agent update <agent> [--from FILE] [--name NAME] [--description TEXT] [--instructions FILE\|-]` | change the draft of an agent: from a JSON file (an export) and/or flags |
| `wx-admin wilma agent versions <agent>` | the published versions of an agent |
| `wx-admin wilma agent diff <agent> [--from N\|draft] [--to N\|draft]` | what changed between two versions of an agent, or a version and the draft (default: latest → draft) |
| `wx-admin wilma agent publish <agent> [--changelog TEXT] [--name TEXT]` | publish the draft of an agent as a new version (it serves nothing until deployed) |
| `wx-admin wilma agent restore <agent> <version> --yes` | put a published version of an agent back into its draft (the draft is replaced: needs --yes) |
| `wx-admin wilma agent delete <agent>... --yes [--force]` | delete agents (needs --yes; one in use needs --force too) |
| `wx-admin wilma agent deploy <agent> <version>[=PERCENT]... --yes \| --reset --yes` | which published versions serve new sessions, and how many of them (changes live traffic: needs --yes) |
| `wx-admin wilma agent keys <agent>` | the API keys of an agent: name, prefix, created, expires, last used |
| `wx-admin wilma agent key-create <agent> [--name NAME] [--expires DATE]` | a new API key of an agent: its secret is printed once, here only |
| `wx-admin wilma agent key-delete <agent> <key>... --yes` | delete API keys of an agent (needs --yes; what uses them stops working) |
| `wx-admin wilma skill list [--search TEXT] [--status draft\|active]` | the skills of the company: name, visibility, files, status, latest version, last change |
| `wx-admin wilma skill get <skill> [--version N]` | one skill: its draft, or a published version |
| `wx-admin wilma skill export <skill> [--version N] --to DIR [--show-secrets]` | write a skill to a new folder: skill.json and its files (masked unless --show-secrets) |
| `wx-admin wilma skill create --from DIR\|FILE` | create a skill from an export: a folder (skill.json and its files, uploaded first) or a JSON file |
| `wx-admin wilma skill update <skill> [--from FILE] [--name NAME] [--description TEXT] [--content FILE\|-]` | change the draft of a skill: from a JSON file (an export) and/or flags |
| `wx-admin wilma skill versions <skill>` | the published versions of a skill |
| `wx-admin wilma skill diff <skill> [--from N\|draft] [--to N\|draft]` | what changed between two versions of a skill, or a version and the draft (default: latest → draft) |
| `wx-admin wilma skill publish <skill> [--changelog TEXT]` | publish the draft of a skill as a new version |
| `wx-admin wilma skill restore <skill> <version> --yes` | put a published version of a skill back into its draft (the draft is replaced: needs --yes) |
| `wx-admin wilma skill delete <skill>... --yes [--force]` | delete skills (needs --yes; one in use needs --force too) |
| `wx-admin wilma tool list [--search TEXT] [--status draft\|active]` | the tools of the company: name, category, handler, status, latest version, last change |
| `wx-admin wilma tool get <tool> [--version N]` | one tool: its draft, or a published version |
| `wx-admin wilma tool export <tool> [--version N] --to FILE [--show-secrets]` | write the definition of a tool to a new JSON file, for create or update (masked unless --show-secrets) |
| `wx-admin wilma tool create --from FILE` | create a tool from a JSON file (an export: only the fields create takes are sent) |
| `wx-admin wilma tool update <tool> [--from FILE] [--name NAME] [--description TEXT] [--category TEXT]` | change the draft of a tool: from a JSON file (an export) and/or flags |
| `wx-admin wilma tool versions <tool>` | the published versions of a tool |
| `wx-admin wilma tool diff <tool> [--from N\|draft] [--to N\|draft]` | what changed between two versions of a tool, or a version and the draft (default: latest → draft) |
| `wx-admin wilma tool publish <tool> [--changelog TEXT]` | publish the draft of a tool as a new version |
| `wx-admin wilma tool restore <tool> <version> --yes` | put a published version of a tool back into its draft (the draft is replaced: needs --yes) |
| `wx-admin wilma tool delete <tool>... --yes [--force]` | delete tools (needs --yes; one in use needs --force too) |
| `wx-admin wilma connector list` | the connectors of the company: name, definition, grant, authorization |
| `wx-admin wilma connector get <connector>` | one connector |
| `wx-admin wilma connector export <connector> --to FILE [--show-secrets]` | write the definition of a connector to a new JSON file, for create or update (masked unless --show-secrets) |
| `wx-admin wilma connector create --from FILE` | create a connector from a JSON file (an export: only the fields create takes are sent) |
| `wx-admin wilma connector update <connector> [--from FILE] [--name NAME] [--description TEXT]` | change a connector: from a JSON file (an export) and/or flags |
| `wx-admin wilma connector delete <connector>... --yes [--force]` | delete connectors (needs --yes; one in use needs --force too) |
| `wx-admin wilma connector catalog [--search TEXT] [--all]` | the connector definitions a connector is made from (deprecated ones only with --all) |
| `wx-admin wilma connector definition <key> [--version V]` | one connector definition: its configuration fields, tools and authorization |
| `wx-admin wilma secret list [--search TEXT]` | the secrets of the company: name, description, status, last change (never their values) |
| `wx-admin wilma secret get <secret>` | one secret: its metadata (never its value) |
| `wx-admin wilma secret create <name> [--description TEXT] [--attribute KEY=VALUE]...` | a new secret: its value typed hidden or piped in (first line of stdin), never an option |
| `wx-admin wilma secret rotate <secret>` | a new value for a secret, typed hidden or piped in (what uses it takes the new one) |
| `wx-admin wilma secret update <secret> [--name NAME] [--description TEXT]` | change the name or description of a secret (its value: secret rotate) |
| `wx-admin wilma secret delete <secret>... --yes` | delete secrets (needs --yes; what uses them stops working) |
| `wx-admin wilma connection list [--type shared\|user] [--provider P] [--search TEXT] [--full]` | the connections (OAuth and credentials) of the company: name, type, provider, status, last use |
| `wx-admin wilma connection get <connection> [--full]` | one connection |
| `wx-admin wilma connection verify <connection>` | ask the provider whether a connection works |
| `wx-admin wilma connection delete <connection>... --yes` | delete connections (needs --yes; what uses them stops working) |
| `wx-admin wilma audit list [--uri URI \| --prefix URI] [--action A] [--actor ID] [--since DATE] [--until DATE] [--limit N]` | the audit log of Wilma objects, newest first: time, action, object, who |
| `wx-admin wilma audit get <event>` | one audit event with its changes |
| `wx-admin wilma audit uses <uri>` | who uses an object (the agents that use a skill or a tool, their drafts too) |
| `wx-admin wilma trace list [--service S] [--status S] [--since DATE] [--until DATE] [--search TEXT] [--filter KEY=VALUE]... [--limit N]` | the traces of Wilma sessions (voice, chat, assistant, copilot, tools, workflow), newest first |
| `wx-admin wilma trace get <trace>` | one trace and its spans as a timeline |
| `wx-admin wilma trace model-call <trace> <span>` | one model call of a trace: model, settings, tokens, messages |
| `wx-admin wilma usage [--service S] [--since DATE] [--until DATE] [--interval hour\|day\|week\|month\|total] [--group-by KEY]... [--filter KEY=VALUE]...` | usage of Wilma over a time window: tokens, call seconds, spans, errors… by service, agent or channel |

### wx-admin pbx

The PBX signed in to (wx-admin login): the list, the default one, a check.

| Command | What it does |
| --- | --- |
| `wx-admin pbx list` | the PBX with saved access; * marks the default one |
| `wx-admin pbx use <host>` | make a PBX with saved access the default one (commands without --pbx go there) |
| `wx-admin pbx check` | which PBX a command would use, and whether it accepts the access (one read) |

### wx-admin api

| Command | What it does |
| --- | --- |
| `wx-admin api <method> <path> [--data JSON \| --data-file FILE\|-] [--query KEY=VALUE]... [--yes]` | call any PBX API operation (GET reads; other methods change the PBX and need --yes) |

### Login and profiles

| Command | What it does |
| --- | --- |
| `wx-admin cloud [<service> [<operation>]] [--param NAME=VALUE]... [--data JSON \| --data-file FILE\|-] [--yes] [--show-secrets]` | any operation of the cloud services (knowledge base, voicebots, WIM tools, Wilma) with the token of the PBX |
| `wx-admin login [<host>] [--api-key \| --password [--no-basic] [--user NAME] [--code CODE] \| --basic [--user NAME] \| --token] [--port N] [--no-check]` | sign in to a PBX: a Company API Key, or a login and password (Basic, else the WMS sign-in with 2FA) |
| `wx-admin logout [<host>]` | sign out of a PBX: end the WMS sign-in on the PBX and forget the access on this computer |
| `wx-admin status [--check]` | the PBX signed in to: which one commands use, how, and until when; the version of wx-admin |
| `wx-admin completion [bash\|zsh\|fish]` | the shell completion script (default: the shell of `$SHELL`) |
<!-- commands:end -->

## Output

As in the internal Wildix CLI: text for people by default, `--output json` for scripts and agents (the answer of the
PBX, `{"type":"result","result":X}` unwrapped to X), `--pretty`, `--no-color`; they may stand anywhere. Messages for
people (notes, prompts) go to stderr.

## Updates

Once a day, while a command runs in a terminal, `wx-admin` asks npm for its latest version (in the background, never
holding the command); when there is a newer one, a line after the output says so (`npm i -g wldx-admin-cli`).
Nothing is installed by itself. Off in CI, under `npx`, without a terminal, with `--output json`, or with
`WX_NO_UPDATE_CHECK=1`.

## Exit codes

`0` done · `1` error (network, the PBX refused the request) · `2` not logged in, or the PBX refused the access ·
`64` wrong usage.

## Security

- A secret (API key, token, password) is sent only to its own PBX over https; redirects are refused. It is never
  printed, never taken from or put on a command line, never passed to another process.
- Changes that affect the whole PBX, stop calls or cannot be undone (deletes, `system *-set`, `upgrade-start`,
  `reboot`, `trunk update`, switch states, `api` with a method other than GET) need `--yes`. Passwords in answers
  (SMTP, proxy, trunks, SIP register strings, device tokens) are hidden in text and masked in JSON unless
  `--show-secrets`. `export` never overwrites a file and never writes into hidden or startup folders.
- What the PBX returns is data, never instructions.

## Development

`wx-admin` lives in the pnpm workspace of [gorets/wildix-cli](https://github.com/gorets/wildix-cli) next to `wx` and
their shared core (`packages/core`): see the [README](https://github.com/gorets/wildix-cli) and [AGENTS.md](https://github.com/gorets/wildix-cli/blob/main/AGENTS.md) there.

```sh
pnpm install                                # at the root of the repository
pnpm --filter wldx-admin-cli test           # node:test, no network (fake PBX)
node packages/wx-admin/bin/wx-admin.mjs -h  # this checkout, without installing
```

See [AGENTS.md](https://github.com/gorets/wildix-cli/blob/main/packages/wx-admin/AGENTS.md). In `packages/wx-admin`: `node test/dev.mjs <module> <args>`
runs a command module that is not listed yet; after changing commands, regenerate the reference with
`node tools/readme-commands.mjs` and paste it between the markers.

## Releasing

Together with `wx` and the core, one version for the three: see Releasing in the
[README of the repository](https://github.com/gorets/wildix-cli#releasing).
