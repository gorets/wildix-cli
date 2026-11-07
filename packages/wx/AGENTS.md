# AGENTS.md — wx

`wldx-cli`, the npm package of the unofficial Wildix command line `wx`. It acts as the **logged-in user** (x-bees
login), never as a bot or a service account. The services are internal product APIs, not a public contract.

The router, output, completion, login, profiles, file checks and HTTP are in the core (`packages/core`, npm
`wldx-core`); what a spec, a command and the context are, and the rules for every package: the
[AGENTS.md of the repository](../../AGENTS.md). This file holds what is particular to `wx`.

## Layout

```
bin/wx.mjs               entry: runs src/cli.mjs, sets process.exitCode
src/cli.mjs              setProgram('wx') and the spec: the commands and the exit codes in the help
src/commands/index.mjs   the groups (wx <group> <command>) and single commands (wx <command>), in the order of the help
src/commands/<name>.mjs  one group {summary, auth?, commands: {name: Command}} or single commands
src/stream.mjs           the chat service client, channel and message ids
src/chat, src/history, src/live, src/phone   helpers per domain
test/*.test.mjs          node:test, no network (fetch is injected); test/helpers.mjs: run(), fakeFetch(), fakeJwt()
```

## Rules

- Commands and options follow the scripts of the agent skills (names, arguments, defaults, limits), so a skill can
  move to `wx --output json …` with the same behaviour. Where the CLI differs, say so in the CHANGELOG.
- **The token** goes only to the addresses of `wldx-core/services` (hosts under wildix.com, the x-bees API, the
  user's own PBX from the token claims) and to Cognito; never on a command line, never into the environment of a
  child process, never printed, never in an error message. Requests refuse redirects. A presigned upload or
  download URL gets no token.
- Exit code 3: nothing to show (no transcript), besides those of the core.
