// Is there a newer version on npm? Once a day the registry is asked, in the background while the command runs, and
// the answer kept in $WILDIX_CONFIG_DIR/update-check.json; when a newer version is known, one line on stderr after
// the command: "wx 1.2.0 → 1.3.0 is out: npm i -g wldx-cli". Nothing is ever installed.
//
// Silent when it would get in the way: no terminal on stdout or stderr (scripts, agents), --output json, CI,
// under npx (npm_command=exec), shell completion, or turned off with WX_NO_UPDATE_CHECK=1 (or NO_UPDATE_NOTIFIER).
// The registry is never allowed to hold a command: at its end the command waits at most WAIT_MS for an answer.
import fs from 'node:fs';
import path from 'node:path';
import {configDir} from './auth.mjs';
import {program} from './program.mjs';

const DAY = 24 * 3600 * 1000;
const WAIT_MS = 300;
const TIMEOUT_MS = 3000;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

// a > b, for x.y.z releases only (a pre-release or anything else is never newer).
export function isNewer(a, b) {
  const x = RELEASE.exec(String(a));
  const y = RELEASE.exec(String(b));
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i += 1) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

function quiet(argv, io) {
  const env = io.env ?? {};
  if (!io.stdout?.isTTY || !io.stderr?.isTTY) return true;
  if (env.CI || env.WX_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.npm_command === 'exec') return true;
  if (argv.some((a, i) => a === '--output=json' || (a === '--output' && argv[i + 1] === 'json'))) return true;
  const first = argv.find((a) => !a.startsWith('-'));
  return argv.includes('__complete') || first === 'completion';
}

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    fs.writeFileSync(file, `${JSON.stringify(data)}\n`, {mode: 0o600});
  } catch {
    // a check that cannot be kept is simply made again next time
  }
}

// Starts the check for this run; finish() (after the command) prints the line when a newer version is known.
export function startUpdateCheck(argv, io) {
  if (quiet(argv, io)) return {finish: async () => {}};
  const file = path.join(configDir(io.env), 'update-check.json');
  const cache = readCache(file);
  const now = io.now();
  const known = cache[program.pkg];
  let latest = typeof known?.latest === 'string' ? known.latest : undefined;
  let pending;
  let cut = false; // the command ended first: nothing learned, nothing kept (the next run asks again)
  const controller = new AbortController();
  if (!(now - Number(known?.checkedAt) < DAY)) {
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    pending = (async () => {
      try {
        const res = await io.fetch(`https://registry.npmjs.org/${program.pkg.replace('/', '%2f')}/latest`, {
          headers: {accept: 'application/json'},
          signal: controller.signal,
        });
        const version = res.ok ? (await res.json())?.version : undefined;
        if (typeof version === 'string' && RELEASE.test(version)) latest = version;
      } catch {
        // offline, refused, too slow: tried again tomorrow
      } finally {
        clearTimeout(timer);
      }
      if (!cut) writeCache(file, {...cache, [program.pkg]: {latest: latest ?? null, checkedAt: now}});
    })();
  }
  return {
    async finish() {
      if (pending) {
        await Promise.race([
          pending,
          // kept referenced: this short wait must hold the process itself, whatever keeps the request alive
          new Promise((resolve) => setTimeout(resolve, WAIT_MS)),
        ]);
        cut = true;
        controller.abort();
      }
      if (latest && isNewer(latest, program.version))
        io.stderr.write(`${program.name} ${program.version} → ${latest} is out: npm i -g ${program.pkg}\n`);
    },
  };
}
