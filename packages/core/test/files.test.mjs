// The guards of local files against paths that came from fetched text (the cases of the security review).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {readForUpload, refuseSecretPath, refuseUnsafeWrite} from '../src/files.mjs';
import {tempConfigDir} from './helpers.mjs';

function home() {
  const h = tempConfigDir();
  const env = {HOME: h, WILDIX_CONFIG_DIR: path.join(h, '.wildix')};
  fs.mkdirSync(path.join(h, '.wildix', 'tokens'), {recursive: true});
  fs.writeFileSync(path.join(h, '.wildix', 'tokens', 'a_at_b.com.prod.json'), '{"IdToken":"secret"}');
  fs.mkdirSync(path.join(h, 'Desktop'));
  return {h, env};
}

test('an upload through a symlink to the token file is refused', () => {
  const {h, env} = home();
  const link = path.join(h, 'Desktop', 'notes.txt');
  fs.symlinkSync(path.join(h, '.wildix', 'tokens', 'a_at_b.com.prod.json'), link);
  assert.throws(() => readForUpload(link, env), /credentials folder/);
});

test('an upload of a credentials folder spelled in another case is refused (case-insensitive file systems)', {
  skip: !['darwin', 'win32'].includes(process.platform),
}, () => {
  const {h, env} = home();
  assert.throws(
    () => readForUpload(path.join(h, '.WILDIX', 'tokens', 'a_at_b.com.prod.json'), env),
    /credentials folder/,
  );
});

test('secret-looking names are refused in any case, and files with other hard links', () => {
  const {h, env} = home();
  for (const name of ['ID_RSA', 'Key.PEM', '.ENV', 'My-Secret.txt']) {
    const f = path.join(h, 'Desktop', name);
    fs.writeFileSync(f, 'x');
    assert.throws(() => refuseSecretPath(f, env), /Refusing/, name);
  }
  const original = path.join(h, 'Desktop', 'plain.txt');
  fs.writeFileSync(original, 'x');
  fs.linkSync(original, path.join(h, 'Desktop', 'other.txt'));
  assert.throws(() => readForUpload(original, env), /hard links/);
});

test('an ordinary file is read for upload', () => {
  const {h, env} = home();
  const f = path.join(h, 'Desktop', 'report.txt');
  fs.writeFileSync(f, 'hello');
  assert.equal(readForUpload(f, env).toString(), 'hello');
  assert.throws(() => readForUpload(path.join(h, 'Desktop', 'nope.txt'), env), /File not found/);
});

test('nothing is written into hidden files or folders, or startup folders', () => {
  const {h, env} = home();
  for (const p of [
    '.ssh/authorized_keys',
    '.zshenv',
    '.bash_profile',
    'project/.git/hooks/pre-commit',
    'node_modules/.bin/wx',
    'Library/LaunchAgents/x.plist',
  ]) {
    assert.throws(() => refuseUnsafeWrite(path.join(h, p), env), /Refusing/, p);
  }
  fs.symlinkSync(path.join(h, '.wildix'), path.join(h, 'Desktop', 'innocent'));
  assert.throws(() => refuseUnsafeWrite(path.join(h, 'Desktop', 'innocent', 'x.txt'), env), /hidden/);
  assert.doesNotThrow(() => refuseUnsafeWrite(path.join(h, 'Desktop', 'transcript.txt'), env));
  assert.doesNotThrow(() => refuseUnsafeWrite(path.join(h, 'Downloads', 'new', 'file.pdf'), env));
});

test('nothing hidden in the home folder is sent (git credentials, shell history, ~/.config), nor the keychains', async () => {
  const {readJsonInput} = await import('../src/files.mjs');
  const {h, env} = home();
  for (const p of ['.git-credentials', '.zsh_history', '.config/gh/hosts.yml', 'Library/Keychains/login.keychain-db']) {
    const f = path.join(h, p);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, '{"secret": "x"}');
    assert.throws(() => readForUpload(f, env), /Refusing/, p);
  }
  // --from and --data-file go through the same check, and a parse error never repeats the content
  await assert.rejects(
    readJsonInput({env, cwd: h}, path.join(h, '.wildix', 'tokens', 'a_at_b.com.prod.json')),
    /Refusing/,
  );
  const bad = path.join(h, 'Desktop', 'bad.json');
  fs.writeFileSync(bad, 'https://secret.example/abc');
  await assert.rejects(
    readJsonInput({env, cwd: h}, bad),
    (e) => /is not JSON/.test(e.message) && !e.message.includes('secret.example'),
  );
});
