// wx-admin dialplan: the dialplans (procedures) of a PBX and their rules, over the PBX REST API.
// The model of the API: a dialplan is {id, name, description, numbers, includedDialplans}; its rules are `numbers`,
// each {number (a pattern), apps: [{name, params}], comment}, run in order; includedDialplans are {dialplanId}
// (negative ids are built-in ones). There is no endpoint per rule: a rule is changed by writing the whole dialplan.
import fs from 'node:fs';
import path from 'node:path';
import {pickByName} from '../match.mjs';
import {UsageError} from 'wldx-core/errors';
import {refuseUnsafeWrite, readJsonInput as readJsonFile} from 'wldx-core/files';
import {oneLine, paint, table} from 'wldx-core/format';
import {pbxClient} from '../pbx.mjs';

// The applications the API names (the enum of DialplanItemNumber in the PBX OpenAPI).
export const APPS = [
  'Answer',
  'AsrIvr',
  'AuthenticateUser',
  'Background',
  'Callback',
  'Conference',
  'CorrectOutgoingNumber',
  'CustomApp',
  'DialHuntGroup',
  'DialPhone',
  'DialRemotePbx',
  'DialTrunk',
  'Directory',
  'FastAGI',
  'FaxToEmail',
  'FeatureIntercom',
  'FeaturePaging',
  'GenerateDtmf',
  'GenerateFlashHook',
  'Goto',
  'GotoIf',
  'GotoIf3SwitchIsOnOrBlinking',
  'GotoIfBusyCongested',
  'GotoIfCallType',
  'GoToIfFaxDetected',
  'GotoIfGroupCount',
  'GotoIfSwitchIsOn',
  'GotoIfUserStatus',
  'Hangup',
  'IVR',
  'LookUpCidNameInPhonebook',
  'LookUpDestCidNameInPhonebook',
  'MobilityExtensionLookUp',
  'MuxMon',
  'Playback',
  'Queue',
  'Set',
  'Timetable',
  'VerifyCaller',
  'VoiceMail',
  'VoiceMailMain',
  'WaitExten',
];

const NUMBER = /^[^\s]{1,128}$/;

// The PBX wants every parameter of an application, empty ones too (the WMS form sends them all) and answers 400
// "Not found parameter <key> in <number>/<app>" otherwise. The parameters known so far, seen on a live PBX; a missing
// one the PBX names is added empty and the write is tried again (see write()).
const APP_PARAMS = {
  DialPhone: ['number', 'timeout', 'options', 'msgForOperator'],
  DialTrunk: ['number', 'trunk', 'timeout', 'maxCalls', 'options', 'classOfCall', 'routeOfficeNumbersInternally'],
  Goto: ['number', 'dialplan'],
  Hangup: ['causeCode'],
  MuxMon: ['destination', 'options', 'mode', 'transcribe_mode'],
  Playback: ['filename', 'noAnswer'],
  Queue: ['queueId', 'msgForOperator', 'timeout', 'mohClass'],
  Set: ['key', 'value'],
  VoiceBot: ['botId', 'language', 'voice', 'welcomeMessage', 'voicebotRecording', 'backgroundSound'],
};

// params as the API gives them: an object, or [] when there are none (PHP).
const paramsOf = (p) => (Array.isArray(p) && !p.length ? {} : (p ?? {}));

async function readJsonInput(ctx, from) {
  const data = await readJsonFile(ctx, from); // no credentials, nothing hidden in the home folder
  return data;
}

// The path of dialplans by id: ids are whole numbers (checked), several are joined by commas.
function dialplanPath(...ids) {
  for (const id of ids) if (!Number.isInteger(id)) throw new UsageError(`Not a dialplan id: ${id}`);
  return `/PBX/Dialplans/${ids.join(',')}/`;
}

// A dialplan by id or by name.
async function dialplanId(client, ref) {
  if (/^-?\d+$/.test(String(ref))) return Number(ref);
  const list = (await client.call('GET', '/PBX/Dialplans/', undefined, {scope: 'dialplan'}))?.records ?? [];
  return pickByName(list, ref, (d) => d.name, 'dialplan', 'wx-admin dialplan list').id;
}

const getDialplan = async (client, ref) => {
  const id = await dialplanId(client, ref);
  return client.call('GET', dialplanPath(id), undefined, {scope: 'dialplan'});
};

// What PUT takes: description, numbers, includedDialplans (the name does not change).
const writable = (d) => ({
  description: d.description ?? '',
  numbers: d.numbers ?? [],
  includedDialplans: d.includedDialplans ?? [],
});

const MISSING = /^Not found parameter (\S+) in (.+)\/(\w+)$/;

// POST or PUT a dialplan; when the PBX names parameters it misses, they are added empty and the write is tried
// again (up to 5 times), with a note for the person.
async function write(ctx, client, method, apiPath, body) {
  for (let round = 0; ; round += 1) {
    try {
      return await client.call(method, apiPath, body, {scope: 'dialplan'});
    } catch (e) {
      const missing =
        round < 5 && e.status === 400 ? (e.errors ?? []).map((m) => MISSING.exec(String(m))).filter(Boolean) : [];
      if (!missing.length || missing.length !== (e.errors ?? []).length) throw e;
      for (const [, key, number, app] of missing) {
        for (const r of body.numbers ?? []) {
          if (r.number !== number) continue;
          for (const a of r.apps) if (a.name === app && !(key in a.params)) a.params[key] = '';
        }
        ctx.info(`Added the empty parameter ${key} to ${app} in ${number} (the PBX wants every parameter)`);
      }
    }
  }
}

// A checked rule: {number, apps: [{name, params}], comment}.
function checkRule(rule, ctx) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule))
    throw new UsageError('A rule is an object {number, apps, comment}');
  if (typeof rule.number !== 'string' || !NUMBER.test(rule.number))
    throw new UsageError(`A rule needs a number (a pattern without spaces): ${JSON.stringify(rule.number)}`);
  if (!Array.isArray(rule.apps) || !rule.apps.length)
    throw new UsageError(`The rule ${rule.number} needs at least one application`);
  for (const app of rule.apps) {
    if (!app || typeof app.name !== 'string')
      throw new UsageError(`An application of the rule ${rule.number} has no name`);
    const params = paramsOf(app.params);
    if (typeof params !== 'object' || Array.isArray(params))
      throw new UsageError(`The params of ${app.name} are an object of strings`);
    if (!APPS.includes(app.name))
      ctx.info(
        `Note: ${app.name} is not one of the applications this version knows (wx-admin dialplan apps); the PBX decides.`,
      );
  }
  const complete = (a) => ({
    ...Object.fromEntries((APP_PARAMS[a.name] ?? []).map((k) => [k, ''])),
    ...paramsOf(a.params),
  });
  return {
    number: rule.number,
    apps: rule.apps.map((a) => ({name: a.name, params: complete(a)})),
    comment: rule.comment ?? '',
  };
}

// --app "Name key=value key=value" or --app '{"name": "Name", "params": {…}}'.
function parseApp(spec) {
  const s = String(spec).trim();
  if (s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch (e) {
      throw new UsageError(`--app is not JSON: ${e.message}`);
    }
  }
  const [name, ...pairs] = s.split(/\s+/);
  const params = {};
  for (const p of pairs) {
    const at = p.indexOf('=');
    if (at < 1) throw new UsageError(`--app parameters are key=value: ${p}`);
    params[p.slice(0, at)] = p.slice(at + 1);
  }
  return {name, params};
}

const appLine = (a) => {
  const set = Object.entries(a.params ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  return set.length ? `${a.name}(${set.map(([k, v]) => `${k}=${v}`).join(', ')})` : a.name;
};

const ruleLines = (d, ctx) => {
  const c = paint(ctx);
  const numbers = d.numbers ?? [];
  if (!numbers.length) return [c.dim('no rules')];
  return numbers.map(
    (r, i) =>
      `${String(i + 1).padStart(3)}  ${c.bold(r.number)}  ${(r.apps ?? []).map(appLine).join(' → ')}${r.comment ? c.dim(`  # ${oneLine(r.comment, 60)}`) : ''}`,
  );
};

const header = (d) => `${d.name} (id ${d.id})${d.description ? ` — ${d.description}` : ''}`;

export const groups = {
  dialplan: {
    summary: 'dialplans (procedures) and their rules: list, show, create, change, delete, export, import',
    commands: {
      list: {
        readOnly: true,
        summary: 'the dialplans of the PBX',
        usage: 'wx-admin dialplan list',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/Dialplans/', undefined, {scope: 'dialplan'});
        },
        text: (r) =>
          r?.records?.length ? table(r.records.map((d) => [d.id, d.name, d.description ?? ''])) : 'No dialplans',
      },
      get: {
        readOnly: true,
        summary: 'one dialplan with its rules and included dialplans',
        usage: 'wx-admin dialplan get <dialplan>',
        details: 'A dialplan is its id or its name.',
        options: {},
        args: [1, 1],
        async run(ctx) {
          return getDialplan(await pbxClient(ctx), ctx.positionals[0]);
        },
        text: (d, ctx) => [
          header(d),
          ...(d.includedDialplans?.length
            ? [`includes ${d.includedDialplans.map((x) => x.dialplanId).join(', ')}`]
            : []),
          ...ruleLines(d, ctx),
        ],
      },
      create: {
        summary: 'create a dialplan, empty or from a JSON file ({description, numbers, includedDialplans})',
        usage: 'wx-admin dialplan create <name> [--description TEXT] [--from FILE|-]',
        options: {
          description: {type: 'string', placeholder: 'TEXT', description: 'what the dialplan is for'},
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'the rules and includes as JSON (a file, or - for stdin)',
          },
        },
        args: [1, 1],
        async run(ctx) {
          const name = ctx.positionals[0];
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
            throw new UsageError(`A dialplan name is letters, digits, _ and -: ${name}`);
          const src = ctx.values.from ? await readJsonInput(ctx, ctx.values.from) : {};
          const body = {name, ...writable(src)};
          if (ctx.values.description !== undefined) body.description = ctx.values.description;
          body.numbers = body.numbers.map((r) => checkRule(r, ctx));
          return write(ctx, await pbxClient(ctx), 'POST', '/PBX/Dialplans/', body);
        },
        text: (d) => `Created ${header(d)}`,
      },
      update: {
        summary: 'change a dialplan: its description, or its rules and includes from a JSON file (replaces them)',
        usage: 'wx-admin dialplan update <dialplan> [--description TEXT] [--from FILE|-] [--yes]',
        details: 'Fields missing from the file are kept. The name cannot change.',
        options: {
          description: {type: 'string', placeholder: 'TEXT', description: 'the new description'},
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'JSON with numbers and/or includedDialplans (a file, or - for stdin)',
          },
          yes: {type: 'boolean', description: 'yes, replace the rules or included dialplans'},
        },
        args: [1, 1],
        async run(ctx) {
          if (ctx.values.description === undefined && !ctx.values.from)
            throw new UsageError('Nothing to change: give --description or --from', ctx.usage());
          const client = await pbxClient(ctx);
          const current = await getDialplan(client, ctx.positionals[0]);
          const src = ctx.values.from ? await readJsonInput(ctx, ctx.values.from) : {};
          if ((src.numbers !== undefined || src.includedDialplans !== undefined) && !ctx.values.yes)
            throw new UsageError(
              'The file replaces every rule (or included dialplan) of the dialplan: confirm with --yes',
              ctx.usage(),
            );
          const body = writable({
            ...current,
            ...Object.fromEntries(
              ['description', 'numbers', 'includedDialplans']
                .filter((k) => src[k] !== undefined)
                .map((k) => [k, src[k]]),
            ),
          });
          if (ctx.values.description !== undefined) body.description = ctx.values.description;
          body.numbers = body.numbers.map((r) => checkRule(r, ctx));
          return write(ctx, client, 'PUT', dialplanPath(current.id), body);
        },
        text: (d) => `Updated ${header(d)}`,
      },
      delete: {
        summary: 'delete dialplans (needs --yes: calls routed to them stop working)',
        usage: 'wx-admin dialplan delete <dialplan>... --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete them'}},
        args: [1, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError('Deleting a dialplan stops the calls routed to it: confirm with --yes', ctx.usage());
          const client = await pbxClient(ctx);
          const ids = [];
          for (const ref of ctx.positionals) ids.push(await dialplanId(client, ref));
          await client.call('DELETE', dialplanPath(...ids), undefined, {scope: 'dialplan'});
          return {deleted: ids};
        },
        text: (r) => `Deleted ${r.deleted.length === 1 ? 'dialplan' : 'dialplans'} ${r.deleted.join(', ')}`,
      },
      rules: {
        readOnly: true,
        summary: 'the rules of a dialplan, in order: number pattern → applications',
        usage: 'wx-admin dialplan rules <dialplan>',
        options: {},
        args: [1, 1],
        async run(ctx) {
          const d = await getDialplan(await pbxClient(ctx), ctx.positionals[0]);
          return {id: d.id, name: d.name, numbers: d.numbers ?? []};
        },
        text: (d, ctx) => ruleLines(d, ctx),
      },
      'rule-add': {
        summary: 'add a rule to a dialplan (at the end, or at --position)',
        usage:
          'wx-admin dialplan rule-add <dialplan> <number> (--app "Name key=value…"... | --from FILE|-) [--comment TEXT] [--position N] [--replace]',
        details: [
          'The applications run in the order given: --app "DialPhone number=101 timeout=30" --app Hangup.',
          'An --app can also be JSON: --app \'{"name": "Set", "params": {"var": "X", "value": "1"}}\'.',
          '--from reads one rule as JSON: {"apps": [...], "comment": "..."} (its number is the argument).',
          'A rule with the same number is refused unless --replace (which puts the new one in its place).',
        ].join('\n'),
        options: {
          app: {type: 'string', multiple: true, placeholder: 'SPEC', description: 'an application and its parameters'},
          from: {type: 'string', placeholder: 'FILE', description: 'the rule as JSON (a file, or - for stdin)'},
          comment: {type: 'string', placeholder: 'TEXT', description: 'a comment on the rule'},
          position: {type: 'string', placeholder: 'N', description: 'put it at this place (1 = first)'},
          replace: {type: 'boolean', description: 'replace the rule with the same number'},
        },
        args: [2, 2],
        async run(ctx) {
          const {values} = ctx;
          const [ref, number] = ctx.positionals;
          if (!values.app?.length === !values.from)
            throw new UsageError('Give --app (one or more) or --from', ctx.usage());
          const src = values.from ? await readJsonInput(ctx, values.from) : {apps: values.app.map(parseApp)};
          const rule = checkRule({...src, number, comment: values.comment ?? src.comment ?? ''}, ctx);
          const client = await pbxClient(ctx);
          const current = await getDialplan(client, ref);
          const numbers = (current.numbers ?? []).map((r) => checkRule(r, ctx));
          const at = numbers.findIndex((r) => r.number === number);
          if (at >= 0 && !values.replace)
            throw new UsageError(
              `The dialplan ${current.name} has a rule for ${number} already: --replace to replace it`,
            );
          if (at >= 0) numbers.splice(at, 1, rule);
          else if (values.position !== undefined) {
            const n = Number(values.position);
            if (!Number.isInteger(n) || n < 1 || n > numbers.length + 1)
              throw new UsageError(`--position is from 1 to ${numbers.length + 1}`);
            numbers.splice(n - 1, 0, rule);
          } else numbers.push(rule);
          return write(ctx, client, 'PUT', dialplanPath(current.id), {...writable(current), numbers});
        },
        text: (d, ctx) => [`Updated ${header(d)}`, ...ruleLines(d, ctx)],
      },
      'rule-remove': {
        summary: 'remove the rule of a number from a dialplan (needs --yes)',
        usage: 'wx-admin dialplan rule-remove <dialplan> <number> --yes',
        options: {yes: {type: 'boolean', description: 'yes, remove it'}},
        args: [2, 2],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError('Removing a rule changes how calls are routed: confirm with --yes', ctx.usage());
          const [ref, number] = ctx.positionals;
          const client = await pbxClient(ctx);
          const current = await getDialplan(client, ref);
          const numbers = (current.numbers ?? []).filter((r) => r.number !== number).map((r) => checkRule(r, ctx));
          if (numbers.length === (current.numbers ?? []).length)
            throw new UsageError(`The dialplan ${current.name} has no rule for ${number}`);
          return write(ctx, client, 'PUT', dialplanPath(current.id), {...writable(current), numbers});
        },
        text: (d, ctx) => [`Updated ${header(d)}`, ...ruleLines(d, ctx)],
      },
      export: {
        summary: 'a dialplan as JSON that dialplan import takes (to stdout, or to a new file)',
        usage: 'wx-admin dialplan export <dialplan> [--to FILE]',
        options: {
          to: {type: 'string', placeholder: 'FILE', description: 'write it to this file (which must not exist)'},
        },
        args: [1, 1],
        async run(ctx) {
          const d = await getDialplan(await pbxClient(ctx), ctx.positionals[0]);
          const data = {name: d.name, ...writable(d)};
          if (!ctx.values.to) return data;
          const file = path.resolve(ctx.cwd ?? process.cwd(), ctx.values.to);
          refuseUnsafeWrite(file, ctx.env);
          try {
            fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, {flag: 'wx'});
          } catch (e) {
            if (e.code === 'EEXIST')
              throw new UsageError(`${ctx.values.to} exists: choose another file (nothing was overwritten)`);
            throw e;
          }
          return {file, name: d.name, rules: data.numbers.length};
        },
        text: (r) => (r.file ? `Exported ${r.name} (${r.rules} rules) to ${r.file}` : JSON.stringify(r, null, 2)),
      },
      import: {
        summary: 'create a dialplan from the JSON of dialplan export; --replace overwrites one of the same name',
        usage: 'wx-admin dialplan import --from FILE|- [--as NAME] [--replace --yes]',
        options: {
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'the JSON of dialplan export (a file, or - for stdin)',
          },
          as: {type: 'string', placeholder: 'NAME', description: 'another name for it'},
          replace: {type: 'boolean', description: 'replace the rules of an existing dialplan of that name'},
          yes: {type: 'boolean', description: 'yes, replace them (with --replace)'},
        },
        args: [0, 0],
        async run(ctx) {
          if (!ctx.values.from) throw new UsageError('--from is needed', ctx.usage());
          const src = await readJsonInput(ctx, ctx.values.from);
          const name = ctx.values.as ?? src.name;
          if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name))
            throw new UsageError(`A dialplan name is letters, digits, _ and -: ${name}`);
          const body = writable(src);
          body.numbers = body.numbers.map((r) => checkRule(r, ctx));
          const client = await pbxClient(ctx);
          const existing = (
            (await client.call('GET', '/PBX/Dialplans/', undefined, {scope: 'dialplan'}))?.records ?? []
          ).find((d) => d.name === name);
          if (existing && ctx.values.replace && !ctx.values.yes)
            throw new UsageError(
              `--replace overwrites every rule of the dialplan ${name}: confirm with --yes`,
              ctx.usage(),
            );
          if (existing && !ctx.values.replace)
            throw new UsageError(
              `A dialplan ${name} exists (id ${existing.id}): --replace to overwrite its rules, or --as another name`,
            );
          return existing
            ? write(ctx, client, 'PUT', dialplanPath(existing.id), body)
            : write(ctx, client, 'POST', '/PBX/Dialplans/', {name, ...body});
        },
        text: (d) => `Imported ${header(d)} (${(d.numbers ?? []).length} rules)`,
      },
      apps: {
        readOnly: true,
        summary: 'the dialplan applications; --used shows the ones the dialplans of the PBX use, with their parameters',
        usage: 'wx-admin dialplan apps [--used]',
        options: {
          used: {
            type: 'boolean',
            description: 'read the dialplans of the PBX: the applications in use and their parameters',
          },
        },
        args: [0, 0],
        async run(ctx) {
          if (!ctx.values.used) return {apps: APPS.map((name) => ({name}))};
          const client = await pbxClient(ctx);
          const seen = new Map();
          for (const {id} of (await client.call('GET', '/PBX/Dialplans/', undefined, {scope: 'dialplan'}))?.records ??
            []) {
            const d = await client.call('GET', dialplanPath(id), undefined, {scope: 'dialplan'});
            for (const r of d.numbers ?? []) {
              for (const a of r.apps ?? []) {
                const s = seen.get(a.name) ?? {name: a.name, uses: 0, params: new Set(), example: undefined};
                s.uses += 1;
                for (const k of Object.keys(a.params ?? {})) s.params.add(k);
                s.example ??= {dialplan: d.name, number: r.number, params: a.params};
                seen.set(a.name, s);
              }
            }
          }
          return {apps: [...seen.values()].sort((a, b) => b.uses - a.uses).map((s) => ({...s, params: [...s.params]}))};
        },
        text: (r) =>
          r.apps[0]?.uses === undefined
            ? r.apps.map((a) => a.name).join('\n')
            : table(r.apps.map((a) => [a.name, `${a.uses}×`, a.params.join(', ')])),
      },
    },
  },
};
