# Changelog

## Unreleased

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
