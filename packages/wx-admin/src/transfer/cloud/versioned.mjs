// The Wilma objects of the config transfer that have a draft and published versions (tools, skills, agents), and the
// connectors that are edited in place. Calls as `wx-admin wilma <noun>` makes them (src/wilma/versioned.mjs).
//
// Read: the list, then each object (its draft) and, when it has one, its latest published version. The portable data
// is the published definition (the fields create takes), with the draft as `draft` when it differs; an object never
// published is its draft alone, `unpublished: true`, and is created on the target without a publish.
//
// Write: a new object is created with the published definition, an existing one gets it on its draft (PUT with the
// `revision` read); then it is published, deployed when the kind says so (agents), and its draft written when the
// export has one. A conflict (409) is read again and tried once more. A draft equal to the latest version (409
// NothingToPublishException) is not published: that version stays, and the draft is still written. A failed step is
// a StageError naming the stage and, once the object exists, its id; its message holds the HTTP status only (an
// answer may echo a body, and a body may hold the configuration of a handler with its secrets).
import {accessRefused} from '../../pbx.mjs';
import {StageError} from '../stage-error.mjs';
import {getObject, getVersion, listOf, pickFields} from '../../wilma/api.mjs';

export const CHANGELOG = 'wx-admin config import';

// JSON with sorted keys: two definitions compare equal whatever the order of their fields.
const canonical = (v) =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
    : JSON.stringify(v);

// kind: a KINDS entry of src/wilma/api.mjs; skip(listed): objects not read (built-in agents). Answers
// [{id, name, data, version?}] (version: the latest published).
export async function readVersioned(client, kind, {skip = () => false} = {}) {
  const out = [];
  for (const listed of await listOf(client, kind)) {
    if (skip(listed)) continue;
    const obj = (await getObject(client, kind, listed.id)) ?? listed;
    const draft = pickFields(obj, kind.createFields);
    const at = {id: String(obj.id), name: String(obj.name)};
    if (!obj.latestVersion) {
      out.push({...at, data: {...draft, unpublished: true}});
      continue;
    }
    const published = pickFields(
      (await getVersion(client, kind, obj.id, obj.latestVersion))?.definition,
      kind.createFields,
    );
    out.push({
      ...at,
      version: obj.latestVersion,
      data: canonical(draft) === canonical(published) ? published : {...published, draft},
    });
  }
  return out;
}

// The message of a failed step: the stage and the HTTP status, never the text of the answer.
const refused = (stage, e) => `${stage} was refused${e?.status ? ` (HTTP ${e.status})` : ''}`;
// What a failed step throws (a refused access stops the whole import: apply rethrows it): a refused access as it is,
// else a StageError with the status only (and the id of the object, once it exists).
export const stageFailure = (stage, e, id) =>
  accessRefused(e) ? e : new StageError(stage, refused(stage, e), id === undefined ? {} : {id: String(id)});
// A publish of a draft equal to the latest version: a 409 too, but no conflict (the target has that version already).
const nothingToPublish = (e) => e?.status === 409 && e?.code === 'NothingToPublishException';

// The `write` hook of a kind. A kind with versions (kind.versioned) is published after the create or update, and
// deployed at 100% when deploy(data) says so; a kind without (connectors) is only created or updated. In the first
// pass of a twoPass kind (bare) the object is only created or updated: the second pass publishes it. Answers
// {id, version?, steps}.
export function versionedWrite(kind, {deploy} = {}) {
  return async (client, item, data, {existing, bare = false}) => {
    const steps = [];
    let id = existing === undefined ? undefined : String(existing);
    let revision;
    let latest; // the latest published version of the object, as last read
    const fail = (stage, e) => stageFailure(stage, e, id);
    const step = async (stage, call) => {
      try {
        return await call();
      } catch (e) {
        throw fail(stage, e);
      }
    };
    const seen = (obj) => {
      revision = obj?.revision ?? revision;
      latest = obj?.latestVersion ?? latest;
    };
    const reread = (stage) =>
      step(stage, async () => {
        const obj = await getObject(client, kind, id);
        revision = obj?.revision;
        latest = obj?.latestVersion;
      });
    // A call that sends the revision: on a conflict the object is read again and the call tried once more. An error
    // pass(e) accepts is thrown as it is, for the caller to handle.
    const withRevision = async (stage, call, pass = () => false) => {
      try {
        return await call();
      } catch (e) {
        if (pass(e)) throw e;
        if (e?.status !== 409) throw fail(stage, e);
      }
      await reread(stage);
      try {
        return await call();
      } catch (e) {
        throw pass(e) ? e : fail(stage, e);
      }
    };
    const put = async (stage, fields) => {
      seen(
        (await withRevision(stage, () => client.call('PUT', kind.item(id), {json: {...fields, revision}})))?.[
          kind.itemKey
        ],
      );
      steps.push(stage);
    };

    const fields = pickFields(data, kind.createFields);
    if (id === undefined) {
      const answer = await step('create', () => client.call('POST', kind.base, {json: fields}));
      const made = answer?.[kind.itemKey];
      if (made?.id === undefined) throw new StageError('create', `create answered no id of the ${kind.noun}`);
      id = String(made.id);
      seen(made);
      steps.push('create');
    } else {
      await reread('update');
      await put('update', fields);
    }
    if (bare || !kind.versioned || data.unpublished) return {id, steps};

    let version;
    try {
      const published = await withRevision(
        'publish',
        () => client.call('POST', `${kind.item(id)}/versions`, {json: {changelog: CHANGELOG, revision}}),
        nothingToPublish,
      );
      version = published?.version?.version;
      if (version === undefined) throw new StageError('publish', 'publish answered no version', {id});
      steps.push('publish');
    } catch (e) {
      if (!nothingToPublish(e)) throw e;
      // The target's latest version is the definition already: it stays the version others point at.
      if (latest === undefined) await reread('publish');
      version = latest;
      if (version === undefined) throw new StageError('publish', refused('publish', e), {id});
      steps.push('nothing to publish');
    }

    if (deploy?.(data)) {
      await step('deploy', () =>
        client.call('PUT', `${kind.item(id)}/deployment`, {json: {deployment: [{version, percentage: 100}]}}),
      );
      steps.push('deploy');
    }
    if (data.draft) await put('draft', pickFields(data.draft, kind.createFields));
    return {id, version, steps};
  };
}
