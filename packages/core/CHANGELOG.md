# Changelog

## 1.1.0 — unreleased

- The first version: the shared core of `wx` (`wldx-cli`) and `wx-admin` (`wldx-admin-cli`), taken out of their
  copies. `createMain(spec)`: the router, the global options anywhere (those of the spec too: `--pbx`, `--all-pbx`),
  text or JSON output, exit codes, a wrapper around a command (`around`); completion from the spec, with its own
  value lists (`completers`); `login`, `logout`, `status`, `profile`; the Wildix login and sessions (the format of
  the wildix-auth skill); the checks of files to send (the stricter ones of `wx-admin`) and to write; HTTP with safe
  paths; the addresses of the services. `setProgram()` names the program in every message, help and script.
