import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fakeCompany} from './fake-company.mjs';
import {run, tempConfigDir} from './helpers.mjs';

// The whole cloud config transfer, end to end: the real commands (config export, import, copy) between two PBX of
// their own companies (a.wildixin.com of it_x, b.wildixin.com of it_y) and the cloud of each, and what never leaves
// memory: the secret values.

const A = 'a.wildixin.com';
const B = 'b.wildixin.com';
const HOOK = 'https://crm.example.com/hook';

// The secrets of the source company, as its services keep them (read into memory by an export, never written).
const SOURCE = {
  header: 'SrcHeaderValue9f3kQ',
  confluence: 'SrcConfluenceToken7Hd2',
  webhook: 'SrcSigningSecret4Lm8Pz',
};
// The values given with --secrets, at the real paths of each kind.
const HEADER_PATH = 'handler.mcp.authorization.customHeaders.X-Api-Key';
const GIVEN = {
  eleven: 'GivenElevenKey2Rt6',
  confluence: 'GivenConfluenceToken5Wq1',
  header: 'GivenHeaderValue8Zx4',
  webhook: 'GivenSigningSecret3Np7',
};
const secretsFile = ({webhook = true} = {}) => ({
  'wilma-secrets/eleven': {value: GIVEN.eleven},
  'kb-sources/Wiki': {'config.confluence.apiKey': GIVEN.confluence},
  'wilma-tools/lookup': {[HEADER_PATH]: GIVEN.header},
  ...(webhook ? {[`integration-webhooks/${HOOK}`]: {secret: GIVEN.webhook}} : {}),
});

// Versioned Wilma objects (tools, skills, agents) as the service keeps them: the draft on the object, the published
// definition in its versions.
function versioned(coll, idKey, specs) {
  const objects = [];
  const versions = {};
  for (const {id, published, version = 2} of specs) {
    objects.push({id, companyId: 'it_x', ...published, status: 'active', revision: 3, latestVersion: version});
    versions[id] = [{[idKey]: id, version, changelog: 'old', definition: {id, ...published}}];
  }
  return {[coll]: objects, versions};
}

// it_x: an agent with everything. Its tools (one MCP server authorized by a custom header, one by the shared
// connection), its skill with a file, its knowledge base (a Confluence source), the secret of its voice, the ACL group
// and the dialplan of the PBX, a grant to a user; a webhook; a Kite widget on the call group Sales.
function wilmaOfX() {
  const tools = versioned('tools', 'toolId', [
    {
      id: 'tool00000x01',
      published: {
        name: 'lookup',
        category: 'Support',
        description: 'd',
        handler: {
          mcp: {
            serverUrl: 'https://mcp.example/sse',
            authorization: {customHeaders: {'X-Api-Key': SOURCE.header}},
            tools: ['search'],
          },
        },
      },
    },
    {
      id: 'tool00000x02',
      published: {
        name: 'crm-tool',
        category: 'Sales',
        description: 'd',
        handler: {mcp: {serverUrl: 'https://mcp.crm.example/sse', authorization: {connection: {id: 'conn0x01'}}}},
      },
    },
  ]);
  const skills = versioned('skills', 'skillId', [
    {
      id: 'skill0000x01',
      version: 3,
      published: {
        name: 'faq',
        description: 'd',
        content: '# Steps',
        files: [{id: 'file0x01', path: 'refs/notes.md', name: 'notes.md', size: 5}],
      },
    },
  ]);
  const agents = versioned('agents', 'agentId', [
    {
      id: 'agent000x001',
      published: {
        name: 'Support',
        description: 'd',
        settings: {pbxGroupId: '7'},
        access: {grants: [{userId: 'u-ann-x'}]},
        channels: {voice: {speech: {languages: [{code: 'en-US', voice: 'elevenlabs://v1?apiKey=secrets:sec0x001'}]}}},
        engine: {
          ai: {
            instructions: 'Help',
            skills: [{id: 'skill0000x01', skillVersion: 3}],
            capabilities: [
              {tool: {id: 'tool00000x01', toolVersion: 2}},
              {tool: {id: 'tool00000x02', toolVersion: 2}},
              {kb: {knowledgeBaseId: 'kb-x1'}},
              {transfer: {variant: 'predefined', context: 'users'}},
            ],
          },
        },
      },
    },
  ]);
  return {
    secrets: [{id: 'sec0x001', name: 'eleven', description: 'TTS key', revision: 3, status: 'active'}],
    connections: [
      {
        id: 'conn0x01',
        name: 'crm',
        type: 'shared',
        provider: 'hubspot',
        scopes: ['crm.read'],
        status: 'active',
      },
    ],
    tools: tools.tools,
    skills: skills.skills,
    agents: agents.agents,
    versions: {...tools.versions, ...skills.versions, ...agents.versions},
    deployments: {agent000x001: [{version: 2, percentage: 100}]},
    files: {file0x01: {url: 'https://download.example/file0x01', bytes: Buffer.from('notes')}},
  };
}
const kbOfX = () => ({
  kbs: [{id: 'kb-x1', name: 'Docs', description: 'docs', dataSources: ['ds-x1']}],
  sources: [
    {
      id: 'ds-x1',
      name: 'Wiki',
      description: 'wiki',
      type: 'confluence',
      config: {
        confluence: {
          baseUrl: 'https://wiki.example.net',
          username: 'a@x.example',
          spaceId: 'ENG',
          apiKey: SOURCE.confluence,
        },
      },
    },
  ],
});
const webhookOfX = () => ({
  integrationId: 'wh-x1',
  service: 'webhook',
  status: 'enabled',
  data: {type: 'webhook', url: HOOK, key: '', secret: SOURCE.webhook, events: [{value: 'call:completed'}]},
});
const service = (id, title, host) => ({id, uri: `${id}@${host}:443`, title, settings: {}, extensions: []});
const kiteOfX = () => ({
  services: [service(42, 'Sales', A)],
  widgets: [
    {
      id: 'wgt-x1',
      company: 'it_x',
      name: 'Site chat',
      target: {service: {id: 42, uri: `42@${A}:443`}},
      appearance: {text: {title: 'Hi'}},
    },
  ],
});

const pbxOf = ({acl = [], dialplans = [], queues = []} = {}) => ({
  '/PBX/version/': {version: '7.11'},
  '/PBX/settings/license/': {limitations: {licenseTypes: {}}, licenseUsage: {}},
  '/PBX/AclGroups/': acl,
  '/PBX/Dialplans/': dialplans,
  '/Dialplan/CallGroups/': queues,
});
const pbxOfA = () =>
  pbxOf({
    acl: [{id: '7', name: 'Support', inherits: null, rules: [], adminRules: []}],
    dialplans: [{id: '3', name: 'users', description: '', includedDialplans: [], numbers: []}],
    queues: [{id: '42', title: 'Sales', members: []}],
  });

// The two companies: it_x with everything, it_y with its own x-bees service of a call group (Vendite) and its own
// user (anna@y.example), nothing else; the PBX a has the ACL group, the dialplan and the call group, b nothing.
function companies() {
  const x = {
    wilma: wilmaOfX(),
    kb: kbOfX(),
    integrations: {installed: [webhookOfX()]},
    kite: kiteOfX(),
    stream: {users: [{id: 'u-ann-x', email: 'ann@x.example'}]},
  };
  const y = {
    wilma: {},
    kb: {},
    integrations: {},
    kite: {services: [service(77, 'Vendite', B)]},
    stream: {users: [{id: 'u-anna-y', email: 'anna@y.example'}]},
  };
  const f = fakeCompany({
    pbxs: {a: {company: 'it_x', pbx: pbxOfA()}, b: {company: 'it_y', pbx: pbxOf()}},
    clouds: {it_x: x, it_y: y},
  });
  return {f, x, y};
}

const MAP = {'xbees-services': {Sales: 'Vendite'}, 'xbees-users': {'ann@x.example': 'anna@y.example'}};

function writeJson(name, value) {
  const file = path.join(tempConfigDir(), name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
const logOf = (dir) => {
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, files.join(', '));
  return fs.readFileSync(path.join(dir, files[0]), 'utf8');
};
// Every file under a folder, recursively: [relative path, bytes as text].
const filesUnder = (dir) =>
  fs
    .readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter((e) => e.isFile())
    .map((e) => {
      const full = path.join(e.parentPath ?? e.path, e.name);
      return [path.relative(dir, full), fs.readFileSync(full, 'utf8')];
    });

async function exportIt(f, args) {
  const dir = path.join(tempConfigDir(), 'exp');
  const r = await run(['config', 'export', '--to', dir, '--pbx', A, ...args], {env: f.env, fetch: f.fetch});
  assert.equal(r.code, 0, r.stderr);
  return {dir, r};
}
async function importIt(f, dir, pbx, args, {output = 'json'} = {}) {
  const logDir = tempConfigDir();
  const r = await run(['config', 'import', dir, '--pbx', pbx, '--log', logDir, ...args], {
    env: f.env,
    fetch: f.fetch,
    output,
  });
  // No log file when the import is refused before it starts.
  const log = fs.readdirSync(logDir).length ? logOf(logDir) : undefined;
  return {r, log, out: output === 'json' && r.stdout ? JSON.parse(r.stdout) : undefined};
}

const only = (list, what) => {
  assert.equal(list.length, 1, `${what}: ${JSON.stringify(list)}`);
  return list[0];
};

test('agent with everything moves to another company', async () => {
  const {f, x, y} = companies();
  const logDir = tempConfigDir();
  const r = await run(
    [
      'config',
      'copy',
      '--from',
      A,
      '--to',
      B,
      '--cloud',
      '--all',
      '--yes',
      '--secrets',
      writeJson('secrets.json', secretsFile()),
      '--map',
      writeJson('map.json', MAP),
      '--log',
      logDir,
    ],
    {env: f.env, fetch: f.fetch},
  );
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);

  // Every object is created on B, nothing else happens.
  assert.deepEqual(
    out.results.map((x) => [x.key, x.action]),
    [
      ['acl-groups/Support', 'create'],
      ['queues/Sales', 'create'],
      ['dialplans/users', 'create'],
      ['wilma-secrets/eleven', 'create'],
      ['wilma-connections/crm', 'create'],
      ['kb-sources/Wiki', 'create'],
      ['kb-bases/Docs', 'create'],
      ['wilma-tools/lookup', 'create'],
      ['wilma-tools/crm-tool', 'create'],
      ['wilma-skills/faq', 'create'],
      ['wilma-agents/Support', 'create'],
      [`integration-webhooks/${HOOK}`, 'create'],
      ['kite-widgets/Site chat', 'create'],
    ],
  );
  assert.deepEqual(out.plan.counts, {new: 13, same: 0, differs: 0, blocked: 0});
  assert.ok(
    out.plan.items.every((i) => i.warnings.length === 0),
    JSON.stringify(out.plan.items),
  );

  // B's objects, and every id in them is one of B.
  const pbxB = f.pbx('b').state;
  const group = only(pbxB['/PBX/AclGroups/'], 'acl groups of B');
  assert.equal(group.name, 'Support');
  assert.equal(only(pbxB['/PBX/Dialplans/'], 'dialplans of B').name, 'users');
  assert.equal(only(pbxB['/Dialplan/CallGroups/'], 'call groups of B').title, 'Sales');

  const w = y.wilma;
  const secret = only(w.secrets, 'secrets of it_y');
  assert.equal(secret.name, 'eleven');
  assert.equal(w.values[secret.id], GIVEN.eleven);
  const conn = only(w.connections, 'connections of it_y');
  assert.deepEqual(
    {name: conn.name, provider: conn.provider, scopes: conn.scopes},
    {name: 'crm', provider: 'hubspot', scopes: ['crm.read']},
  );
  const tool = (name) => w.tools.find((t) => t.name === name);
  assert.equal(w.tools.length, 2);
  assert.deepEqual(tool('lookup').handler.mcp.authorization, {customHeaders: {'X-Api-Key': GIVEN.header}});
  assert.deepEqual(tool('crm-tool').handler.mcp.authorization, {connection: {id: conn.id}});

  const source = only(y.kb.sources, 'KB sources of it_y');
  assert.deepEqual(source.config, {
    confluence: {
      baseUrl: 'https://wiki.example.net',
      username: 'a@x.example',
      spaceId: 'ENG',
      apiKey: GIVEN.confluence,
    },
  });
  const kb = only(y.kb.kbs, 'knowledge bases of it_y');
  assert.deepEqual(kb.dataSources, [source.id]);

  const skill = only(w.skills, 'skills of it_y');
  const upload = only(f.uploads, 'uploads');
  assert.equal(Buffer.from(upload.body).toString(), 'notes');
  const fileId = only(skill.files, 'files of the skill').id;
  assert.equal(upload.path, `/${fileId}`);
  assert.deepEqual(skill.files, [{id: fileId, path: 'refs/notes.md', name: 'notes.md'}]);

  // The agent: published (its latest version is its whole definition) and deployed, as on the source.
  const agent = only(w.agents, 'agents of it_y');
  assert.equal(agent.name, 'Support');
  assert.ok(agent.latestVersion >= 1, JSON.stringify(agent));
  const published = w.versions[agent.id].find((v) => v.version === agent.latestVersion).definition;
  assert.deepEqual(w.deployments[agent.id], [{version: agent.latestVersion, percentage: 100}]);
  for (const def of [agent, published]) {
    assert.deepEqual(def.settings, {pbxGroupId: group.id});
    assert.deepEqual(def.access, {grants: [{userId: 'u-anna-y'}]});
    assert.equal(def.channels.voice.speech.languages[0].voice, `elevenlabs://v1?apiKey=secrets:${secret.id}`);
    assert.deepEqual(def.engine.ai.skills, [{id: skill.id, skillVersion: skill.latestVersion}]);
    assert.deepEqual(def.engine.ai.capabilities, [
      {tool: {id: tool('lookup').id, toolVersion: tool('lookup').latestVersion}},
      {tool: {id: tool('crm-tool').id, toolVersion: tool('crm-tool').latestVersion}},
      {kb: {knowledgeBaseId: kb.id}},
      {transfer: {variant: 'predefined', context: 'users'}},
    ]);
  }

  const hook = only(y.integrations.installed, 'integrations of it_y');
  assert.deepEqual(hook.data, {
    type: 'webhook',
    url: HOOK,
    key: '',
    secret: GIVEN.webhook,
    events: [{value: 'call:completed'}],
  });
  const widget = only(y.kite.widgets, 'widgets of it_y');
  assert.deepEqual(widget.target, {service: {id: 77, uri: `77@${B}:443`}});

  // No id of the source company is left in the cloud of it_y.
  const sourceIds = [
    'sec0x001',
    'conn0x01',
    'tool00000x01',
    'tool00000x02',
    'skill0000x01',
    'agent000x001',
    'file0x01',
    'kb-x1',
    'ds-x1',
    'u-ann-x',
    'wgt-x1',
    `42@${A}`,
  ];
  const cloudOfY = JSON.stringify({wilma: w, kb: y.kb, integrations: y.integrations, kite: y.kite.widgets});
  for (const id of sourceIds) assert.ok(!cloudOfY.includes(id), `${id} is in the cloud of it_y`);
  // Nothing of it_x changed: copy only reads the source (the Stream directory is queried by POST).
  assert.deepEqual(
    f.writes({company: 'it_x'}).map((c) => [c.service, c.method, c.path, c.body]),
    [['stream', 'POST', '/api/v1/users/query', {query: {ids: ['u-ann-x']}}]],
  );
  assert.ok(x.wilma.agents.length === 1 && !x.wilma.values);

  // What is left to do: authorize the shared connection, start the first sync of the new KB source; besides them,
  // the two steps every copy that writes an ACL group has (who may administer B, what a transfer never carries).
  assert.deepEqual(
    out.nextSteps.map((s) => [s.what, s.blocking]),
    [
      ['authorize crm in the WIM console', true],
      ['Start the first sync of the knowledge-base source Wiki', true],
      [`Check who may administer ${B}: ACL groups were written (Support)`, false],
      [
        'Set up by hand what a transfer never carries: devices, PSTN and FXO trunks, system settings (SMTP, NTP, features, trusted IPs)',
        false,
      ],
    ],
  );
  assert.deepEqual(out.nextSteps[0].objects, [{kind: 'wilma-connections', name: 'crm'}]);
  const log = logOf(logDir);
  assert.match(log, /Z next 1 \(needed\): authorize crm in the WIM console —/);
  // The values reached B, and only B: not the output, the messages or the log of the copy.
  for (const [where, t] of [
    ['stdout', r.stdout],
    ['stderr', r.stderr],
    ['log', log],
  ])
    for (const v of [...Object.values(GIVEN), ...Object.values(SOURCE)]) assert.ok(!t.includes(v), `${where}: ${v}`);
});

test('export → delete → import → dry-run is all same', async () => {
  const {f, x} = companies();
  const {dir} = await exportIt(f, ['--all', '--cloud']);

  // Every cloud object of it_x is lost (deleted in the services, not by a command); the PBX keeps its own.
  for (const k of ['secrets', 'connections', 'tools', 'skills', 'agents']) x.wilma[k].length = 0;
  x.kb.kbs.length = 0;
  x.kb.sources.length = 0;
  x.integrations.installed.length = 0;
  x.kite.widgets.length = 0;

  // The backup goes back to its own company: the secret values are not in it, they are given again.
  const secrets = writeJson('secrets.json', secretsFile());
  const restored = await importIt(f, dir, A, ['--cloud', '--all', '--yes', '--secrets', secrets]);
  assert.equal(restored.r.code, 0, restored.r.stderr);
  const cloudKey = (k) => !/^(acl-groups|queues|dialplans)\//.test(k);
  assert.deepEqual(
    restored.out.results.map((r) => [r.key, r.action]),
    [
      ['wilma-secrets/eleven', 'create'],
      ['wilma-connections/crm', 'create'],
      ['kb-sources/Wiki', 'create'],
      ['kb-bases/Docs', 'create'],
      ['wilma-tools/lookup', 'create'],
      ['wilma-tools/crm-tool', 'create'],
      ['wilma-skills/faq', 'create'],
      ['wilma-agents/Support', 'create'],
      [`integration-webhooks/${HOOK}`, 'create'],
      ['kite-widgets/Site chat', 'create'],
    ],
  );

  // The same backup against the restored company: every cloud object is the same.
  const again = await importIt(f, dir, A, ['--cloud', '--all', '--dry-run']);
  assert.equal(again.r.code, 0, again.r.stderr);
  const cloud = again.out.plan.items.filter((i) => cloudKey(i.key));
  assert.equal(cloud.length, 10);
  assert.deepEqual(
    cloud.filter((i) => i.state !== 'same'),
    [],
  );
  assert.deepEqual(again.out.plan.counts, {new: 0, same: 13, differs: 0, blocked: 0});
});

test('nothing secret leaves memory', async () => {
  const {f, y} = companies();
  const exported = await exportIt(f, ['--all', '--cloud']);
  const {dir} = exported;
  // No webhook secret is given: the new webhook gets a generated one.
  const secrets = writeJson('secrets.json', secretsFile({webhook: false}));
  const map = writeJson('map.json', MAP);
  const args = ['--cloud', '--all', '--yes', '--secrets', secrets, '--map', map];
  const generatedOf = (cloud) => only(cloud.integrations.installed, 'integrations').data.secret;

  // --json: neither a given value nor a value of the source; the generated secret once, in generatedSecrets.
  const json = await importIt(f, dir, B, args);
  assert.equal(json.r.code, 0, json.r.stderr);
  const generated = generatedOf(y);
  assert.match(generated, /^[A-Za-z0-9]{30}$/);
  assert.deepEqual(json.out.results.find((x) => x.key === `integration-webhooks/${HOOK}`).generated, {path: 'secret'});
  assert.deepEqual(json.out.generatedSecrets, {[`integration-webhooks/${HOOK}`]: {secret: generated}});
  assert.equal(json.r.stdout.split(generated).length, 2);
  // The values did reach the target, so they were in memory.
  assert.equal(only(y.wilma.secrets, 'secrets').name, 'eleven');
  assert.deepEqual(Object.values(y.wilma.values), [GIVEN.eleven]);
  assert.equal(only(y.kb.sources, 'sources').config.confluence.apiKey, GIVEN.confluence);

  // The text output, on a company of its own: the generated secret once, on its line.
  const other = companies();
  const text = await importIt(other.f, dir, B, args, {output: 'text'});
  assert.equal(text.r.code, 0, text.r.stderr);
  const shown = generatedOf(other.y);
  assert.notEqual(shown, generated);
  const lines = text.r.stdout.split('\n').filter((l) => l.includes(shown));
  assert.deepEqual(lines, [`New signing secret of ${HOOK}: ${shown} (shown once; give it to the receiver)`]);
  assert.equal(text.r.stdout.split(shown).length, 2);

  const values = [...Object.values(GIVEN), ...Object.values(SOURCE), generated, shown];
  const files = filesUnder(dir);
  assert.ok(files.some(([p]) => p === path.join('files', 'wilma-skills', 'faq', 'refs', 'notes.md')));
  const places = [
    ...files.map(([p, t]) => [`export folder: ${p}`, t]),
    ['export stdout', exported.r.stdout],
    ['export stderr', exported.r.stderr],
    ['--json stdout (but the generated secret)', json.r.stdout.split(generated).join('')],
    ['--json stderr', json.r.stderr],
    ['--json log', json.log],
    ['text stdout (but the generated secret)', text.r.stdout.split(shown).join('')],
    ['text stderr', text.r.stderr],
    ['text log', text.log],
  ];
  for (const [where, t] of places)
    for (const v of values)
      assert.ok(!t.includes(v), `${where} holds ${v === shown || v === generated ? 'the generated secret' : v}`);
});

test('masked file is refused', async () => {
  const {f} = companies();
  const {dir} = await exportIt(f, ['--all', '--cloud']);
  // The header of the tool as a masked listing shows it, written back over its $secret marker.
  const file = path.join(dir, 'wilma-tools.jsonl');
  const lines = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const lookup = lines.find((o) => o.name === 'lookup');
  assert.deepEqual(lookup.data.handler.mcp.authorization.customHeaders, {'X-Api-Key': {$secret: HEADER_PATH}});
  lookup.data.handler.mcp.authorization.customHeaders['X-Api-Key'] = '********';
  fs.writeFileSync(file, `${lines.map((o) => JSON.stringify(o)).join('\n')}\n`);

  const mark = f.calls.length;
  const secrets = writeJson('secrets.json', secretsFile());
  const {r, log} = await importIt(f, dir, B, ['--cloud', '--all', '--yes', '--secrets', secrets]);
  assert.equal(r.code, 64, r.stderr);
  assert.match(r.stderr, new RegExp(`wilma-tools/lookup: ${HEADER_PATH.replaceAll('.', '\\.')} holds the mask \\*{8}`));
  assert.equal(log, undefined);
  // Refused before anything is read or written, on the PBX or in the cloud.
  assert.deepEqual(f.calls.slice(mark), []);
});

test('a secret in the name of an object never leaves memory', async () => {
  const {f, x} = companies();
  // A webhook known by its URL, which holds a token: bound by the safety net, and its name must not tell the token.
  const TOKEN = 'SUPERSECRET123';
  const url = `https://hooks.example/in?token=${TOKEN}`;
  x.integrations.installed.push({
    integrationId: 'wh-x2',
    service: 'webhook',
    status: 'enabled',
    data: {type: 'webhook', url, key: '', events: [{value: 'call:completed'}]},
  });

  const json = await exportIt(f, ['--all', '--cloud']);
  const out = JSON.parse(json.r.stdout);
  const bound = out.bound.find((b) => b.kind === 'integration-webhooks');
  assert.deepEqual(bound, {
    kind: 'integration-webhooks',
    name: 'https://hooks.example/in?token=********',
    path: 'url',
    found: 'secret',
  });
  const textDir = path.join(tempConfigDir(), 'exp-text');
  const text = await run(['config', 'export', '--to', textDir, '--pbx', A, '--all', '--cloud'], {
    env: f.env,
    fetch: f.fetch,
    output: 'text',
  });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /not exported: integration-webhooks\/https:\/\/hooks\.example\/in\?token=\*{8} /);
  const logDir = tempConfigDir();
  const copy = await run(['config', 'copy', '--from', A, '--to', B, '--cloud', '--all', '--dry-run', '--log', logDir], {
    env: f.env,
    fetch: f.fetch,
    output: 'text',
  });
  assert.equal(copy.code, 0, copy.stderr);
  assert.match(copy.stderr, /not carried: integration-webhooks\/https:\/\/hooks\.example\/in\?token=\*{8} /);

  const places = [
    ...filesUnder(json.dir).map(([p, t]) => [`export folder: ${p}`, t]),
    ...filesUnder(textDir).map(([p, t]) => [`text export folder: ${p}`, t]),
    ['--json stdout', json.r.stdout],
    ['--json stderr', json.r.stderr],
    ['text stdout', text.stdout],
    ['text stderr', text.stderr],
    ['copy stdout', copy.stdout],
    ['copy stderr', copy.stderr],
    ['copy log', logOf(logDir)],
  ];
  for (const [where, t] of places) assert.ok(!t.includes(TOKEN), `${where} holds the token`);
});
