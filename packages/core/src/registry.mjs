// What a command line built on this core is made of: its spec.
//
//   {
//     groups:   {name: Group}       `<program> <group> <command>`, in the order of the help
//     commands: {name: Command}     single commands, `<program> <command>`
//     globals:  {name: Option}      its own global options (e.g. --pbx), taken anywhere like GLOBAL_OPTIONS below
//     help:     {options: [lines], exitCodes: 'line'}   its lines in the main help (options of its own globals)
//     completers: {kind: (env) => [[value, description?], ...]}   values for `complete: kind` (options, commands)
//     around(cmd, ctx, io, run)     optional: runs a command instead of run(ctx) (e.g. once per PBX)
//   }
//
// A group is {summary, auth?, commands: {name: Command}}; a Command is
//   {summary, usage, details?, options, args: [min, max], auth?, complete?, run(ctx), text?, textEvent?}
// `auth` (on the command, else on its group) loads a valid x-bees token before run(). An option is a node:util
// parseArgs option plus `description` (help and completion), `placeholder`, `choices` (the router refuses other
// values, completion offers them) and `complete: 'profiles'|<a completer of the spec>` (completion offers values).
// A global option of type string may set `needs` (the error when its value is missing: "--pbx needs a PBX host").
// A global option reaches commands as ctx.<camel-cased name>, or ctx.<key> when it sets `key` (it must, when that
// name is a field of the context, e.g. --env: ctx.env is the environment of the process).

export const COMMON_OPTIONS = {
  help: {type: 'boolean', short: 'h', description: 'help of the command'},
};

// Taken by the router wherever they stand (as in the internal Wildix CLI); a command never defines these names.
export const GLOBAL_OPTIONS = {
  profile: {
    type: 'string',
    placeholder: 'EMAIL',
    needs: 'a profile: the e-mail of a login',
    description: 'the profile (a logged-in e-mail) to use; else WILDIX_EMAIL, else the default',
    complete: 'profiles',
  },
  output: {
    type: 'string',
    choices: ['text', 'json'],
    description: 'text for people (default), JSON for scripts and agents',
  },
  pretty: {type: 'boolean', description: 'indent the JSON'},
  'no-color': {type: 'boolean', description: 'no colors in the text'},
};

// The global options of a spec: its own first (they come first in the help), then the common ones.
export const globalsOf = (spec) => ({...(spec.globals ?? {}), ...GLOBAL_OPTIONS});

const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
export const groupOf = (name, spec) => own(spec.groups, name);
export const commandOf = (group, name) => own(group?.commands, name);
// A group may hold a group (`wx-admin kb source list`): an entry with commands and no run().
export const isGroup = (c) => Boolean(c?.commands && typeof c.run !== 'function');
// Every command of a group, those of its groups too.
export const commandsOf = (group) =>
  Object.values(group?.commands ?? {}).flatMap((c) => (isGroup(c) ? commandsOf(c) : [c]));
export const singleOf = (name, spec) => own(spec.commands, name);
