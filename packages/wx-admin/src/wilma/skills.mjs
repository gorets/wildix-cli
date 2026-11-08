// Skills and their files: `export --to DIR` writes skill.json and every file of the skill at its path in a new folder;
// `create --from DIR` uploads the files of that folder (UploadSkillFile, then a presigned PUT without the token) and
// creates the skill with them. A skill as one JSON file (no files, or files of this company by id) works too.
import fs from 'node:fs';
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload, readJsonInput, refuseUnsafeWrite} from 'wldx-core/files';
import {apiPath} from 'wldx-core/http';
import {checkNewFile} from '../commands/records.mjs';
import {findObject, getObject, getVersion, KINDS, masked, pickFields, wholeNumber, wilmaClient} from './api.mjs';
import {refuseMasked} from './versioned.mjs';

const kind = KINDS.skills;
const SKILL_JSON = 'skill.json';
const FILE_PATH = /^[a-zA-Z0-9](?:[a-zA-Z0-9._/-]*[a-zA-Z0-9_])?$/; // the pattern of SkillFile.path

// A path of a skill file that stays inside any folder: relative, with no hidden part (.git, .envrc) and so no `..`.
export const isSkillFilePath = (p) =>
  FILE_PATH.test(String(p)) &&
  !String(p)
    .split('/')
    .some((s) => s === '' || s.startsWith('.'));

// The place of a skill file in a folder: a relative path that stays inside it, with no hidden part.
function inside(dir, p) {
  if (!isSkillFilePath(p)) throw new UsageError(`Not a path of a skill file: ${p}`);
  const full = path.resolve(dir, p);
  if (!full.startsWith(dir + path.sep)) throw new UsageError(`Not a path of a skill file: ${p}`);
  return full;
}

// A file of a skill folder to upload: no symbolic link on the way, and its real place inside the real folder.
function localFile(dir, p) {
  const full = inside(dir, p);
  for (let at = full; at.startsWith(dir + path.sep); at = path.dirname(at))
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink())
      throw new UsageError(`${p} is a symbolic link: a skill folder holds its files, never links`);
  if (fs.existsSync(full) && !fs.realpathSync(full).startsWith(fs.realpathSync(dir) + path.sep))
    throw new UsageError(`Not a path of a skill file: ${p}`);
  return full;
}

// A --from file or folder the skill commands can take: files listed without an id need their folder.
export function checkSkillFrom(data, from) {
  if ((data.files ?? []).some((f) => !f.id))
    throw new UsageError(`${from} lists files without an id: give the folder of the export (--from DIR)`);
}

// A file of skill.json: its id lets `skill update --from skill.json` keep it; `create --from DIR` uploads it again.
const fileEntry = (f) => pickFields(f, ['id', 'path', 'name', 'size', 'executable']);
const uploadEntry = (f) => pickFields(f, ['path', 'name', 'size', 'executable']);

export const skillExport = {
  summary: 'write a skill to a new folder: skill.json and its files (masked unless --show-secrets)',
  usage: 'wx-admin wilma skill export <skill> [--version N] --to DIR [--show-secrets]',
  options: {
    version: {type: 'string', placeholder: 'N', description: 'a published version (default: the draft)'},
    to: {type: 'string', placeholder: 'DIR', description: 'the new folder'},
    'show-secrets': {type: 'boolean', description: 'keep keys and tokens in skill.json (written with mode 0600)'},
  },
  args: [1, 1],
  async run(ctx) {
    if (!ctx.values.to) throw new UsageError('Give the folder: --to DIR', ctx.usage());
    const version = ctx.values.version === undefined ? undefined : wholeNumber(ctx.values.version, 'version');
    const dir = checkNewFile(ctx, ctx.values.to);
    const client = await wilmaClient(ctx);
    const found = await findObject(client, kind, ctx.positionals[0]);
    const obj = await getObject(client, kind, found.id);
    const def = version === undefined ? obj : (await getVersion(client, kind, obj.id, version))?.definition;
    const files = def.files ?? [];
    for (const f of files) inside(path.resolve(dir), f.path); // every path checked before anything is written
    const real = refuseUnsafeWrite(dir, ctx.env);
    fs.mkdirSync(real);
    for (const f of files) {
      const link = await client.call('GET', apiPath`/v2/skills/files/items/${f.id}/download`);
      if (!link?.url) throw new Error(`No download link for ${f.path}`);
      const res = await client.raw('GET', link.url);
      if (!res.ok) throw new Error(`The download of ${f.path} failed (${res.status})`);
      const target = inside(real, f.path);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()), {flag: 'wx', mode: f.executable ? 0o755 : 0o644});
    }
    const data = masked(ctx, {
      ...pickFields(def, kind.createFields),
      files: files.map(fileEntry),
      ...(version === undefined ? {id: obj.id, revision: obj.revision} : {}),
    });
    fs.writeFileSync(path.join(real, SKILL_JSON), `${JSON.stringify(data, null, 2)}\n`, {
      flag: 'wx',
      mode: ctx.values['show-secrets'] ? 0o600 : 0o644,
    });
    return {folder: real, id: obj.id, name: obj.name, version: version ?? 'draft', files: files.length};
  },
  text: (r) =>
    `Wrote the skill ${r.name} (${r.id}, ${r.version === 'draft' ? 'draft' : `v${r.version}`}) and ${r.files} file${r.files === 1 ? '' : 's'} to ${r.folder}`,
};

export const skillCreate = {
  summary: 'create a skill from an export: a folder (skill.json and its files, uploaded first) or a JSON file',
  usage: 'wx-admin wilma skill create --from DIR|FILE',
  options: {
    from: {
      type: 'string',
      placeholder: 'DIR|FILE',
      description: 'the folder of an export, or a JSON file (- for stdin)',
    },
  },
  args: [0, 0],
  async run(ctx) {
    const from = ctx.values.from;
    if (!from) throw new UsageError('Give the skill: --from DIR|FILE', ctx.usage());
    const full = from === '-' ? null : path.resolve(ctx.cwd ?? process.cwd(), from);
    const isDir = full && fs.existsSync(full) && fs.statSync(full).isDirectory();
    const data = isDir ? await readJsonInput(ctx, path.join(full, SKILL_JSON)) : await readJsonInput(ctx, from);
    refuseMasked(data, from);
    if (!isDir) checkSkillFrom(data, from);
    // Every file is read and checked before anything is uploaded.
    const local = isDir
      ? (data.files ?? []).map((f) => ({entry: uploadEntry(f), bytes: readForUpload(localFile(full, f.path), ctx.env)}))
      : [];
    const client = await wilmaClient(ctx);
    const files = isDir ? [] : data.files;
    for (const {entry, bytes} of local) {
      const name = entry.name ?? path.basename(entry.path);
      const up = await client.call('POST', '/v2/skills/files', {json: {name, size: bytes.length}});
      if (!up?.fileId || !up?.uploadUrl) throw new Error(`No upload link for ${entry.path}`);
      const res = await client.raw('PUT', up.uploadUrl, {body: bytes});
      if (!res.ok) throw new Error(`The upload of ${entry.path} failed (${res.status}): no skill was created`);
      files.push({...entry, id: up.fileId, name, size: bytes.length});
    }
    const body = {...pickFields(data, kind.createFields), ...(files?.length ? {files} : {})};
    const made = (await client.call('POST', kind.base, {json: body}))?.skill;
    return masked(ctx, {...(made ?? {name: body.name}), uploaded: local.length});
  },
  text: (o) =>
    `Created the skill ${o.name}${o.id ? ` (${o.id})` : ''}${o.uploaded ? ` with ${o.uploaded} file${o.uploaded === 1 ? '' : 's'}` : ''}`,
};
