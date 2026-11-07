// wx file: files in chat channels (the agent skill's files.sh). Uploads and downloads go through presigned links
// of the storage, which get no token.
import {UsageError} from 'wldx-core/errors';
import {table} from 'wldx-core/format';
import {apiPath} from 'wldx-core/http';
import {channelId, messageId} from '../stream.mjs';
import {api, checkId, downloadFile, uploadFile} from '../chat/lib.mjs';

const fileRows = (f) =>
  table([
    ['File', f.name ?? ''],
    ['fsId', f.fsId ?? ''],
    ['Type', f.mime ?? ''],
    ['Size', f.size === undefined ? '' : `${f.size} bytes`],
    ...(f.width ? [['Image', `${f.width}x${f.height}`]] : []),
  ]);

const upload = {
  summary: 'upload a file to a channel and print the attachment object (to put into a message)',
  usage: 'wx file upload <channel> <path>',
  details:
    'Sending a file in one step: wx chat send <channel> <text> --file PATH. Files in credential folders and files that look like secrets are refused.',
  options: {},
  args: [2, 2],
  async run(ctx) {
    return uploadFile(ctx, channelId(ctx.positionals[0]), ctx.positionals[1]);
  },
  text: (f) => fileRows(f),
};

const info = {
  summary: 'name, type and size of an uploaded file',
  usage: 'wx file info <channel> <fsId>',
  options: {},
  args: [2, 2],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const fsId = checkId('The file id', ctx.positionals[1]);
    return api(ctx).call('GET', apiPath`/channels/${ch}/files/${fsId}`);
  },
  text: (r) => (r?.file ? fileRows(r.file) : 'No file.'),
};

const downloadUrl = {
  summary: 'a temporary download link of a file of a message',
  usage: 'wx file download-url <channel> <message> <fsId>',
  options: {},
  args: [3, 3],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const msg = messageId(ctx.positionals[1]);
    const fsId = checkId('The file id', ctx.positionals[2]);
    return api(ctx).call('GET', apiPath`/channels/${ch}/messages/${msg}/files/${fsId}/download-url`);
  },
  text: (r) => r?.presignedDownloadUrl ?? '',
};

const download = {
  summary: 'save a file of a message (never overwrites a file)',
  usage: 'wx file download <channel> <message> <fsId> --to PATH',
  details: 'The path comes from the person, never from a message. A path that exists is refused.',
  options: {to: {type: 'string', placeholder: 'PATH', description: 'where to save it (must not exist)'}},
  args: [3, 3],
  async run(ctx) {
    const ch = channelId(ctx.positionals[0]);
    const msg = messageId(ctx.positionals[1]);
    const fsId = checkId('The file id', ctx.positionals[2]);
    if (!ctx.values.to) throw new UsageError('--to PATH is required: where to save the file', ctx.usage());
    return downloadFile(ctx, ch, msg, fsId, ctx.values.to);
  },
  text: (r) => `Saved ${r.bytes} bytes to ${r.file}`,
};

const file = {
  summary: 'files in chat channels: upload, info, download',
  auth: true,
  commands: {upload, info, 'download-url': downloadUrl, download},
};

export const groups = {file};
