// wx section: the user's sections of the chat inbox (the agent skill's sections.sh). The list and its counters come
// from the inbox; creating, renaming, deleting and moving channels are not implemented by the service yet.
import {UsageError} from 'wldx-core/errors';
import {apiPath} from 'wldx-core/http';
import {channelId} from '../stream.mjs';
import {done} from '../chat/format.mjs';
import {NOT_IMPLEMENTED, api, notImplemented} from '../chat/lib.mjs';
import {sectionLines} from './inbox.mjs';

function sectionId(value) {
  if (!/^[a-z0-9_-]{1,32}$/.test(String(value)))
    throw new UsageError(`A section id must match [a-z0-9_-] (up to 32): ${value}`);
  return value;
}

function sectionName(value) {
  const v = String(value ?? '');
  if (!v.trim() || v.length > 80) throw new UsageError(`A section name has 1 to 80 characters: ${value}`);
  return v;
}

const list = {
  summary: 'your inbox sections with their counters',
  usage: 'wx section list',
  details: 'The sections of wx inbox get. The channels of a section: wx chat list --section ID.',
  options: {},
  args: [0, 0],
  async run(ctx) {
    const r = await api(ctx).call('GET', '/inbox');
    return {sections: r?.sections ?? []};
  },
  text: (r, ctx) => (r.sections.length ? sectionLines(r.sections, ctx) : 'No sections.'),
};

const make = (name, summary, usage, operation, args, request, text) => ({
  summary: `${summary}${NOT_IMPLEMENTED}`,
  usage: `wx section ${name} ${usage}`,
  details: notImplemented(operation),
  options: {},
  args: [args, args],
  async run(ctx) {
    const [method, path, body] = request(ctx.positionals);
    return api(ctx).call(method, path, body);
  },
  text: done(text),
});

const section = {
  summary: `your inbox sections${NOT_IMPLEMENTED.replace(')', ', except list)')}`,
  auth: true,
  commands: {
    list,
    create: make(
      'create',
      'create a section',
      '<sectionId> <name>',
      'CreateSection',
      2,
      ([id, name]) => ['POST', '/sections', {sectionId: sectionId(id), name: sectionName(name)}],
      'Created',
    ),
    rename: make(
      'rename',
      'rename a section',
      '<sectionId> <name>',
      'RenameSection',
      2,
      ([id, name]) => ['PATCH', apiPath`/sections/${sectionId(id)}`, {name: sectionName(name)}],
      'Renamed',
    ),
    delete: make(
      'delete',
      'delete a section',
      '<sectionId>',
      'DeleteSection',
      1,
      ([id]) => ['DELETE', apiPath`/sections/${sectionId(id)}`],
      'Deleted',
    ),
    add: make(
      'add',
      'put a channel into a section',
      '<channel> <sectionId>',
      'MoveChannelToSection',
      2,
      ([ch, id]) => ['PUT', apiPath`/channels/${channelId(ch)}/sections/${sectionId(id)}`],
      'Added',
    ),
    remove: make(
      'remove',
      'take a channel out of a section',
      '<channel> <sectionId>',
      'RemoveChannelFromSection',
      2,
      ([ch, id]) => ['DELETE', apiPath`/channels/${channelId(ch)}/sections/${sectionId(id)}`],
      'Removed',
    ),
  },
};

export const groups = {section};
