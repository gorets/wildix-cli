# Changelog

## 1.8.0 — 2026-11-08

- Nothing of its own: released with `wx-admin` 1.8.0 (the company cloud in `config export|import|copy`,
  `system network`) and `wldx-core` 1.8.0.

## 1.7.0 — 2026-11-08

- Nothing of its own: released with `wx-admin` 1.7.0 (`wx-admin kite`) and `wldx-core` 1.7.0.

## 1.6.0 — 2026-11-08

- Nothing of its own: released with `wx-admin` 1.6.0 (`wx-admin integration`) and `wldx-core` 1.6.0.

## 1.5.0 — 2026-11-08

- Nothing of its own: released with `wx-admin` 1.5.0 (`wx-admin wilma`, the masking of the cloud answers) and
  `wldx-core` 1.5.0.

## 1.4.0 — 2026-11-07

- Nothing of its own: released with `wx-admin` 1.4.0 (its own sign-in to the PBX) and `wldx-core` 1.4.0. `wx` keeps
  the x-bees login.

## 1.3.0 — 2026-11-07

- Nothing of its own: released with `wx-admin` 1.3.0 (cloud services: the knowledge base, voicebots, WIM tools,
  Wilma) and `wldx-core` 1.3.0. The check for a newer version waits for npm by itself (on Node 22 its tests could end
  before it).

## 1.2.1 — 2026-11-07

- `wx` says when a newer version is on npm (once a day, one line after the command; `WX_NO_UPDATE_CHECK=1` turns
  it off).

## 1.2.0 — 2026-11-07

- Nothing of its own: released with `wx-admin` 1.2.0 (config export, import and copy) and `wldx-core` 1.2.0 (a
  checkbox picker, hidden input of secrets), one version for the three.

## 1.1.0 — 2026-11-07

- The repository is a pnpm workspace: `wx` is `packages/wx`, next to `wx-admin` (`packages/wx-admin`, npm
  `wldx-admin-cli`) and their shared core `wldx-core` (`packages/core`): the router, output, completion, login,
  profiles, file checks and HTTP, once for both. `wldx-core` of the same version is the only dependency.
- Uploads (`wx file upload`, `wx chat send --file`) also refuse anything hidden in the home folder (`~/.git-credentials`,
  `~/.config/…`, shell histories) and the macOS keychains, as `wx-admin` does after its security review; writes
  (`--to`) also refuse the Windows Startup folder.
- A global option given twice with different values says so the same way for every option (`--profile given twice:
  a and b`).
- Versions 0.1.0 to 1.0.0 (published from the earlier layout of the repository) are deprecated on npm.

## 1.0.0 — 2026-11-07

- Profiles: `--profile EMAIL` (anywhere on the command line) picks the logged-in account; `--account` is gone. The
  first `wx login` makes its account the default profile, `wx profile list` shows the profiles, `wx profile use`
  changes the default (kept in `~/.wildix/wx.json`, 0600), `wx status` says which profile it used and why. With
  several profiles and no default, a command asks for `--profile` or `wx profile use`. One word everywhere: a
  profile is an e-mail you are logged in with. JSON: `login` and `logout` give `profile`; `status` gives `profile`
  ({email, by}), `user` (who you are, from the token) and `profiles`.
- `wx phone call --device` with the active device starts the call on it at once, without ringing it first (told by
  the user, not checked by wx): the help and the text answer say so; without an option the PBX still rings the
  device first.

Everything the public Wildix agent skills do, as `wx` commands (111), so the skills can move to calling
`wx --output json …`. Checked on 2026-11-07 (a Saturday) on a real account: every read-only command live, most of
them compared with the output of the skill scripts on the same request; everything that writes, rings or reaches
people only with tests (fake services).

**Account**
- `wx login` signs in with the one-time code sent by e-mail: it asks in a terminal (three tries), or in two steps
  for scripts and agents (`--send-code`, then `--code` within 3 minutes). `wx logout` revokes the session of this
  device, `--everywhere` of every device. `wx status` shows the account, company, PBX, extension and until when the
  token is valid; `--check` asks Wildix. `wx auth status` is gone. The session stays shared with the `wildix-auth`
  skill. Live: `status`, `status --check`; `login` and `logout` only with tests.

**Output, as in the internal Wildix CLI**
- Text for people by default (one line per item, local times, tables), `--output json` for scripts and agents (the
  data of the service), `--pretty`, `--no-color`; they may stand anywhere. Streaming commands print one line per
  event: `{"event": …, "data": …}` with JSON (the scripts printed `EVENT {json}`). Exit code 3: nothing to show (no
  transcript).

**Chats** (`wx chat`, `channel`, `inbox`, `file`, `user`, `section`; from the wildix-chats skill)
- Messages (read, get, send with files and mentions, edit and delete your own, pin, react, who reacted), mentions,
  search, the live feed (`wx chat watch`, reconnecting with a renewed token in-process); channels (get, search,
  create, 1:1, leave, delete, members, add, remove, read status); the inbox (mark read or unread, mute, pin, hide);
  files (upload, info, download link, download); people (`wx user find` by name, e-mail or phone; `get`; `me`);
  sections. Text output resolves user ids to names.
- Not implemented by the service yet (checked live): `channel query`, `channel member`, `channel update`, `channel
  join`, and `section` except `list`; their help says so.
- Live: list, read, get, reactions, mentions, search, watch (no event arrived), inbox get, section list, channel get,
  members, read-status, search, user me/find/get, file info, download-url and download. Tests only: everything that
  writes.
- Differs from the scripts: `chat delete` needs `--yes`; `files.sh download … OUT` is `wx file download … --to PATH`;
  `inbox.sh read|unread` is `wx inbox mark-read|mark-unread`; `members.sh` is under `wx channel`; `search.sh users`
  is `wx user find`; the file type comes from the extension.

**Calls and meetings on record** (`wx calls`, `meetings`, `conversations`, `reports`; from wildix-calls-history and
the transcript script of wildix-adr-from-meeting)
- The call history and missed calls, a call's record, transcript, summary, insights, characteristics, recordings;
  meetings with their transcript, summary, insights, who spoke when; search of conversations with counts and
  `aggregate` statistics; the x-caracal queue reports (summary, by queue, by period, answered, unanswered, service
  level, calls, events).
- Live and compared with the scripts (identical JSON, except as noted): calls get/brief/insights/summary/
  characteristics/state/transcript, meetings brief/summary/insights/timeframes/transcript, conversations find/count/
  tags/aggregate, every report. Tests only: `schedule-summary`, `meetings recording-url`, `--queue-sla`.
- Differs: `--out FILE` is `--to FILE`, `--json` is `--output json`; `wx calls list` (was `conversations.sh calls`),
  new `calls missed` and `calls recordings`; `calls list --brief` gives the real duration (the script gave 0) and
  counts attachments as recordings; stricter checks of dates and fixed values; the caller's number and name in
  `reports calls|events` only with `--full`.

**Now** (`wx live`; from wildix-live-monitor)
- Queues and agents with today's or the last hour's statistics, calls/chats/conferences in progress, presence, the
  live transcript of a call, and the live feed (`wx live watch`), reconnecting with a renewed token in-process.
- Live and compared with the scripts (byte-identical JSON): queues with every filter and `--stats`, conversations,
  presence, a 25 s watch next to the script. Tests only: the change events, transcript lines, reconnects.
- Differs: `watch --mine` no longer drops a call's end after an annotation.

**Phone** (`wx phone`; from wildix-call-control)
- Your calls on your PBX: list, place (click-to-call), answer, hold, unhold, hang up, transfer (blind, attended,
  through a conference), DTMF, recording, the displayed name; your devices and which one rings; `watch` over SIP.
  The SIP part uses Node built-ins: no `sip.js`, works on Node 22.
- Live: `list`, `devices`, `me`, and `watch` (compared with the script: the same events). Tests only: everything
  that changes a call or a device.
- Differs: `devices.sh list|use` is `wx phone devices|use`; `sip.sh calls` is `wx phone list --sip`; more than one
  of `--mobile`/`--any`/`--device` is refused; the SIP user agent is `wx watcher`.
- Fixed before release: a watch printed a false RECONNECTED when it stopped (the PBX answers the unsubscribe with a
  last NOTIFY).

**Security** (an independent review before the release; each case has a test)
- `wx file download --to` and the `--to` of transcripts never write into a hidden file or folder (`~/.ssh`,
  `~/.zshenv`, `.git/hooks`, …) or a macOS startup folder, also through a symlink.
- Attachments: the check for credentials resolves the whole path (symlinks, the true case of the name on macOS),
  compares without case where the file system does, refuses files with other hard links, and reads the very file it
  checked.
- Text output drops terminal control sequences that come from Wildix data (clipboard writes, cursor moves, hidden
  text); JSON escapes them.
- `wx chat watch` with a token that cannot be renewed reconnects at once only once, then waits (it looped).
- A RefreshToken rotated by Cognito is kept; `--account` finds a session in any case.

## 0.1.1 — 2026-11-07

- Releases go through npm staged publishing: the `release.yml` workflow stages the version on a `v*` tag (trusted
  publishing, provenance), the maintainer approves it with `npm stage approve`. No code changes.

## 0.1.0 — 2026-11-07

Published by hand (`npm publish`).

- First version: `wx chat list|read|send`, `wx auth status`.
- Shell completion: `wx completion bash|zsh|fish`, candidates from `wx __complete` (commands, options, choices,
  saved accounts). Checked: the bash function in bash 3.2 and the zsh function with simulated words; fish not
  checked (not installed).
- Uses the session of the `wildix-auth` agent skill (`~/.wildix/tokens`) and renews an expired token in the same
  format.
