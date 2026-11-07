// Local files that commands read or write on behalf of the user, where the path may have come from fetched text
// (an agent asked to "save the attachment to …" or to "attach …"): the guards that keep secrets in and startup
// files out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configDir} from './auth.mjs';
import {UsageError} from './errors.mjs';

// macOS and Windows file systems ignore case by default: compare paths without it there.
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const norm = (p) => (FOLD ? p.toLowerCase() : p);
const within = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + path.sep);

// The real path (symlinks resolved, true case on macOS) of a path that may not exist yet: the nearest existing
// ancestor resolved, the rest appended.
export function realPath(p) {
  const abs = path.resolve(p);
  let head = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const up = path.dirname(head);
      if (up === head) return abs;
      rest.unshift(path.basename(head));
      head = up;
    }
  }
}

const homeOf = (env) => env.HOME || os.homedir();

// Where a file written for the user must never land: anything hidden (a segment that starts with ".": ~/.ssh,
// ~/.zshenv, .git/hooks, node_modules/.bin…) and the macOS startup folders. A downloaded file there could give
// someone a login or run code; a person who really wants it there can move it.
const STARTUP = [
  'Library/LaunchAgents',
  'Library/LaunchDaemons',
  'Library/StartupItems',
  path.join('AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
];

// Returns the real path; throws a UsageError for a path that is refused.
export function refuseUnsafeWrite(target, env = process.env) {
  const real = realPath(target);
  const hidden = real.split(path.sep).find((s) => s.startsWith('.') && s !== '.' && s !== '..');
  if (hidden)
    throw new UsageError(
      `Refusing to write into a hidden file or folder (${hidden}): ${target}. Choose a visible path.`,
    );
  const homes = [homeOf(env), realPath(homeOf(env))];
  if (homes.some((h) => STARTUP.some((d) => within(real, path.join(h, d)) || within(real, path.join('/', d))))) {
    throw new UsageError(`Refusing to write into a startup folder: ${target}`);
  }
  return real;
}

// Credentials: folders and files that hold keys and tokens, and names that look like secrets.
const SECRET_FOLDERS = [
  '.wildix',
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.claude',
  '.agents',
];
const SECRET_FILES = ['.netrc', '.npmrc'];
const SECRET_NAME =
  /^(\.env|\.env\..*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.kdbx|credentials.*\.json|.*secret.*|.*\.token)$/is;

// A file to send out of the machine (an attachment) is refused when it is, or points to, a credential: its real
// path (symlinks resolved, true case) in a credentials folder, a secret-looking name (given or real), or a file with
// other hard links (which could be one). The user can copy the file elsewhere if they really mean it.
export function refuseSecretPath(file, env = process.env) {
  let real;
  let stat;
  try {
    real = fs.realpathSync.native(file);
    stat = fs.statSync(real);
  } catch {
    real = realPath(file); // not there (yet): its folder still counts
  }
  const home = homeOf(env);
  const roots = [home, realPath(home)];
  const folders = [
    configDir(env),
    realPath(configDir(env)),
    ...roots.flatMap((h) => SECRET_FOLDERS.map((d) => path.join(h, d))),
  ];
  const files = roots.flatMap((h) => SECRET_FILES.map((f) => path.join(h, f)));
  if (folders.some((d) => within(real, d)) || files.some((f) => norm(f) === norm(real))) {
    throw new UsageError(`Refusing to attach a file from a credentials folder: ${file}`);
  }
  // Anything hidden in the home folder (~/.git-credentials, ~/.config/…, shell histories) and the macOS keychains.
  for (const h of roots) {
    if (!within(real, h)) continue;
    const hidden = path
      .relative(h, real)
      .split(path.sep)
      .find((seg) => seg.startsWith('.'));
    if (hidden || within(real, path.join(h, 'Library', 'Keychains')))
      throw new UsageError(
        `Refusing to send a hidden file or one from a hidden folder of your home (${hidden ?? 'Library/Keychains'}): ${file}`,
      );
  }
  for (const name of new Set([path.basename(file), path.basename(real)])) {
    if (SECRET_NAME.test(name)) throw new UsageError(`Refusing to attach what looks like a secret: ${name}`);
  }
  if (stat?.isFile() && stat.nlink > 1)
    throw new UsageError(`Refusing to attach a file with other hard links (it could be a credential): ${file}`);
  return {real, stat};
}

// Reads a file to send out: checked with refuseSecretPath, then read from the descriptor that was opened, which
// must still be the file that was checked (nothing can be swapped in between).
export function readForUpload(file, env = process.env) {
  const {real, stat} = refuseSecretPath(file, env);
  if (!stat) throw new UsageError(`File not found: ${file}`);
  if (!stat.isFile()) throw new UsageError(`Not a file: ${file}`);
  const fd = fs.openSync(real, 'r');
  try {
    const now = fs.fstatSync(fd);
    if (now.ino !== stat.ino || now.dev !== stat.dev || now.nlink > 1)
      throw new UsageError(`The file changed while it was checked: ${file}`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// JSON for --from / --data-file: a file (checked as anything sent out: no credentials, nothing hidden in the home
// folder) or - for stdin. A parse error names the place, never the content.
export async function readJsonInput(ctx, from) {
  let text;
  if (from === '-') {
    const chunks = [];
    for await (const c of ctx.stdin) chunks.push(Buffer.from(c));
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = readForUpload(path.resolve(ctx.cwd ?? process.cwd(), from), ctx.env).toString('utf8');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const at = /position (\d+)/.exec(e.message)?.[1];
    throw new UsageError(`${from === '-' ? 'stdin' : from} is not JSON${at ? ` (at character ${at})` : ''}`);
  }
}
