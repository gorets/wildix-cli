# Changelog

## 1.6.0 — 2026-11-08

- Nothing of its own: released with `wx-admin` 1.6.0 (`wx-admin integration`, the integrations of the WIM console),
  one version for the three.

## 1.5.0 — 2026-11-08

- Nothing of its own: released with `wx-admin` 1.5.0 (`wx-admin wilma`, the masking of the cloud answers), one
  version for the three.

## 1.4.0 — 2026-11-07

- A command line without the x-bees login: `profiles: false` in the spec drops `--profile`, its help line and
  completion, and the token of the context (`wx-admin`).
- `choose()` in `wldx-core/select`: a single-choice menu (arrows, digits, Enter; disabled items with a reason; notes
  of several lines). `askLine()` in `wldx-core/secret`: an answer typed in a terminal, echoed, with a default; never
  read from piped stdin, which may carry a secret.
- "Unknown command" names the program once (`wx-admin: Unknown command: acl nope`).

## 1.3.0 — 2026-11-07

- Fixed: the short wait for npm at the end of a command holds the process by itself (Node 22 could end the run
  before it when nothing else did).
- A group may hold a group: three words name a command (`wx-admin kb source list`), in the router, the help, the
  completion and `commandsOf()` for the README generators.
- A global option may name its key in the context (`key`); one that would take the name of a field of the context
  (`env`, `values`, `token`…) is refused when the program is made.

## 1.2.1 — 2026-11-07

- A check for a newer version on npm, once a day in the background (`$WILDIX_CONFIG_DIR/update-check.json`): one
  line on stderr after the command when there is one; never in CI, under `npx`, without a terminal, with `--output
  json`, or with `WX_NO_UPDATE_CHECK=1`; the registry never holds a command (at most 300 ms at its end).

## 1.2.0 — 2026-11-07

- `wldx-core/select`: a checkbox tree for the terminal without dependencies (groups, badges, items that bring
  others, items that cannot be chosen with the reason, a filter); the terminal is always given back.
- `wldx-core/secret`: hidden input of a secret (moved from `wx-admin`).

## 1.1.0 — 2026-11-07

- The first version: the shared core of `wx` (`wldx-cli`) and `wx-admin` (`wldx-admin-cli`), taken out of their
  copies. `createMain(spec)`: the router, the global options anywhere (those of the spec too: `--pbx`, `--all-pbx`),
  text or JSON output, exit codes, a wrapper around a command (`around`); completion from the spec, with its own
  value lists (`completers`); `login`, `logout`, `status`, `profile`; the Wildix login and sessions (the format of
  the wildix-auth skill); the checks of files to send (the stricter ones of `wx-admin`) and to write; HTTP with safe
  paths; the addresses of the services. `setProgram()` names the program in every message, help and script.
