// The commands of the Wilma objects that have a draft and published versions (agents, skills, tools), built from a
// description of the kind: list, get, export, create, update, versions, diff, publish, restore, delete.
// A change is computed from the unmasked answer in memory and sent with the `revision` read (optimistic locking);
// what is printed is masked unless --show-secrets.
import {UsageError} from 'wldx-core/errors';
import {readJsonInput} from 'wldx-core/files';
import {apiPath} from 'wldx-core/http';
import {localTime, oneLine, table} from 'wldx-core/format';
import {MASK} from '../cloud/mask.mjs';
import {checkNewFile, writeNewFile} from '../commands/records.mjs';
import {
  findObject,
  getObject,
  getVersion,
  listAll,
  listOf,
  masked,
  pickFields,
  SHOW_SECRETS,
  uriOf,
  usedBy,
  wholeNumber,
  wilmaClient,
} from './api.mjs';

const VERSION = {type: 'string', placeholder: 'N', description: 'a published version (default: the draft)'};

// A value of the file that was masked on export: sending it would write the mask over the secret.
export function refuseMasked(data, from) {
  if (JSON.stringify(data ?? null).includes(JSON.stringify(MASK)))
    throw new UsageError(
      `${from} holds masked values (${MASK}): export it with --show-secrets, or remove those fields to keep them`,
    );
}

const versionArg = (value) => (value === undefined ? undefined : wholeNumber(value, 'version'));

// --from N|draft and --to N|draft of a diff.
function side(value, name) {
  if (value === 'draft') return {draft: true};
  return {version: wholeNumber(value, name)};
}

const actor = (a) => (a ? `${a.type ?? ''}${a.type ? ' ' : ''}${a.id ?? ''}`.trim() : '');

export const versionLine = (v) =>
  [
    `v${v.version}${v.latest ? ' (latest)' : ''}`,
    v.name,
    v.changelog ? oneLine(v.changelog, 80) : undefined,
    `published ${localTime(v.publishedAt)}${v.publishedBy ? ` by ${actor(v.publishedBy)}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');

// The rows of `get` that have a value; a version has no draft rows.
const rows = (list, version = false) =>
  list.filter(([k, v]) => v !== '' && v !== undefined && v !== null && !(version && k === 'Versions'));

const changeLine = (c) => {
  const show = (v) => (v === undefined ? '—' : oneLine(typeof v === 'string' ? v : JSON.stringify(v), 70));
  return `${c.path}: ${show(c.before)} → ${show(c.after)}`;
};

// kind: a KINDS entry. spec:
//   line(o)                  one line of the list
//   details(o, extra)        rows of `get` (extra: what `more` added)
//   more(client, o)          optional: more to show in `get` (an agent's deployment)
//   listOptions, listQuery(values)
//   updateOptions, applyUpdate(ctx, body, current) → whether a flag changed something (async)
//   publishOptions, publishBody(values)
//   users(client, o)         who uses the object (default: the references of its URI)
//   checkFrom(data, from)    optional: refuse a --from file the kind cannot take
//   exportCommand, createCommand: replace the default ones (a skill and its files)
// A kind without versions (connectors) gets list, get, export, create, update and delete, without --version.
export function versionedCommands(kind, spec) {
  const {noun} = kind;
  const a = noun === 'agent' ? 'an agent' : `a ${noun}`;
  const versioned = Boolean(kind.versioned);
  const VERSIONS = versioned ? {version: VERSION} : {};
  const users = spec.users ?? ((client, o) => usedBy(client, uriOf(kind, o.id)));

  async function current(ctx, ref) {
    const client = await wilmaClient(ctx);
    const found = await findObject(client, kind, ref);
    return {client, obj: await getObject(client, kind, found.id)};
  }

  const commands = {
    list: {
      summary: `the ${noun}s of the company: ${spec.listWhat}`,
      usage: `wx-admin wilma ${noun} list${versioned ? ' [--search TEXT] [--status draft|active]' : ''}${spec.listUsage ?? ''}`,
      options: {
        ...(versioned
          ? {
              search: {type: 'string', placeholder: 'TEXT', description: `${noun}s whose name holds this text`},
              status: {type: 'string', choices: ['draft', 'active'], description: `only ${noun}s in this status`},
            }
          : {}),
        ...spec.listOptions,
        ...SHOW_SECRETS,
      },
      args: [0, 0],
      async run(ctx) {
        const client = await wilmaClient(ctx);
        const v = ctx.values;
        const items = await listOf(client, kind, {search: v.search, status: v.status, ...spec.listQuery?.(v)});
        const extra = spec.listMore ? await spec.listMore(client, items) : {};
        return {[kind.listKey]: masked(ctx, items), ...extra};
      },
      text: (r) => (r[kind.listKey].length ? r[kind.listKey].map((o) => spec.line(o, r)) : `No ${noun}s`),
    },
    get: {
      summary: versioned ? `one ${noun}: its draft, or a published version` : `one ${noun}`,
      usage: `wx-admin wilma ${noun} get <${noun}>${versioned ? ' [--version N]' : ''}`,
      options: {...VERSIONS, ...SHOW_SECRETS},
      args: [1, 1],
      async run(ctx) {
        const version = versionArg(ctx.values.version);
        const {client, obj} = await current(ctx, ctx.positionals[0]);
        if (version !== undefined) {
          const v = await getVersion(client, kind, obj.id, version);
          return masked(ctx, {...v, uri: uriOf(kind, obj.id)});
        }
        const extra = spec.more ? await spec.more(client, obj) : {};
        return masked(ctx, {...obj, ...extra, uri: uriOf(kind, obj.id)});
      },
      text: (o) =>
        versioned && o.publishedAt && o.definition
          ? [
              versionLine(o),
              ...table([...rows(spec.details({...o.definition, id: o[`${noun}Id`]}, o), true), ['URI', o.uri]]),
            ]
          : table([...rows(spec.details(o, o)), ['URI', o.uri]]),
    },
    export: {
      summary: `write the definition of ${a} to a new JSON file, for create or update (masked unless --show-secrets)`,
      usage: `wx-admin wilma ${noun} export <${noun}>${versioned ? ' [--version N]' : ''} --to FILE [--show-secrets]`,
      options: {
        ...VERSIONS,
        to: {type: 'string', placeholder: 'FILE', description: 'the new file'},
        'show-secrets': {type: 'boolean', description: 'keep keys and tokens in the file (written with mode 0600)'},
      },
      args: [1, 1],
      async run(ctx) {
        if (!ctx.values.to) throw new UsageError('Give the file: --to FILE', ctx.usage());
        const version = versionArg(ctx.values.version);
        checkNewFile(ctx, ctx.values.to);
        const {client, obj} = await current(ctx, ctx.positionals[0]);
        const def = version === undefined ? obj : (await getVersion(client, kind, obj.id, version))?.definition;
        const data = masked(ctx, {
          ...pickFields(def, kind.createFields),
          ...(version === undefined ? {revision: obj.revision} : {}),
        });
        const secret = ctx.values['show-secrets'];
        const file = writeNewFile(
          ctx,
          ctx.values.to,
          `${JSON.stringify(data, null, 2)}\n`,
          secret ? {mode: 0o600} : {},
        );
        return {file, id: obj.id, name: obj.name, version: version ?? 'draft'};
      },
      text: (r) =>
        `Wrote the ${noun} ${r.name} (${r.id}, ${r.version === 'draft' ? 'draft' : `v${r.version}`}) to ${r.file}`,
    },
    create: {
      summary: `create ${a} from a JSON file (an export: only the fields create takes are sent)`,
      usage: `wx-admin wilma ${noun} create --from FILE`,
      options: {
        from: {type: 'string', placeholder: 'FILE', description: 'the definition as JSON (a file, or - for stdin)'},
      },
      args: [0, 0],
      async run(ctx) {
        if (!ctx.values.from) throw new UsageError('Give the definition: --from FILE', ctx.usage());
        const data = await readJsonInput(ctx, ctx.values.from);
        refuseMasked(data, ctx.values.from);
        spec.checkFrom?.(data, ctx.values.from);
        const client = await wilmaClient(ctx);
        const made = (await client.call('POST', kind.base, {json: pickFields(data, kind.createFields)}))?.[
          kind.itemKey
        ];
        return masked(ctx, made ?? {});
      },
      text: (o) => `Created the ${noun} ${o.name ?? ''}${o.id ? ` (${o.id})` : ''}`,
    },
    update: {
      summary: `change ${versioned ? 'the draft of ' : ''}${a}: from a JSON file (an export) and/or flags`,
      usage: `wx-admin wilma ${noun} update <${noun}> [--from FILE]${spec.updateUsage ?? ''}`,
      options: {
        from: {type: 'string', placeholder: 'FILE', description: 'the definition as JSON (a file, or - for stdin)'},
        ...spec.updateOptions,
      },
      args: [1, 1],
      async run(ctx) {
        const v = ctx.values;
        const flags = Object.keys(spec.updateOptions ?? {}).some((k) => v[k] !== undefined);
        if (!v.from && !flags) throw new UsageError('Nothing to change: give --from FILE or a field flag', ctx.usage());
        const data = v.from ? await readJsonInput(ctx, v.from) : undefined;
        if (data) {
          refuseMasked(data, v.from);
          spec.checkFrom?.(data, v.from);
        }
        const {client, obj} = await current(ctx, ctx.positionals[0]);
        if (data?.revision !== undefined && data.revision !== obj.revision)
          throw new UsageError(
            `The ${noun} ${obj.name} changed since ${v.from} was exported (revision ${data.revision}, now ${obj.revision}): export it again`,
          );
        const body = {...pickFields(obj, kind.createFields), ...pickFields(data, kind.createFields)};
        if (flags) await spec.applyUpdate(ctx, body, obj);
        body.revision = obj.revision;
        const after = (await client.call('PUT', kind.item(obj.id), {json: body}))?.[kind.itemKey];
        return masked(ctx, after ?? {...obj, ...body});
      },
      text: (o) => `Updated ${versioned ? 'the draft of ' : ''}the ${noun} ${o.name} (${o.id})`,
    },
    versions: {
      summary: `the published versions of ${a}`,
      usage: `wx-admin wilma ${noun} versions <${noun}>`,
      options: {},
      args: [1, 1],
      async run(ctx) {
        const client = await wilmaClient(ctx);
        const o = await findObject(client, kind, ctx.positionals[0]);
        return {versions: await listAll(client, `${kind.item(o.id)}/versions`, 'versions')};
      },
      text: (r) => (r.versions.length ? r.versions.map(versionLine) : 'No published versions'),
    },
    diff: {
      summary: `what changed between two versions of ${a}, or a version and the draft (default: latest → draft)`,
      usage: `wx-admin wilma ${noun} diff <${noun}> [--from N|draft] [--to N|draft]`,
      options: {
        from: {type: 'string', placeholder: 'N|draft', description: 'the older side (default: the latest version)'},
        to: {type: 'string', placeholder: 'N|draft', description: 'the newer side (default: the draft)'},
      },
      args: [1, 1],
      async run(ctx) {
        const to = side(ctx.values.to ?? 'draft', 'to');
        const fromValue = ctx.values.from;
        const {client, obj} = await current(ctx, ctx.positionals[0]);
        let from;
        if (fromValue === undefined) {
          if (!obj.latestVersion)
            throw new UsageError(`The ${noun} ${obj.name} has no published version: nothing to compare`);
          from = {version: obj.latestVersion};
        } else from = side(fromValue, 'from');
        const query = {
          from: from.version,
          fromDraft: from.draft,
          to: to.version,
          toDraft: to.draft,
        };
        const r = await client.call('GET', `${kind.item(obj.id)}/compare-versions`, {query});
        return masked(ctx, {from: from.version ?? 'draft', to: to.version ?? 'draft', changes: r?.changes ?? []});
      },
      text: (r) =>
        r.changes.length
          ? [
              `${r.from === 'draft' ? 'draft' : `v${r.from}`} → ${r.to === 'draft' ? 'draft' : `v${r.to}`}`,
              ...r.changes.map(changeLine),
            ]
          : 'No changes',
    },
    publish: {
      summary: `publish the draft of ${a} as a new version${spec.publishNote ?? ''}`,
      usage: `wx-admin wilma ${noun} publish <${noun}> [--changelog TEXT]${spec.publishUsage ?? ''}`,
      options: {
        changelog: {type: 'string', placeholder: 'TEXT', description: 'what changed in this version'},
        ...spec.publishOptions,
      },
      args: [1, 1],
      async run(ctx) {
        const {client, obj} = await current(ctx, ctx.positionals[0]);
        const body = {changelog: ctx.values.changelog, ...spec.publishBody?.(ctx.values), revision: obj.revision};
        const v = (await client.call('POST', `${kind.item(obj.id)}/versions`, {json: body}))?.version;
        return {id: obj.id, name: obj.name, version: v?.version, changelog: v?.changelog};
      },
      text: (r) => `Published the ${noun} ${r.name} (${r.id}) as v${r.version}${spec.publishAfter ?? ''}`,
    },
    restore: {
      summary: `put a published version of ${a} back into its draft (the draft is replaced: needs --yes)`,
      usage: `wx-admin wilma ${noun} restore <${noun}> <version> --yes`,
      options: {yes: {type: 'boolean', description: 'yes, replace the draft'}},
      args: [2, 2],
      async run(ctx) {
        const version = wholeNumber(ctx.positionals[1], 'version');
        if (!ctx.values.yes) throw new UsageError('Restoring replaces the draft: confirm with --yes', ctx.usage());
        const {client, obj} = await current(ctx, ctx.positionals[0]);
        const path = `${kind.item(obj.id)}${apiPath`/versions/${version}`}/draft`;
        await client.call('POST', path, {json: {revision: obj.revision}});
        return {id: obj.id, name: obj.name, restored: version};
      },
      text: (r) => `The draft of the ${noun} ${r.name} (${r.id}) is v${r.restored} again`,
    },
    delete: {
      summary: `delete ${noun}s (needs --yes; one in use needs --force too)`,
      usage: `wx-admin wilma ${noun} delete <${noun}>... --yes [--force]`,
      options: {
        yes: {type: 'boolean', description: 'yes, delete them'},
        force: {type: 'boolean', description: `delete ${a} even when agents use it`},
      },
      args: [1, 50],
      async run(ctx) {
        if (!ctx.values.yes) throw new UsageError(`Deleting ${a} cannot be undone: confirm with --yes`, ctx.usage());
        const client = await wilmaClient(ctx);
        const found = [];
        for (const ref of ctx.positionals) found.push(await findObject(client, kind, ref));
        if (!ctx.values.force)
          for (const o of found) {
            const by = await users(client, o);
            if (by.length)
              throw new UsageError(
                `The ${noun} ${o.name} (${o.id}) is used by ${by.map((u) => u.label || u.uri).join(', ')}: give --force to delete it anyway (nothing was deleted)`,
              );
          }
        for (const o of found) await client.call('DELETE', kind.item(o.id));
        return {deleted: found.map(({id, name}) => ({id, name}))};
      },
      text: (r) => `Deleted ${r.deleted.map((o) => `${o.name} (${o.id})`).join(', ')}`,
    },
  };
  if (!versioned) for (const k of ['versions', 'diff', 'publish', 'restore']) delete commands[k];
  if (spec.exportCommand) commands.export = spec.exportCommand;
  if (spec.createCommand) commands.create = spec.createCommand;
  return commands;
}
