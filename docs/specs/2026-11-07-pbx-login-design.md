# wx-admin signs in to the PBX itself: login and logout for a PBX, no x-bees login

Date: 2026-11-07 · Status: design approved in conversation, spec for review · Packages: `wx-admin`, `wldx-core`

## 1. Goal

The people who use `wx-admin` are PBX administrators, mostly at customers. They have a WMS login and password (with
two-factor authentication more often than not) and no x-bees account. Today `wx-admin login` is the x-bees login it
shares with `wx`: it asks for "the e-mail of your Wildix account", and then works only on the PBX named in that login,
with the rights of that user. For a customer administrator it is a dead end, and the access that works (a Company API
Key through `pbx add`) is the second thing the help shows.

After this change:

- `wx-admin login [--pbx] <host>` signs in to a PBX. It asks how: a **Company API Key** (recommended, with the reason),
  or the **WMS login and password**. With a login and password it finds the best way itself: **Basic** when the PBX
  accepts it, else the **WMS token sign-in** with the two-factor code, as the WMS web interface does. The password is
  saved, so that it can move from one to the other later by itself (an administrator turns `ALLOW_BASIC_AUTH` on or
  off). Flags choose without the menu (`--api-key`, `--password`, `--basic`, `--token`) for scripts and agents.
- The x-bees login is gone from `wx-admin`: no `login <e-mail>`, `logout` of x-bees, `profile`, `--profile`, nor the
  "PBX of the x-bees login" fallback. `wx` keeps all of it unchanged.
- `wx-admin status` says which PBX the commands go to, with what access and until when.

Success: a customer administrator with only a WMS login, password and authenticator app runs `wx-admin login mypbx`,
answers the menu, the password and the code, and then uses every command without typing them again: with Basic for
good, with the token sign-in as long as it is used at least every 36 hours and the PBX does not restart (at most 15
days, 7 for the root `admin`), after which the saved password signs in again and only the 2FA code is asked. A PBX that offers neither (an older WMS with Basic off)
gets a clear answer that leads to the API key.

The order of preference: **1. Company API Key**, **2. Basic**, **3. the WMS token sign-in** (refresh token).

### What is known

From the public description of the PBX API (operations `authLogin`, `authRefresh`, `authLogout`, `authToken`, tag
Personal) and the WMS login page, confirmed live on a test PBX with a recent WMS 7.11 build, as `admin` with Google
Authenticator:

1. **Availability.** The token endpoints are new in WMS (November 2026 builds); PBX with an older WMS, most PBX of
   customers for now, answer 404 on `/api/v1/auth/login/`. Company API Keys (WMS 7.09+) and Basic work on those.
2. **Sign-in.** `POST /api/v1/auth/login/` (no Authorization header) `{"login", "password", "remember": "1"}`:
   - a second factor pending: `{"type":"result","result":{"next":"<factor>"}}` and the cookie `PHPSESSID`, no token;
     the code goes to the same endpoint, `{"type":"next","code","remember":"1"}`, with that `PHPSESSID`. Factors
     seen in the login page: `googleauthenticator` (an app), `email` and `sms` (the PBX sends the code; `POST
     /api/v1/personal/settings/TwoFactor/<factor>/Code/` sends it again);
   - complete: `result: {access_token, token_type: "Bearer", expires_in}` and the cookie `wms_refresh` (the refresh
     token, path `/api/v1/auth/refresh/`); also `PHPSESSID` and `__rc`;
   - 401: wrong login, password or code, or the request is already authenticated; 403: blocked after too many
     attempts, the login not allowed (licence, mobile access, **a new location to confirm**), or a Company API Key.
3. **Access token**: a JWT, `ACCESS_TOKEN_LIFETIME` (default 3600 s); as `Authorization: Bearer` it is accepted by the
   admin API (live: `PBX/Colleagues`, `PBX/settings/license` 200). `ALLOW_BASIC_AUTH` is not involved.
4. **Renewal.** `POST /api/v1/auth/refresh/` (trailing slash) with the refresh token as the `wms_refresh` cookie **or
   as the `refresh_token` body field** ("for clients without cookies"). The answer is a new access token and a new
   refresh token in `Set-Cookie`, with a new expiry: **sliding**. The refresh token is bound to the PHP session it
   names (its payload holds the session id: to be protected like a session cookie); a logout, a change of the
   password or e-mail, or the session cleaner ends it (401). A renewal writes the session, which keeps it from the
   cleaner. Live: three renewals in a row, each token accepted.
5. **Lifetime of the refresh token**: `REFRESH_TOKEN_LIFETIME` (default 7 days); with `remember` **15 days**, except
   for the root `admin`, who never gets more than `REFRESH_TOKEN_LIFETIME`. The class is kept at every renewal. So a
   sign-in lasts 15 days (7 for `admin`) **from its last use**.
5a. **An idle session is removed after 36 hours** (the PBX's session cleaner deletes session files untouched for
   36 h; a renewal touches it), and **every session is removed when the PBX restarts**. The refresh token dies with
   its session: in practice a token sign-in lasts while it is used at least every 36 hours and the PBX does not
   restart; 7 / 15 days is only the outer limit. Tokens are not rotated (an older refresh token stays valid while its
   session lives). An access token stays valid until its expiry even after a logout, a password change or a restart.
   An invalid or expired Bearer gets `401` with `WWW-Authenticate: Bearer error="invalid_token"`, even next to a valid
   session cookie.
6. **`__rc`** (the remember cookie of the web pages) never signs in the root `admin` (the API description: "never for
   `admin`"): that is why it did nothing in the probes, all made as `admin`. The token client does not need it.
7. **Logout.** `POST /api/v1/auth/logout/` with `{"refresh_token"}` destroys the session of that token (and of the
   request) and clears the cookies; an invalid token is ignored; always 200 (403 for a Company API Key).
8. `POST /api/v1/auth/token/` exchanges a logged-in `PHPSESSID` (or a session re-created by `__rc`) for tokens: for
   pages, not needed here.

## 2. Commands

### `wx-admin login [<host>]`

```
wx-admin login [<host>] [--api-key | --password [--no-basic] [--user NAME] [--code CODE] | --basic [--user NAME]
               | --token]
               [--port N] [--no-check]
```

- The PBX: the argument, else `--pbx` (the global option, same meaning as everywhere), else asked for on a terminal
  (`PBX (name.wildixin.com, name or IP): `). Both an argument and a different `--pbx` is a usage error (64).
- How: one of the flags; else, on a terminal, the menu below (`choose()`, section 5); else, without a terminal, a
  usage error that lists the flags.

```
How should wx-admin sign in to mypbx.wildixin.com?

› 1. Company API Key (recommended)
     Made once in WMS: PBX → Integrations → Company API Keys. Works up to a year
     without a password or a 2FA code, limited to the scopes you give it, and
     revoked in WMS without touching anyone's password. Best for scripts too.
  2. WMS login and password
     Nothing to set up. Uses Basic when the PBX allows it, else signs in as WMS
     does, with your 2FA code. The password is saved on this computer (0600),
     so wx-admin signs in again by itself when the PBX forgets the sign-in
     (unused for 36 hours, or a restart); then only a 2FA code is asked.
```

- **API key** (`--api-key`): before the hidden prompt, the steps: WMS → PBX → Integrations → Company API Keys, the
  scopes (`pbx:read` to read, `pbx:*` for changes and `config import`), that it is shown once. Then as `pbx add
  --api-key` today.
- **Login and password** (`--password`, the access kind `password`): the user (`--user`, else asked with `admin` as
  default), the password (hidden, or the first line of stdin), then, with **one attempt each** (failed attempts may
  count towards the PBX's lockout):
  1. **Basic**: one read (`GET /Dictionaries`) with `Basic`. 200 → mode `basic`, done.
  2. Else the **token sign-in** of section 3 with the same login and password. A token → mode `token`, done.
     `next` → the 2FA code: `--code CODE`, else asked on a terminal, else a usage error ("this PBX asks for a 2FA code
     (googleauthenticator): give --code"); for `email` and `sms` the prompt says the PBX has sent it, an empty answer
     asks the PBX to send it again (once per empty answer).
  3. The token sign-in says the login or password is wrong (401 with its reason) → that error, nothing saved: a
     wrong password, not a Basic that is off (the 401 of step 1 alone cannot tell the two apart).
  4. 404 (no token sign-in on this WMS) after a refused Basic → `AuthError`: "This PBX accepts neither Basic
     (ALLOW_BASIC_AUTH is off) nor the WMS sign-in for tools (it comes with a newer WMS): use a Company API Key
     (wx-admin login <host> --api-key)". A 403 shows the PBX's reason (too many attempts, a new location to confirm
     in WMS, …).
  The output says which way it took and that the password is saved: `Signed in to mypbx.wildixin.com as admin with
  Basic. The password is saved in ~/.wildix/admin/pbx/mypbx.wildixin.com.json (0600): Basic bypasses 2FA, keep this
  computer safe.` or `… with the WMS sign-in (2FA), until 2026-11-22; the password is saved so that wx-admin can sign
  in again by itself (a 2FA code will be asked).`
- **`--no-basic`**: the WMS token sign-in only (steps 2–4), and the access never tries Basic later (`"basic": false`
  saved). With `--no-basic` the password is **not** saved: the sign-in ends when the refresh token does, and a new
  `wx-admin login` asks for the password and the code. For an administrator who keeps nothing on disk that opens the
  PBX without 2FA.
- **`--basic`**: Basic only (step 1), no token fallback at sign-in; the access is the same kind `password`, mode
  `basic`. **`--token`** (Simple Token): flag only, as `pbx add` today (deprecated by Wildix).
- Then, unless `--no-check`, one read of the PBX with the new access (as `pbx add`), the serial recorded. On success
  the access is saved (an access saved before for the host is replaced only now) and, when no default PBX is set,
  this PBX becomes the default one. Output: `Signed in to mypbx.wildixin.com (serial …) with a WMS login (admin),
  until 2026-11-14 16:26. It is the default PBX.`

### `wx-admin logout [<host>]`

The PBX as for `login` (argument, `--pbx`, else the default PBX; no prompt). Forgets the saved access; for a
`password` access it first ends the session on the PBX (`POST /auth/logout/` with the refresh token, section 3); if
the PBX cannot be reached, the file is removed anyway and the output says the session ends by itself at its expiry. When
the removed PBX was the default one, there is no default PBX any more (as `pbx remove`).

### `wx-admin status`

Its own command (the core `status` reads x-bees sessions). No network unless `--check`.

```
wx-admin  1.4.0
PBX       * mypbx.wildixin.com       serial 2211000000ef  admin · WMS sign-in   until 2026-11-22 16:26
            other.example.com:8443                        Company API Key
            lab.wildixin.com                              admin · Basic
          * the default PBX: commands without --pbx go there
```

- Also shown: `WILDIX_PBX_API_KEY for <WILDIX_PBX_HOST>` when set (it wins, as today).
- For a token sign-in the time shown is the earlier of `validUntil` and `lastUsed` + 36 h, as `until about …`, with
  `(sooner if the PBX restarts)` in the help of `status`.
- `--check`: one read per PBX (`GET /Dictionaries`), each line gets `accepted` or the refusal with its hint; a
  `password` access in mode `token` first tries Basic once (moving to it when the PBX now accepts it), else renews. Exit 1 when one is refused, as `--all-pbx`.
- No PBX: `Not signed in to any PBX: wx-admin login <host>`. JSON: `{version, pbxs: [{host, port, serial, auth,
  user?, validUntil?, default, accepted?, error?}], environmentKey: host|null}`.

### `pbx` group

`pbx add` stays, as the same command as `login` (same options, same code); `pbx remove` stays as `logout`; `pbx list`
and `pbx use <host>` stay. Removed: `pbx use --login`, the x-bees row of `pbx list`. `pbx check` stays. The help and
README show `login`/`logout` first.

### The PBX of a command

`--pbx`, else the default PBX, else **the only saved PBX** when there is exactly one, else an `AuthError` (exit 2):
`No PBX chosen: wx-admin login <host>` (none saved) or `Several PBX are saved and none is the default: give --pbx or
run wx-admin pbx use <host>`. `--all-pbx` runs on the saved PBX only. `WILDIX_PBX_API_KEY` with `WILDIX_PBX_HOST`
works as today.

### What goes away

From `wx-admin` only: the core commands `login` (e-mail), `logout` (x-bees), the `profile` group, the global
`--profile`, `WILDIX_EMAIL` in the help, `loginPbx`/`loginPbxOf` and the `auth: 'login'` access, every text that
mentions the x-bees login. The saved x-bees sessions in `$WILDIX_CONFIG_DIR` are left alone: `wx` uses them.
`wldx-core` gets a switch for a CLI without x-bees profiles (section 5).

## 3. The `password` access (`src/wms-login.mjs`)

Saved in `admin/pbx/<host>.json` (0600, written atomically, as every access):

```json
{"host": "...", "port": 443, "auth": "password", "username": "admin", "password": "...", "mode": "basic|token",
 "serial": "...", "refresh": "<refresh token>", "validUntil": "<ISO, the exp of the refresh token>",
 "lastUsed": "<ISO, the last sign-in or renewal>",
 "accessToken": "<JWT>", "accessTokenExpires": "<ISO>"}
```

The password is always saved: the file is the most sensitive one wx-admin keeps (with Basic it opens the PBX without
2FA), as the `basic` access is today. Never saved: the 2FA code, `PHPSESSID` (only between the two steps of a
sign-in) and `__rc`. The refresh token holds the PHP session id. The operating system's keychain (macOS Keychain,
libsecret) is left for later; the file stays 0600 in a 0700 folder.

An access saved before as `auth: "basic"` (`pbx add --basic`) is read as `password` with mode `basic`.

- **Token sign-in**: `signIn({host, port, username, password, askCode, fetch})` runs point 2 of section 1 with
  `remember: "1"` and `redirect: 'manual'` (a redirect is refused, as for every access); `PHPSESSID` is carried from
  the first step to the second in memory only; the refresh token is read from the `wms_refresh` of `Set-Cookie`, its
  expiry from the `exp` of its payload (else `Max-Age`).
- **Mode `basic`**: `Authorization: Basic …` on every request. A 401 → the token sign-in with the saved password
  (Basic turned off, or the password changed): a token → mode `token` and the request is retried; `next` → the 2FA
  code on a terminal, else `AuthError` (exit 2) "Basic is no longer accepted by <host> and its WMS sign-in asks for a
  2FA code: wx-admin login <host>"; wrong password → `AuthError` "The password of admin on <host> has changed:
  wx-admin login <host>".
- **Mode `token`**: the saved access token while it has more than 60 s left (by its `exp`); else `POST
  /api/v1/auth/refresh/` with `{"refresh_token"}` in the body (no Authorization header); the new access token, the new
  refresh token (from `Set-Cookie`) and its expiry are saved at once. Long commands (`config copy`, `--all-pbx`) get a
  fresh header per request. A 401 from the API with a token that should still be valid (a clock that is off): one
  renewal and one retry.
- **The refresh refused** (unused for 36 hours, a PBX restart, 15 days, 7 for `admin`; a logout or a password change
  in WMS): first **Basic**,
  once (an administrator may have turned it on) → mode `basic`; else the token sign-in with the saved password, as in
  mode `basic`. Basic is tried again only here, at `login` and at `status --check`, never on every command (each
  failed attempt may count towards the lockout).
- **Two commands at once**: a renewal re-reads the file first; when its refresh is refused, it re-reads the file once
  more and, if another process has saved a newer refresh token or mode meanwhile, uses that. (Server side, an older
  refresh token stays valid while its session lives, so a race costs nothing; the re-read is a guard.)
- **Logout**: mode `token`: `POST /api/v1/auth/logout/` `{"refresh_token"}`; then the file (with the password) is
  removed.
- The password, tokens and Basic header are sent only to their PBX over https; the refresh token only to
  `/api/v1/auth/refresh/` and `/api/v1/auth/logout/`. None is ever printed, logged, or put on a command line or in
  the environment of a child process.

## 4. Other changes found on the way

- A 403 from the PBX exits 2, as the help says ("the access was refused"); today only 401 does.
- `acl list` and `acl get` as other names of `acl groups` and `acl group` (every other group says list/get).
- The summary of the `config` group names `export`, `import` and `copy`.
- "Unknown command: wx-admin acl list" says `wx-admin` once (`wldx-core/cli`).
- `config import` log line: the access as `password (admin)`, `apikey`, … (no "x-bees login").
- The 403 hint of a `password` or `basic` access: "this user needs the Admin role and the ACL of the menu".

## 5. `wldx-core`

- `createMain(spec)`: `spec.profiles === false` drops `--profile` from the global options, the help and completion,
  and gives no `freshToken`/`token` to commands. Default stays as today (`wx`).
- `wldx-core/select` has only the checkbox tree. New: `choose(io, {title, items: [{label, note}]})` → the index, a
  single-choice list on stderr with ↑/↓, Enter, 1–9, Esc or Ctrl-C to cancel (`UsageError('Cancelled')`, as the picker), and a
  numbered prompt (`Choose 1 or 2:`) when the terminal has no raw mode.

## 6. Docs and release

- wx-admin README: quick start with `wx-admin login mypbx`; the access in this order: Company API Key (recommended,
  why); login and password, which uses Basic when `ALLOW_BASIC_AUTH=true` (no 2FA: say so) else the WMS token
  sign-in (2FA, 15 days from the last use, 7 for `admin`, a recent WMS), the password saved in both cases and why;
  Simple Token last (deprecated). No x-bees login.
- AGENTS of wx-admin, root README row, `announce/{ru,en}.md`, the CHANGELOGs (wx-admin: Added, Changed, **Removed**;
  wldx-core: `profiles: false`, the picker; wx: nothing of its own).
- Version 1.4.0 for the three packages (lockstep). The announcement page of wx-admin is republished after the release.

## 7. Tests

- `wms-login`: token sign-in without 2FA, with `googleauthenticator`, with `email` (empty answer → resend), wrong
  password, wrong code, 403 with a reason, refresh token read from `Set-Cookie`, `PHPSESSID` never saved, redirect
  refused; renewal with `refresh_token` in the body, the new refresh token saved; a 401 of the API → one renewal and
  retry; the race of two processes.
- The choice at `login --password`: Basic accepted → mode `basic` and no token sign-in; Basic refused and token
  sign-in works → mode `token`; Basic refused and wrong password → the wrong-password error, nothing saved; Basic
  refused and 404 → the API-key hint; exactly one attempt of each (counted in the fake PBX).
- Moving between modes: `basic` + 401 → token sign-in, mode `token` saved, request retried; `token` + refresh refused
  → Basic tried once → mode `basic`; else sign-in again with the saved password (2FA: code on a TTY, else exit 2 with
  `wx-admin login <host>`); a changed password → its error; Basic never tried on an ordinary renewal.
- An old `auth: "basic"` file works as `password` mode `basic`.
- `login`: menu on a TTY (API key first), flags without the menu, no TTY and no flag → 64, argument and `--pbx`
  together → 64, `--code` without TTY, the default PBX set only when none was, failure keeps the old access.
- `status`: no PBX, several, the environment key, `--check` with one refused (exit 1), JSON shape.
- The PBX of a command: only one saved → it; several without default → exit 2 with the hint; no x-bees fallback.
- `wx-admin` has no `profile`, no `--profile`, no x-bees `login`; `wx` still has them (core tests unchanged).
- Secrets: no password, code, token or cookie in any output, log or error (a test over every text of the flow).
- Live, once, on the test PBX (Basic on, the token sign-in present): `login --password` → mode `basic`; `login
  --password` with the saved Basic access file turned to mode `token` by hand (or on a PBX with Basic off) → the
  token sign-in with the code typed by the user; a command; a renewal (the saved access token removed); `status
  --check`; `logout` (then the old refresh token is refused). On a PBX of a released WMS with Basic off: the API-key
  hint.

## Review focus

1. Lockout: no path may try a wrong password more than once per command (Basic and the token sign-in together count
   as two attempts at most), and Basic is never retried on every request.
2. A Basic 401 that means "Basic is off" and one that means "wrong password" look the same: the decision must come
   from the token sign-in's answer, never from the Basic 401 alone.
3. The race of two commands renewing or changing mode at once (re-read the file, never lose a newer refresh token).
4. Piped password and no code: the error must say `--code`, not hang on a prompt; a factor we do not know is asked
   as "the code of <factor>".
5. The password file: 0600 in a 0700 folder, never printed (errors included), removed by `logout`.

## Later

- The saved password will also serve other ways in to the PBX that need it (an SSH access to read logs is planned);
  this spec only keeps it.
- The operating system's keychain for the password instead of the 0600 file.
