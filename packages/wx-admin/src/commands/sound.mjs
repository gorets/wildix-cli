// wx-admin sound: the sound files of a PBX (music on hold, ring tones, prompts) and their folders.
// Operations (PBX REST API; Company API Key scope sounds):
//   GET    /Sounds/{path}/              a folder: records [{name, path, size, isDir, isDefault, modified, formats}]
//                                      (the root is /Sounds/; a folder lists ".." first)
//   POST   /Sounds/                    multipart: file (the sound; its file name names it), directory
//   PUT    /Sounds/{path}/             {name} renames a sound, {move: folder} moves it
//   DELETE /Sounds/{path}/             delete a sound
//   POST   /Sounds/directory/          {path} makes a folder (letters, digits and _ only)
//   PUT    /Sounds/directory/{path}/   {name} renames a folder, {move: folder} moves it
//   DELETE /Sounds/directory/{path}/   delete a folder
// The PBX converts an uploaded sound to its own formats (a .wav is listed as .opus with ALAW, G729… versions).
import path from 'node:path';
import {UsageError} from 'wldx-core/errors';
import {readForUpload} from 'wldx-core/files';
import {localTime, paint, table} from 'wldx-core/format';
import {pbxClient} from '../pbx.mjs';
import {segmentsPath} from './records.mjs';

const SCOPE = {scope: 'sounds'};
const FOLDER = /^[A-Za-z0-9_]{1,64}$/;

const TYPES = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.gsm': 'audio/gsm',
  '.alaw': 'audio/basic',
  '.ulaw': 'audio/basic',
  '.g729': 'audio/g729',
  '.sln': 'audio/basic',
};

const trimSlashes = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '');

// /Sounds/ or /Sounds/<encoded path>/
const soundsPath = (p) => (trimSlashes(p) ? `/Sounds/${segmentsPath(trimSlashes(p), 'sound path')}/` : '/Sounds/');

const checkFolder = (p, what = 'folder') => {
  const parts = trimSlashes(p).split('/');
  if (!trimSlashes(p) || parts.some((s) => !FOLDER.test(s)))
    throw new UsageError(`A ${what} name is letters, digits and _ (the PBX allows no other): ${p}`);
  return parts.join('/');
};

const listFolder = async (client, folder) =>
  (await client.call('GET', soundsPath(folder), undefined, SCOPE))?.records ?? [];

const withoutExt = (p) => p.replace(/\.[A-Za-z0-9]{1,5}$/, '');

// The entry of a sound or folder, found in its parent folder: {path, name, isDir, …}.
async function entryOf(client, ref) {
  const full = trimSlashes(ref);
  if (!full) throw new UsageError('Give the path of a sound or folder (wx-admin sound list)');
  const at = full.lastIndexOf('/');
  const parent = at < 0 ? '' : full.slice(0, at);
  const last = full.slice(at + 1);
  const entries = (await listFolder(client, parent)).filter((e) => e.name !== '..');
  const found =
    entries.find((e) => e.path === full) ??
    entries.find((e) => withoutExt(e.path) === withoutExt(full)) ??
    entries.find((e) => e.name === last);
  if (!found)
    throw Object.assign(
      new Error(`No sound or folder ${full} on this PBX (wx-admin sound list${parent ? ` ${parent}` : ''})`),
      {status: 404},
    );
  return found;
}

const itemPath = (e) => (e.isDir ? `/Sounds/directory/${segmentsPath(e.path, 'folder')}/` : soundsPath(e.path));

const sizeText = (bytes) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

export const groups = {
  sound: {
    summary: 'sound files (music on hold, ring tones, prompts) and their folders: list, upload, rename, move, delete',
    commands: {
      list: {
        summary: 'the sounds and folders of a folder (the top one by default)',
        usage: 'wx-admin sound list [<folder>]',
        options: {},
        args: [0, 1],
        async run(ctx) {
          const records = (await listFolder(await pbxClient(ctx), ctx.positionals[0] ?? '')).filter(
            (e) => e.name !== '..',
          );
          return {folder: trimSlashes(ctx.positionals[0] ?? ''), records};
        },
        text(r, ctx) {
          const c = paint(ctx);
          if (!r.records.length) return `No sounds in ${r.folder || 'the top folder'}`;
          const rows = [...r.records].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
          return table(
            rows.map((e) => [
              e.isDir ? c.blue(`${e.path}/`) : e.path,
              e.isDir ? '' : sizeText(e.size ?? 0),
              e.modified ? localTime(e.modified * 1000) : '',
              e.isDefault ? c.dim('default') : '',
            ]),
          );
        },
      },
      upload: {
        summary: 'upload a sound file (the PBX converts it to its formats)',
        usage: 'wx-admin sound upload <file> [--to FOLDER] [--name NAME]',
        details:
          'A sound of the same name in that folder is replaced. The name is the file name without its extension unless --name gives one.',
        options: {
          to: {
            type: 'string',
            placeholder: 'FOLDER',
            description: 'the folder of the PBX to put it in (default: the top one)',
          },
          name: {type: 'string', placeholder: 'NAME', description: 'the name of the sound (letters, digits, _ and -)'},
        },
        args: [1, 1],
        async run(ctx) {
          const local = path.resolve(ctx.cwd ?? process.cwd(), ctx.positionals[0]);
          const ext = path.extname(local).toLowerCase();
          const name = ctx.values.name ?? path.basename(local, path.extname(local));
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(name))
            throw new UsageError(
              `A sound name is letters, digits, _ and -: ${name}${ctx.values.name ? '' : ' (rename the file, or give --name)'}`,
            );
          const folder = ctx.values.to === undefined || !trimSlashes(ctx.values.to) ? '' : checkFolder(ctx.values.to);
          const bytes = readForUpload(local, ctx.env);
          const form = new FormData();
          form.append('file', new Blob([bytes], {type: TYPES[ext] ?? 'application/octet-stream'}), `${name}${ext}`);
          form.append('directory', folder);
          await (await pbxClient(ctx)).request('POST', '/Sounds/', {data: form, scope: 'sounds', timeoutMs: 300_000});
          return {name, folder, file: local, bytes: bytes.length};
        },
        text: (r) => `Uploaded ${r.folder ? `${r.folder}/` : ''}${r.name} (${sizeText(r.bytes)})`,
      },
      rename: {
        summary: 'rename a sound or a folder',
        usage: 'wx-admin sound rename <path> <new-name>',
        options: {},
        args: [2, 2],
        async run(ctx) {
          const [ref, name] = ctx.positionals;
          const client = await pbxClient(ctx);
          const e = await entryOf(client, ref);
          if (e.isDir) checkFolder(name, 'folder');
          else if (!/^[A-Za-z0-9_-]{1,100}$/.test(name))
            throw new UsageError(`A sound name is letters, digits, _ and - (no extension): ${name}`);
          await client.call('PUT', itemPath(e), {name}, SCOPE);
          return {path: e.path, folder: Boolean(e.isDir), name};
        },
        text: (r) => `Renamed ${r.folder ? 'the folder' : 'the sound'} ${r.path} to ${r.name}`,
      },
      move: {
        summary: 'move a sound or a folder into another folder',
        usage: 'wx-admin sound move <path> <folder>',
        options: {},
        args: [2, 2],
        async run(ctx) {
          const [ref, to] = ctx.positionals;
          const folder = checkFolder(to);
          const client = await pbxClient(ctx);
          const e = await entryOf(client, ref);
          await client.call('PUT', itemPath(e), {move: folder}, SCOPE);
          return {path: e.path, folder: Boolean(e.isDir), to: folder};
        },
        text: (r) => `Moved ${r.folder ? 'the folder' : 'the sound'} ${r.path} to ${r.to}/`,
      },
      delete: {
        summary: 'delete sounds (needs --yes)',
        usage: 'wx-admin sound delete <path>... --yes',
        details:
          'Dialplans, queues or users that play a deleted sound play nothing instead. A folder goes with sound rmdir.',
        options: {yes: {type: 'boolean', description: 'yes, delete them'}},
        args: [1, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'A deleted sound cannot be brought back, and what plays it plays nothing: confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const entries = [];
          for (const ref of ctx.positionals) {
            const e = await entryOf(client, ref);
            if (e.isDir) throw new UsageError(`${e.path} is a folder: wx-admin sound rmdir ${e.path} --yes`);
            if (e.isDefault) throw new UsageError(`${e.path} is a default sound of the PBX: it is not deleted`);
            entries.push(e);
          }
          for (const e of entries) await client.call('DELETE', soundsPath(e.path), undefined, SCOPE);
          return {deleted: entries.map((e) => e.path)};
        },
        text: (r) => `Deleted ${r.deleted.join(', ')}`,
      },
      mkdir: {
        summary: 'make a folder for sounds',
        usage: 'wx-admin sound mkdir <folder>',
        details: 'A folder name is letters, digits and _ (the PBX allows no other).',
        options: {},
        args: [1, 1],
        async run(ctx) {
          const folder = checkFolder(ctx.positionals[0]);
          await (await pbxClient(ctx)).call('POST', '/Sounds/directory/', {path: folder}, SCOPE);
          return {folder};
        },
        text: (r) => `Made the folder ${r.folder}/`,
      },
      rmdir: {
        summary: 'delete a folder with the sounds in it (needs --yes)',
        usage: 'wx-admin sound rmdir <folder> --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete it and its sounds'}},
        args: [1, 1],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError('Deleting a folder deletes the sounds in it: confirm with --yes', ctx.usage());
          const client = await pbxClient(ctx);
          const e = await entryOf(client, ctx.positionals[0]);
          if (!e.isDir) throw new UsageError(`${e.path} is a sound: wx-admin sound delete ${e.path} --yes`);
          if (e.isDefault) throw new UsageError(`${e.path} is a default folder of the PBX: it is not deleted`);
          const inside = (await listFolder(client, e.path)).filter((x) => x.name !== '..').length;
          await client.call('DELETE', itemPath(e), undefined, SCOPE);
          return {folder: e.path, sounds: inside};
        },
        text: (r) => `Deleted the folder ${r.folder}/${r.sounds ? ` and the ${r.sounds} sounds or folders in it` : ''}`,
      },
    },
  },
};
