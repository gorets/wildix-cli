# Changelog

## Unreleased

- A group may hold a group: three words name a command (`wx-admin kb source list`), in the router, the help, the
  completion and `commandsOf()` for the README generators.
- A global option may name its key in the context (`key`); one that would take the name of a field of the context
  (`env`, `values`, `token`…) is refused when the program is made.
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
