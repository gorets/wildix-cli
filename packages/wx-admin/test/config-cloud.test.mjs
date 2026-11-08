import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {jwtClaims} from 'wldx-core/auth';
import {CLOUD_EXPORTED, cloudKindsOf} from '../src/transfer/cloud-clients.mjs';
import {TRANSFER_KINDS} from '../src/transfer/kinds.mjs';
import {refsOf, toPortable} from '../src/transfer/refs.mjs';
import {secretPrompt} from '../src/transfer/run.mjs';
import {closure, GROUPS} from '../src/transfer/selection.mjs';
import {fakeCompany} from './fake-company.mjs';
import {run, tempConfigDir} from './helpers.mjs';

// config export, import and copy with the cloud of the company: the real commands, against two PBX of their own
// companies (a.wildixin.com of it_x, b.wildixin.com of it_y) and the cloud of each.

const CPA_ROUTE = '/api/v1/PBX/integration/x-bees';
const HOOK = 'https://crm.example.com/hook';
const A = 'a.wildixin.com';
const B = 'b.wildixin.com';

// Versioned Wilma objects (tools, skills, agents) as the service keeps them: the draft on the object, the published
// definition in its versions.
function versioned(coll, idKey, specs) {
  const objects = [];
  const versions = {};
  for (const {id, published, version = 2} of specs) {
    objects.push({id, companyId: 'c', ...published, status: 'active', revision: 3, latestVersion: version});
    versions[id] = [{[idKey]: id, version, changelog: 'old', definition: {id, ...published}}];
  }
  return {[coll]: objects, versions};
}
const agentDef = (name, ai = {}, extra = {}) => ({
  name,
  description: 'd',
  channels: {},
  engine: {ai: {instructions: 'Help', ...ai}},
  ...extra,
});

function wilmaOfX() {
  const tools = versioned('tools', 'toolId', [
    {id: 'x1', published: {name: 'lookup', category: 'Support', description: 'd'}},
  ]);
  const skills = versioned('skills', 'skillId', [
    {id: 'k1', published: {name: 'faq', description: 'd', content: '# Steps'}, version: 3},
  ]);
  const agents = versioned('agents', 'agentId', [
    {
      id: 'ag0000000001',
      published: agentDef(
        'Support',
        {
          skills: [{id: 'k1', skillVersion: 3}],
          capabilities: [
            {tool: {id: 'x1', toolVersion: 2}},
            {kb: {knowledgeBaseId: 'kb1'}},
            {transfer: {variant: 'predefined', context: 'users', extension: '201'}},
          ],
        },
        {
          settings: {pbxGroupId: '7'},
          channels: {voice: {speech: {languages: [{code: 'en-US', voice: 'elevenlabs://v1?apiKey=secrets:S1'}]}}},
        },
      ),
    },
    {id: 'ag0000000002', published: agentDef('Other')},
  ]);
  return {
    secrets: [{id: 'S1', name: 'eleven', revision: 3, status: 'active', createdAt: 'x'}],
    tools: tools.tools,
    skills: skills.skills,
    agents: agents.agents,
    versions: {...tools.versions, ...skills.versions, ...agents.versions},
    deployments: {ag0000000002: [{version: 2, percentage: 100}]},
  };
}
const webhook = () => ({
  integrationId: 'wh1',
  service: 'webhook',
  status: 'enabled',
  data: {
    type: 'webhook',
    url: HOOK,
    key: '',
    secret: 'SrcSigningSecretSrcSigning1234',
    events: [{value: 'call:completed'}],
  },
});

const pbxOf = (group, dialplan, timetables = []) => ({
  '/PBX/version/': {version: '7.11'},
  '/PBX/settings/license/': {limitations: {licenseTypes: {}}, licenseUsage: {}},
  '/PBX/AclGroups/': [{id: group, name: 'Support', inherits: null, rules: [], adminRules: []}],
  '/PBX/Dialplans/': [{id: dialplan, name: 'users', description: '', includedDialplans: [], numbers: []}],
  '/Dialplan/timeTables/': timetables,
});

// it_x has everything; it_y has the cloud services, empty unless given (y: its Wilma).
function company({sameCompany = false, y = {}} = {}) {
  const other = sameCompany ? 'it_x' : 'it_y';
  return fakeCompany({
    pbxs: {
      a: {company: 'it_x', pbx: pbxOf('7', '3', [{id: '6', title: 'office', items: [1]}])},
      b: {company: other, pbx: pbxOf('12', '9')},
    },
    clouds: {
      it_x: {
        wilma: wilmaOfX(),
        kb: {kbs: [{id: 'kb1', name: 'Docs', description: '', dataSources: []}]},
        integrations: {installed: [webhook()]},
        kite: {},
        stream: {},
      },
      ...(sameCompany ? {} : {it_y: {wilma: y, kb: {}, integrations: {}, kite: {}, stream: {}}}),
    },
  });
}

const cpaCalls = (f, host) => f.calls.filter((c) => c.host === host && c.path === CPA_ROUTE);
const pbxWrites = (f, name) => f.pbxCalls(name).filter((c) => c.method !== 'GET');
const servicesOf = (calls) => [...new Set(calls.map((c) => c.service))].sort();

async function exportIt(f, args) {
  const dir = path.join(tempConfigDir(), 'exp');
  const r = await run(['config', 'export', '--to', dir, '--pbx', A, ...args], {env: f.env, fetch: f.fetch});
  assert.equal(r.code, 0, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return {dir, manifest, r};
}

async function importIt(f, dir, args, {output = 'json', fetch = f.fetch} = {}) {
  const logDir = tempConfigDir();
  const r = await run(['config', 'import', dir, '--pbx', B, '--log', logDir, ...args], {env: f.env, fetch, output});
  const logs = fs.readdirSync(logDir);
  const log = logs.length ? fs.readFileSync(path.join(logDir, logs[0]), 'utf8') : '';
  return {r, log, out: output === 'json' && r.stdout ? JSON.parse(r.stdout) : undefined};
}

test('PBX-only import makes no cloud call', async () => {
  const f = company();
  const {dir, manifest} = await exportIt(f, ['--all', '--cloud']);
  assert.ok(manifest.kinds['wilma-agents']);
  const mark = f.calls.length;
  const {r, out} = await importIt(f, dir, ['--all', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  const calls = f.calls.slice(mark);
  assert.deepEqual(
    calls.filter((c) => c.service !== 'pbx'),
    [],
  );
  assert.deepEqual(cpaCalls(f, B), []);
  assert.deepEqual(
    out.results.map((x) => [x.key, x.action]),
    [['timetables/office', 'create']],
  );
  assert.ok(out.plan.items.every((i) => TRANSFER_KINDS[i.key.split('/')[0]].side === 'pbx'));
  assert.match(r.stderr, /add --cloud/);
});

test('export --all without --cloud carries no cloud kind', async () => {
  const f = company();
  const {manifest} = await exportIt(f, ['--all']);
  assert.deepEqual(Object.keys(manifest.kinds).sort(), ['acl-groups', 'dialplans', 'timetables']);
  assert.deepEqual(manifest.source, {host: A, wms: '7.11', exportedAt: manifest.source.exportedAt});
  assert.deepEqual(f.cloudCalls(), []);
  assert.deepEqual(cpaCalls(f, A), []);
});

test('export --all --cloud carries them', async () => {
  const f = company();
  const {dir, manifest} = await exportIt(f, ['--all', '--cloud']);
  assert.deepEqual(manifest.kinds, {
    'acl-groups': 1,
    timetables: 1,
    dialplans: 1,
    'wilma-secrets': 1,
    'kb-bases': 1,
    'wilma-tools': 1,
    'wilma-skills': 1,
    'wilma-agents': 2,
    'integration-webhooks': 1,
  });
  assert.equal(manifest.source.company, 'it_x');
  assert.equal(manifest.source.env, 'stage');
  // Only the cloud of it_x is read, only read, and only the services the kinds use (no user named: no Stream).
  assert.ok(f.cloudCalls().every((c) => c.company === 'it_x' && c.method === 'GET'));
  assert.deepEqual(servicesOf(f.cloudCalls()), ['integrations', 'kb', 'kite', 'wilma']);
  assert.deepEqual([...new Set(f.cloudCalls().map((c) => c.host))].sort(), [
    'api-stage.wilma.wildix.com',
    'api-stage.x-bees.com',
    'kb.wim-stage.wildix.com',
    'wim-stage.wildix.com',
  ]);
  assert.equal(cpaCalls(f, A).length, 1);
  const files = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
  assert.ok(files.every((t) => !t.includes('SrcSigningSecret')));
});

test('--only of a lookup kind is refused, naming the kinds an export carries', async () => {
  const f = company();
  const r = await run(
    ['config', 'export', '--to', path.join(tempConfigDir(), 'x'), '--pbx', A, '--only', 'xbees-users:a'],
    {
      env: f.env,
      fetch: f.fetch,
    },
  );
  assert.equal(r.code, 64);
  assert.match(r.stderr, /xbees-users is not exported/);
  assert.match(r.stderr, /wilma-agents/);
  assert.doesNotMatch(r.stderr, /xbees-bots/);
});

test('--only wilma-agents:Support brings tool, skill, KB, secret, acl group, dialplan', async () => {
  const f = company();
  const {dir, manifest} = await exportIt(f, ['--only', 'wilma-agents:Support']);
  assert.deepEqual(manifest.kinds, {
    'acl-groups': 1,
    dialplans: 1,
    'wilma-secrets': 1,
    'kb-bases': 1,
    'wilma-tools': 1,
    'wilma-skills': 1,
    'wilma-agents': 1,
  });
  const agent = JSON.parse(fs.readFileSync(path.join(dir, 'wilma-agents.jsonl'), 'utf8'));
  assert.equal(agent.name, 'Support');
  assert.deepEqual(agent.data.settings, {pbxGroupId: {$ref: 'acl-groups/Support', as: 'id'}});
  // No integration is read for an agent; the x-bees services are (an agent may hand over to one).
  assert.deepEqual(servicesOf(f.cloudCalls()), ['kb', 'kite', 'wilma']);
});

test('copy within one company leaves the cloud out', async () => {
  const f = company({sameCompany: true});
  const r = await run(
    ['config', 'copy', '--from', A, '--to', B, '--all', '--cloud', '--yes', '--log', tempConfigDir()],
    {
      env: f.env,
      fetch: f.fetch,
    },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /same company — nothing to copy/);
  assert.deepEqual(f.cloudCalls(), []);
  assert.deepEqual(
    JSON.parse(r.stdout).results.map((x) => [x.key, x.action]),
    [['timetables/office', 'create']],
  );
  assert.equal(f.pbx('b').state['/Dialplan/timeTables/'].length, 1);
});

test('cloud token refused → exit 2 before any write', async () => {
  const f = company();
  const {dir} = await exportIt(f, ['--all', '--cloud']);
  // The cloud refuses every token of it_y.
  const refusing = async (url, init = {}) => {
    const auth = Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    const bearer = /^Bearer (.+)$/.exec(auth ?? '')?.[1];
    if (bearer && jwtClaims(bearer)['custom:company_id'] === 'it_y')
      return new Response(JSON.stringify({message: 'Unauthorized'}), {status: 401});
    return f.fetch(url, init);
  };
  const mark = f.calls.length;
  const {r} = await importIt(f, dir, ['--all', '--cloud', '--yes'], {fetch: refusing});
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /refused the token of it_y/);
  assert.deepEqual(pbxWrites(f, 'b'), []);
  assert.deepEqual(
    f.calls.slice(mark).filter((c) => c.method !== 'GET'),
    [],
  );
});

test('a PBX that gives no cloud token is an AuthError before anything is read in the cloud', async () => {
  const f = company();
  const {dir} = await exportIt(f, ['--all', '--cloud']);
  const noToken = async (url, init) =>
    new URL(String(url)).pathname === CPA_ROUTE && new URL(String(url)).host === B
      ? new Response(JSON.stringify({type: 'result', result: {}}), {status: 200})
      : f.fetch(url, init);
  const mark = f.calls.length;
  const {r} = await importIt(f, dir, ['--all', '--cloud', '--yes'], {fetch: noToken});
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /no cloud token/);
  assert.deepEqual(
    f.calls.slice(mark).filter((c) => c.service !== 'pbx' || c.method !== 'GET'),
    [],
  );
});

test('dry-run lists differing paths and writes nothing', async () => {
  const theirs = versioned('agents', 'agentId', [
    {id: 'ag0000000009', published: agentDef('Other', {instructions: 'Help more'})},
  ]);
  const f = company({y: {...theirs, deployments: {ag0000000009: [{version: 2, percentage: 100}]}}});
  const {dir} = await exportIt(f, ['--all', '--cloud']);
  const mark = f.calls.length;
  const args = ['--only', 'wilma-agents:Other', '--overwrite', '--dry-run'];
  const {r, out, log} = await importIt(f, dir, args);
  assert.equal(r.code, 0, r.stderr);
  const item = out.plan.items.find((i) => i.key === 'wilma-agents/Other');
  assert.deepEqual(item, {
    key: 'wilma-agents/Other',
    state: 'differs',
    paths: ['engine.ai.instructions'],
    deploys: true,
    warnings: [],
  });
  assert.match(log, /deploys: wilma-agents\/Other/);
  const text = await importIt(f, dir, args, {output: 'text'});
  assert.equal(text.r.code, 0, text.r.stderr);
  const lines = text.r.stdout.split('\n');
  const cloud = lines.indexOf('Cloud:');
  assert.ok(cloud > 0, text.r.stdout);
  assert.ok(
    lines.slice(cloud).some((l) => /differs wilma-agents\/Other: engine\.ai\.instructions \(deploys\)/.test(l)),
  );
  // Read only: GET everywhere, in the cloud of it_y and on its PBX.
  assert.deepEqual(
    f.calls.slice(mark).filter((c) => c.method !== 'GET'),
    [],
  );
  assert.ok(
    f
      .cloudCalls()
      .slice(0)
      .every((c) => c.method === 'GET'),
  );
  assert.ok(
    f.calls
      .slice(mark)
      .filter((c) => c.service !== 'pbx')
      .every((c) => c.company === 'it_y'),
  );
});

test('an export from another environment is a warning, in the output and the log', async () => {
  const f = company();
  const {dir} = await exportIt(f, ['--only', 'integration-webhooks:*']);
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({...manifest, source: {...manifest.source, env: 'prod'}}));
  const {r, log} = await importIt(f, dir, ['--cloud', '--all', '--dry-run'], {output: 'text'});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /exported from prod, written to stage/);
  assert.match(log, /exported from prod, written to stage/);
});

test('generated webhook secret shown once in the output (text and --json), never in the log or next steps', async () => {
  const args = ['--only', `integration-webhooks:${HOOK}`, '--yes'];
  const generatedOf = (f) => f.calls.find((c) => c.company === 'it_y' && c.method === 'POST')?.body.data.secret;

  let f = company();
  let {dir} = await exportIt(f, ['--all', '--cloud']);
  const json = await importIt(f, dir, args);
  assert.equal(json.r.code, 0, json.r.stderr);
  let secret = generatedOf(f);
  assert.match(secret, /^[A-Za-z0-9]{30}$/);
  assert.deepEqual(json.out.results, [
    {
      key: `integration-webhooks/${HOOK}`,
      action: 'create',
      id: 'int-new1',
      steps: ['create'],
      generated: {path: 'secret'},
    },
  ]);
  // With --json the result is the only place it can be shown: once, in generatedSecrets.
  assert.deepEqual(json.out.generatedSecrets, {[`integration-webhooks/${HOOK}`]: {secret}});
  assert.equal(json.r.stdout.split(secret).length, 2);
  assert.ok(!JSON.stringify(json.out.nextSteps).includes(secret));
  assert.equal(
    json.out.nextSteps[0].what,
    `Give the new signing secret of ${HOOK} to its receiver (shown once in the output)`,
  );
  for (const s of [json.r.stderr, json.log]) assert.ok(!s.includes(secret));

  f = company();
  ({dir} = await exportIt(f, ['--all', '--cloud']));
  const text = await importIt(f, dir, args, {output: 'text'});
  assert.equal(text.r.code, 0, text.r.stderr);
  secret = generatedOf(f);
  assert.equal(text.r.stdout.split(secret).length, 2, text.r.stdout);
  assert.match(
    text.r.stdout,
    new RegExp(`New signing secret of ${HOOK}: ${secret} \\(shown once; give it to the receiver\\)`),
  );
  assert.ok(!text.r.stderr.includes(secret) && !text.log.includes(secret));
});

test('the prompt of a secret says what an empty answer does, by the policy of its path', () => {
  const it = (kind, name, state = 'new') => ({kind, name, key: `${kind}/${name}`, state});
  assert.equal(
    secretPrompt(it('trunks-sip', 'carrier'), 'settingsPbx.secret'),
    'SIP trunk carrier, settingsPbx.secret (empty: skip it): ',
  );
  assert.equal(
    secretPrompt(it('wilma-secrets', 'openai'), 'value'),
    'Wilma secret openai, value (empty: created pending): ',
  );
  assert.equal(
    secretPrompt(it('kb-sources', 'Wiki'), 'config.confluence.apiKey'),
    'KB data source Wiki, config.confluence.apiKey (empty: created without configuration): ',
  );
  assert.equal(
    secretPrompt(it('integration-webhooks', HOOK), 'secret'),
    `webhook ${HOOK}, secret (empty: a new one is generated): `,
  );
  assert.equal(
    secretPrompt(it('integration-webhooks', HOOK, 'differs'), 'secret'),
    `webhook ${HOOK}, secret (empty: keep the current one): `,
  );
});

test('cloud kinds of a run: all with --cloud, else those --only names and what they may point at', () => {
  for (const kind of CLOUD_EXPORTED) {
    assert.ok(Array.isArray(TRANSFER_KINDS[kind].refers), `${kind} declares refers`);
    for (const k of TRANSFER_KINDS[kind].refers) assert.ok(TRANSFER_KINDS[k], `${kind} refers to ${k}`);
  }
  assert.deepEqual(cloudKindsOf({all: true}), []);
  assert.deepEqual(cloudKindsOf({only: 'dialplans:main'}), []);
  assert.deepEqual(cloudKindsOf({all: true, cloud: true}), CLOUD_EXPORTED);
  assert.deepEqual(cloudKindsOf({only: 'kb-bases:Docs'}), ['kb-sources', 'kb-bases']);
  assert.deepEqual(cloudKindsOf({only: 'kite-widgets:w'}), ['kite-widgets']);
  assert.deepEqual(
    GROUPS.map((g) => g.id),
    ['routing', 'users', 'trunks', 'wilma', 'kb', 'integrations', 'kite'],
  );
});

test('a widget chosen alone brings the queue its x-bees service is synced from', () => {
  const portable = {
    kinds: {
      queues: [{name: 'Sales', data: {title: 'Sales'}}],
      'kite-widgets': [{name: 'w', data: {name: 'w', target: {service: {$ref: 'xbees-services/Sales', as: 'object'}}}}],
    },
    needs: {'kite-widgets/w': ['xbees-services/Sales']},
  };
  assert.deepEqual([...closure(portable, ['kite-widgets/w'])], ['kite-widgets/w', 'queues/Sales']);
});

test('the PBX text of export and import is as it was: the counts block, no line for a PBX object that differs', async () => {
  const f = fakeCompany({
    pbxs: {
      a: {company: 'it_x', pbx: pbxOf('7', '3', [{id: '6', title: 'office', items: [1]}])},
      b: {company: 'it_y', pbx: pbxOf('12', '9', [{id: '60', title: 'office', items: [2]}])},
    },
  });
  const dir = path.join(tempConfigDir(), 'exp');
  const exported = await run(['config', 'export', '--to', dir, '--pbx', A, '--only', 'timetables:*,acl-groups:*'], {
    env: f.env,
    fetch: f.fetch,
    output: 'text',
  });
  assert.equal(exported.code, 0, exported.stderr);
  const out = exported.stdout.split('\n');
  assert.deepEqual(out.slice(0, 3), [
    `Exported from ${A} to ${dir}`,
    '  acl-groups         1',
    '  timetables         1',
  ]);
  assert.ok(!out.some((l) => /cloud/i.test(l)));
  const logDir = tempConfigDir();
  const imported = await run(['config', 'import', dir, '--pbx', B, '--all', '--dry-run', '--log', logDir], {
    env: f.env,
    fetch: f.fetch,
    output: 'text',
  });
  assert.equal(imported.code, 0, imported.stderr);
  assert.deepEqual(imported.stdout.split('\n').slice(0, 4), [
    `Dry run: nothing was written to ${B}`,
    `Plan from ${dir} (exported from ${A}): 0 new, 1 same, 1 differs, 0 blocked`,
    '',
    'Next steps:',
  ]);
});

// Every place a portable hook makes a reference, in one snapshot of the source: what it points at is in the snapshot,
// so each reference becomes a $ref.
function richSnapshot() {
  const o = (id, name, data) => ({id, name, data});
  const caps = [
    {tool: {id: 'x1'}},
    {connector: {id: 'cn1'}},
    {kb: {knowledgeBaseId: 'kb1'}},
    {agent: {agentId: 'ag2', access: {grants: [{userId: 'u1'}, {groupId: '7'}]}}},
    {handover: {variant: 'agent', agent: 'ag2', service: '42'}},
    {delegation: {id: 'ag2'}},
    {transfer: {variant: 'predefined', context: 'users', extension: '201'}},
  ];
  const handler = {
    mcp: {authorization: {connection: {id: 'C1'}}, apiKey: {secret: {id: 'S1'}}},
    mcpTool: {mcpToolId: 'x2'},
  };
  const routing = {
    target: {service: {id: '42'}, agent: {email: 'ann@x.example'}, bot: {id: 'b1'}},
    routes: [{target: {service: {id: '42'}}}],
    actions: [{task: {userId: 'u1', botId: 'b1', emails: ['ann@x.example']}}],
  };
  return {
    'acl-groups': [o('7', 'Support', {name: 'Support'})],
    dialplans: [o('3', 'users', {name: 'users'})],
    'xbees-services': [{id: '42', name: 'Sales', value: {id: '42', uri: 'services/42'}, data: {}}],
    'xbees-users': [o('u1', 'ann@x.example', {})],
    'xbees-bots': [o('b1', 'Bot', {})],
    'wilma-secrets': [o('S1', 'eleven', {name: 'eleven'})],
    'wilma-connections': [o('C1', 'gh', {name: 'gh', type: 'shared', provider: 'github'})],
    'kb-sources': [o('ks1', 'Wiki', {name: 'Wiki', type: 'website', config: {urls: ['https://w.example']}})],
    'kb-bases': [o('kb1', 'Docs', {name: 'Docs', dataSources: ['ks1']})],
    'wilma-connectors': [o('cn1', 'crm', {name: 'crm', configuration: handler, authorization: handler})],
    'wilma-tools': [o('x1', 'lookup', {name: 'lookup', handler}), o('x2', 'server', {name: 'server', handler: {}})],
    'wilma-skills': [
      o('k1', 'faq', {name: 'faq', tools: caps, access: {editors: [{userId: 'u1'}], viewers: [{groupId: '7'}]}}),
    ],
    'wilma-agents': [
      o('ag1', 'Support', {
        name: 'Support',
        settings: {pbxGroupId: '7'},
        access: {grants: [{userId: 'u1'}, {groupId: '7'}]},
        channels: {
          voice: {
            silenceTimeout: {action: {transfer: {context: 'users'}}},
            maxDuration: {action: {transfer: {context: 'users'}}},
            speech: {languages: [{code: 'en-US', voice: 'elevenlabs://v1?apiKey=secrets:S1'}]},
          },
        },
        engine: {
          ai: {
            skills: [{id: 'k1'}],
            capabilities: caps,
            workflow: {steps: [{handler: {action: {capability: caps[0]}}}]},
          },
          webhook: {secret: {id: 'S1'}},
          sqs: {secret: {id: 'S1'}},
        },
      }),
      o('ag2', 'Helper', {name: 'Helper', engine: {ai: {instructions: 'h'}}}),
    ],
    'integration-webhooks': [o('wh1', 'https://h.example', {type: 'webhook', url: 'https://h.example', events: []})],
    'integration-apps': [o('ia1', 'Orders', {title: 'Orders', accessEmails: ['ann@x.example'], deniedEmails: []})],
    'integration-crm': [o('hubspot', 'hubspot', {settings: {}})],
    'kite-widgets': [o('w1', 'w', {name: 'w', ...routing})],
    'kite-channels': [o('sms:+3902', 'sms:+3902', {serviceUri: '42@pbx.example:443', ...routing})],
  };
}

test('every reference a cloud kind makes is to a kind it declares in refers (or a PBX kind)', () => {
  const snapshot = richSnapshot();
  assert.deepEqual(
    CLOUD_EXPORTED.filter((k) => !snapshot[k]),
    [],
  );
  const portable = toPortable(snapshot, {serial: 'aaaa00000001', host: A});
  const seen = new Set();
  for (const kind of CLOUD_EXPORTED)
    for (const o of portable.kinds[kind]) {
      const allowed = new Set(TRANSFER_KINDS[kind].refers);
      for (const r of refsOf(o.data)) {
        seen.add(`${kind}→${r.kind}`);
        assert.ok(allowed.has(r.kind) || TRANSFER_KINDS[r.kind]?.side === 'pbx', `${kind}/${o.name} → ${r.kind}`);
      }
    }
  // The fixture reaches every declared target (it is rich enough to catch a missing declaration).
  for (const kind of CLOUD_EXPORTED)
    for (const k of TRANSFER_KINDS[kind].refers) assert.ok(seen.has(`${kind}→${k}`), `fixture: ${kind} → ${k}`);
});

test('the command of a next step runs the same import again with --cloud and --map', async () => {
  const f = company();
  const {dir} = await exportIt(f, ['--all', '--cloud']);
  const map = path.join(tempConfigDir(), 'map.json');
  fs.writeFileSync(map, JSON.stringify({'xbees-users': {'ann@x.example': 'ann@y.example'}}));
  // The WIM console of it_y refuses the new webhook: a failed object, whose next step re-runs it.
  const failing = async (url, init = {}) =>
    new URL(String(url)).host === 'wim-stage.wildix.com' && init.method === 'POST'
      ? new Response(JSON.stringify({message: 'boom'}), {status: 500})
      : f.fetch(url, init);
  const {r, out} = await importIt(f, dir, ['--cloud', '--all', '--yes', '--map', map], {fetch: failing});
  assert.equal(r.code, 1, r.stderr);
  const commands = out.nextSteps.map((s) => s.command).filter((c) => c?.includes('config import'));
  assert.ok(commands.length > 0, JSON.stringify(out.nextSteps));
  for (const c of commands) assert.match(c, new RegExp(` --pbx ${B} --cloud --map ${map} --only `));
});

test('the steps of a cloud write are in its result and its log line; a PBX line is as it was', async () => {
  const f = company();
  const {dir} = await exportIt(f, ['--all', '--cloud']);
  const {r, out, log} = await importIt(f, dir, ['--only', 'wilma-agents:Other,timetables:office', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  const agent = out.results.find((x) => x.key === 'wilma-agents/Other');
  assert.deepEqual(agent.steps, ['update', 'publish', 'deploy']);
  assert.match(log, new RegExp(`Z create wilma-agents/Other id ${agent.id} \\[update, publish, deploy\\]\\n`));
  const timetable = out.results.find((x) => x.key === 'timetables/office');
  assert.equal(timetable.steps, undefined);
  assert.match(log, new RegExp(`Z create timetables/office id ${timetable.id}\\n`));
  assert.match(r.stderr, /create wilma-agents\/Other id \S+ \[update, publish, deploy\]/);
});

test('a map read from stdin is never repeated as --map - in a next step: the map file is asked again', async () => {
  const f = company();
  const {dir} = await exportIt(f, ['--all', '--cloud']);
  const failing = async (url, init = {}) =>
    new URL(String(url)).host === 'wim-stage.wildix.com' && init.method === 'POST'
      ? new Response(JSON.stringify({message: 'boom'}), {status: 500})
      : f.fetch(url, init);
  const r = await run(
    ['config', 'import', dir, '--pbx', B, '--cloud', '--all', '--yes', '--map', '-', '--log', tempConfigDir()],
    {env: f.env, fetch: failing, stdin: JSON.stringify({'xbees-users': {'ann@x.example': 'ann@y.example'}})},
  );
  assert.equal(r.code, 1, r.stderr);
  const steps = JSON.parse(r.stdout).nextSteps.filter((s) => s.command?.includes('config import'));
  assert.ok(steps.length > 0, r.stdout);
  for (const s of steps) {
    assert.ok(!s.command.includes('--map -'), s.command);
    assert.match(s.command, new RegExp(` --pbx ${B} --cloud --map FILE --only `));
    assert.match(s.why, /Give the map file again \(--map FILE\): it was read from stdin\.$/);
  }
});
