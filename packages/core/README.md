# wldx-core

**Version 1.4.1** · unofficial · MIT

The shared core of the unofficial Wildix command lines [`wx`](https://www.npmjs.com/package/wldx-cli) and
[`wx-admin`](https://www.npmjs.com/package/wldx-admin-cli): the router (global options anywhere, text or JSON
output, exit codes), shell completion, the Wildix login with profiles (`login`, `logout`, `status`, `profile`), the
checks of files to send or write, and HTTP with safe paths.

It is not meant to be used on its own: install one of the command lines. Its API follows them and changes with
them; each command line depends on the core of exactly its own version.

Code, the description of a spec and of a command, and the rules: [gorets/wildix-cli](https://github.com/gorets/wildix-cli)
(`packages/core`, `AGENTS.md`).
