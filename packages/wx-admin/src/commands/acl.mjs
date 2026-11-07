// wx-admin acl: the ACL groups of the PBX (what the users of a group may do, and to which groups), over the PBX REST
// API. Operations (OpenAPI tags PBX, ACL), scope aclgroups (the spec names none for PUT and DELETE: aclgroups:*):
//   GET /PBX/AclGroups/                    the groups with their rules (there is no GET of one group)
//   POST /PBX/AclGroups/                   create {name, wcgrp?, inherits?: {dn}, rules?: [{rule, ability, group}]}
//   PUT /PBX/AclGroups/{groupId}/          change name, inherits, rules, adminRules (only the user "admin" may change
//                                          more than rules)
//   DELETE /PBX/AclGroups/{ids}/           delete (ids joined by commas)
//   GET /PBX/AclGroups/Rules/              the rules there are: {list, default, adminList}
//   GET /PBX/AclGroups/Permissions/        each permission and which groups have it; filters as permissions[]=KEY
//                                          and groups[]=ID (the comma form of the spec is ignored by the PBX)
// A rule is {rule (a key such as CALL), ability (yes/no, set/noset, use/nouse, call/nocall), group (a group DN, "all",
// or "" for rules that are not about a group)}; an admin rule is {subject, operation (epbx, egroup, epage, eperm
// and their no… forms)}.
import {readJsonInput as readJsonFile} from 'wldx-core/files';
import {pickByName} from '../match.mjs';
import {UsageError} from 'wldx-core/errors';
import {paint, table} from 'wldx-core/format';
import {pbxClient} from '../pbx.mjs';

const SCOPE = {scope: 'aclgroups'};
// The abilities the PBX gives (the spec also names true and false).
export const ABILITIES = ['yes', 'no', 'set', 'noset', 'use', 'nouse', 'call', 'nocall', 'true', 'false'];
export const ADMIN_OPERATIONS = ['epbx', 'noepbx', 'egroup', 'noegroup', 'epage', 'noepage', 'eperm', 'noeperm'];
const NAME = /^[^\s/\\,][^/\\,]{0,63}$/;
const RULE_KEY = /^[A-Za-z0-9_]{1,64}$/;

async function readJsonInput(ctx, from) {
  const data = await readJsonFile(ctx, from); // no credentials, nothing hidden in the home folder
  return data;
}

const listGroups = async (client) => (await client.call('GET', '/PBX/AclGroups/', undefined, SCOPE))?.records ?? [];

// A group of the list by id, name (any case) or DN.
function findGroup(list, ref) {
  const r = String(ref);
  const byIdOrDn = list.find((g) => String(g.id) === r || g.dn === r);
  return byIdOrDn ?? pickByName(list, r, (g) => g.name, 'ACL group', 'wx-admin acl list');
}

const groupPath = (...ids) => {
  for (const id of ids) if (!/^\d+$/.test(String(id))) throw new UsageError(`Not an ACL group id: ${id}`);
  return `/PBX/AclGroups/${ids.join(',')}/`;
};

// The DN a rule is about: "all", "" (none), a DN, or the id or name of a group.
function targetDn(list, ref) {
  if (ref === undefined || ref === '' || ref === 'all') return ref ?? '';
  if (/^gid=/.test(ref)) return ref;
  return findGroup(list, ref).dn;
}

// --rule "KEY ABILITY [GROUP]".
function parseRule(spec, list) {
  const [rule, ability, ...rest] = String(spec).trim().split(/\s+/);
  if (!RULE_KEY.test(rule ?? '') || !ability)
    throw new UsageError(`--rule is "KEY ABILITY [GROUP]", e.g. "CALL yes all": ${spec}`);
  if (!ABILITIES.includes(ability)) throw new UsageError(`An ability is one of ${ABILITIES.join(', ')}: ${ability}`);
  return {rule, ability, group: targetDn(list, rest.join(' ') || '')};
}

// --admin-rule "SUBJECT OPERATION".
function parseAdminRule(spec, list) {
  const [subject, operation] = String(spec).trim().split(/\s+/);
  if (!subject || !ADMIN_OPERATIONS.includes(operation))
    throw new UsageError(
      `--admin-rule is "SUBJECT OPERATION" (${ADMIN_OPERATIONS.join(', ')}), e.g. "users__users epage": ${spec}`,
    );
  const group = list.find((g) => g.name === subject || String(g.id) === subject);
  return {subject: group && /group/.test(operation) ? group.dn : subject, operation};
}

const sameRule = (a, b) => a.rule === b.rule && (a.group ?? '') === (b.group ?? '');

// The rules with --rule (added, or replacing the one of the same key and group) and --remove-rule "KEY [GROUP]".
function changedRules(rules, values, list) {
  let out = [...rules];
  for (const spec of values['remove-rule'] ?? []) {
    const [rule, ...rest] = String(spec).trim().split(/\s+/);
    const group = rest.length ? targetDn(list, rest.join(' ')) : undefined;
    const before = out.length;
    out = out.filter((r) => !(r.rule === rule && (group === undefined || (r.group ?? '') === group)));
    if (out.length === before) throw new UsageError(`The group has no rule ${spec}`);
  }
  for (const spec of values.rule ?? []) {
    const r = parseRule(spec, list);
    const at = out.findIndex((x) => sameRule(x, r));
    if (at >= 0) out[at] = r;
    else out.push(r);
  }
  return out;
}

function changedAdminRules(rules, values, list) {
  let out = [...rules];
  for (const subject of values['remove-admin-rule'] ?? []) {
    const before = out.length;
    const dn = list.find((g) => g.name === subject || String(g.id) === subject)?.dn;
    out = out.filter((r) => r.subject !== subject && r.subject !== dn);
    if (out.length === before) throw new UsageError(`The group has no admin rule for ${subject}`);
  }
  for (const spec of values['admin-rule'] ?? []) {
    const r = parseAdminRule(spec, list);
    const at = out.findIndex(
      (x) => x.subject === r.subject && x.operation.replace(/^no/, '') === r.operation.replace(/^no/, ''),
    );
    if (at >= 0) out[at] = r;
    else out.push(r);
  }
  return out;
}

const plainRules = (rules) => (rules ?? []).map(({rule, ability, group}) => ({rule, ability, group: group ?? ''}));
const plainAdminRules = (rules) => (rules ?? []).map(({subject, operation}) => ({subject, operation}));

// "gid=…" → the group name, when known.
const nameOf = (list, dn) => (dn === 'all' ? 'all groups' : (list.find((g) => g.dn === dn)?.name ?? dn));

function groupLines(g, list, ctx) {
  const c = paint(ctx);
  const lines = [
    `${c.bold(g.name)} (id ${g.id})${g.inherits?.dn ? ` · inherits ${g.inherits.name ?? nameOf(list, g.inherits.dn)}` : ''}`,
  ];
  const rules = g.rules ?? [];
  lines.push(rules.length ? 'rules:' : c.dim('no rules'));
  lines.push(...table(rules.map((r) => [`  ${r.rule}`, r.ability, r.group ? nameOf(list, r.group) : ''])));
  const admin = g.adminRules ?? [];
  if (admin.length)
    lines.push(
      'admin rules:',
      ...table(admin.map((r) => [`  ${r.operation}`, r.subject === 'all' ? 'all' : nameOf(list, r.subject)])),
    );
  return lines;
}

const ruleOptions = {
  rule: {
    type: 'string',
    multiple: true,
    placeholder: '"KEY ABILITY [GROUP]"',
    description: 'a rule, e.g. "CALL yes all" or "SEE_ANALYTICS yes Sales" (wx-admin acl rules)',
  },
};

export const groups = {
  acl: {
    summary: 'ACL groups: what the users of a group may do; list, get, create, update, delete, permissions',
    commands: {
      list: {
        summary: 'the ACL groups of the PBX',
        usage: 'wx-admin acl list',
        options: {},
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/AclGroups/', undefined, SCOPE);
        },
        text: (r) => {
          const list = r?.records ?? [];
          if (!list.length) return 'No ACL groups';
          return table(
            list.map((g) => [
              g.id,
              g.name,
              `${(g.rules ?? []).length} rules`,
              `${(g.adminRules ?? []).length} admin rules`,
              g.inherits?.dn ? `inherits ${nameOf(list, g.inherits.dn)}` : '',
            ]),
          );
        },
      },
      get: {
        summary: 'one ACL group with its rules and admin rules',
        usage: 'wx-admin acl get <group>',
        details: 'A group is its id, its name or its DN.',
        options: {},
        args: [1, 1],
        async run(ctx) {
          const list = await listGroups(await pbxClient(ctx));
          return {...findGroup(list, ctx.positionals[0]), groups: list.map(({id, dn, name}) => ({id, dn, name}))};
        },
        text: (g, ctx) => groupLines(g, g.groups ?? [], ctx),
      },
      create: {
        summary: 'create an ACL group, empty, with --rule, or from a JSON file ({name?, inherits?, rules?})',
        usage: 'wx-admin acl create <name> [--rule "KEY ABILITY [GROUP]"]... [--inherits GROUP] [--from FILE|-]',
        details: 'Only the PBX user "admin" (or a Company API Key acting as admin) may create groups.',
        options: {
          ...ruleOptions,
          inherits: {type: 'string', placeholder: 'GROUP', description: 'the parent group (id, name or DN)'},
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'the group as JSON, as acl get --output json gives it (a file, or - for stdin)',
          },
        },
        args: [1, 1],
        async run(ctx) {
          const name = ctx.positionals[0];
          if (!NAME.test(name))
            throw new UsageError(`An ACL group name is 1 to 64 characters without / \\ or ,: ${name}`);
          const src = ctx.values.from ? await readJsonInput(ctx, ctx.values.from) : {};
          const client = await pbxClient(ctx);
          const list = await listGroups(client);
          if (list.some((g) => g.name === name)) throw new UsageError(`An ACL group ${name} exists already`);
          const body = {name};
          if (src.wcgrp !== undefined && src.wcgrp !== null && src.wcgrp !== '') body.wcgrp = String(src.wcgrp);
          const parent = ctx.values.inherits ?? src.inherits?.dn;
          if (parent) body.inherits = {dn: targetDn(list, parent)};
          const rules = changedRules(plainRules(src.rules), ctx.values, list);
          if (rules.length) body.rules = rules;
          return client.call('POST', '/PBX/AclGroups/', body, SCOPE);
        },
        text: (g) => `Created the ACL group ${g.name} (id ${g.id})`,
      },
      update: {
        summary: 'change an ACL group: name, parent, rules (added, replaced or removed) or admin rules',
        usage:
          'wx-admin acl update <group> [--name NAME] [--inherits GROUP | --no-inherits] [--rule "KEY ABILITY [GROUP]"]... [--remove-rule "KEY [GROUP]"]... [--admin-rule "SUBJECT OPERATION"]... [--remove-admin-rule SUBJECT]... [--from FILE|-] [--yes]',
        details: [
          'A --rule replaces the rule with the same key and group, or is added. --from replaces all rules (and admin rules)',
          'with those of the file. Admins other than the user "admin" may change only the rules.',
        ].join('\n'),
        options: {
          name: {type: 'string', placeholder: 'NAME', description: 'the new name'},
          inherits: {type: 'string', placeholder: 'GROUP', description: 'the new parent group (id, name or DN)'},
          'no-inherits': {type: 'boolean', description: 'no parent group'},
          ...ruleOptions,
          'remove-rule': {
            type: 'string',
            multiple: true,
            placeholder: '"KEY [GROUP]"',
            description: 'remove a rule (for every target group when no GROUP is given)',
          },
          'admin-rule': {
            type: 'string',
            multiple: true,
            placeholder: '"SUBJECT OPERATION"',
            description: 'an admin rule, e.g. "users__users epage" (wx-admin acl rules --admin)',
          },
          'remove-admin-rule': {
            type: 'string',
            multiple: true,
            placeholder: 'SUBJECT',
            description: 'remove the admin rules of a subject',
          },
          from: {
            type: 'string',
            placeholder: 'FILE',
            description: 'rules and/or adminRules as JSON (a file, or - for stdin)',
          },
          yes: {type: 'boolean', description: 'yes, change the rights (rules, admin rules, --from)'},
        },
        args: [1, 1],
        async run(ctx) {
          const v = ctx.values;
          const ruleChange = v.rule?.length || v['remove-rule']?.length;
          const adminChange = v['admin-rule']?.length || v['remove-admin-rule']?.length;
          if ((ruleChange || adminChange || v.from) && !v.yes)
            throw new UsageError('This changes what every user of the group may do: confirm with --yes', ctx.usage());
          if (
            v.name === undefined &&
            v.inherits === undefined &&
            !v['no-inherits'] &&
            !ruleChange &&
            !adminChange &&
            !v.from
          )
            throw new UsageError('Nothing to change', ctx.usage());
          if (v.inherits !== undefined && v['no-inherits'])
            throw new UsageError('Give --inherits or --no-inherits, not both');
          if (v.name !== undefined && !NAME.test(v.name))
            throw new UsageError(`An ACL group name is 1 to 64 characters without / \\ or ,: ${v.name}`);
          const src = v.from ? await readJsonInput(ctx, v.from) : {};
          const client = await pbxClient(ctx);
          const list = await listGroups(client);
          const g = findGroup(list, ctx.positionals[0]);
          const body = {};
          if (v.name !== undefined) body.name = v.name;
          if (v.inherits !== undefined) body.inherits = {dn: targetDn(list, v.inherits)};
          if (v['no-inherits']) body.inherits = '';
          if (ruleChange || src.rules) body.rules = changedRules(plainRules(src.rules ?? g.rules), v, list);
          if (adminChange || src.adminRules)
            body.adminRules = changedAdminRules(plainAdminRules(src.adminRules ?? g.adminRules), v, list);
          await client.call('PUT', groupPath(g.id), body, SCOPE);
          const now = await listGroups(client);
          return {...findGroup(now, g.id), groups: now.map(({id, dn, name}) => ({id, dn, name}))};
        },
        text: (g, ctx) => ['Updated:', ...groupLines(g, g.groups ?? [], ctx)],
      },
      delete: {
        summary: 'delete ACL groups (needs --yes: their users lose the rights of the group)',
        usage: 'wx-admin acl delete <group>... --yes',
        options: {yes: {type: 'boolean', description: 'yes, delete them'}},
        args: [1, 50],
        async run(ctx) {
          if (!ctx.values.yes)
            throw new UsageError(
              'Deleting an ACL group changes what its users may do: confirm with --yes',
              ctx.usage(),
            );
          const client = await pbxClient(ctx);
          const list = await listGroups(client);
          const found = ctx.positionals.map((ref) => findGroup(list, ref));
          await client.call('DELETE', groupPath(...found.map((g) => g.id)), undefined, SCOPE);
          return {deleted: found.map(({id, name}) => ({id, name}))};
        },
        text: (r) =>
          `Deleted the ACL ${r.deleted.length === 1 ? 'group' : 'groups'} ${r.deleted.map((g) => `${g.name} (${g.id})`).join(', ')}`,
      },
      permissions: {
        summary: 'each permission and the groups that have it (filter by --permission and --group)',
        usage: 'wx-admin acl permissions [--permission KEY]... [--group GROUP]...',
        details:
          'A permission about other groups (such as CALL) shows, for each group, the groups its users may do it to.',
        options: {
          permission: {
            type: 'string',
            multiple: true,
            placeholder: 'KEY',
            description: 'only this permission, e.g. SEE_CALL_RECORDINGS',
          },
          group: {type: 'string', multiple: true, placeholder: 'GROUP', description: 'only this group (id or name)'},
        },
        args: [0, 0],
        async run(ctx) {
          const client = await pbxClient(ctx);
          const q = new URLSearchParams();
          for (const p of ctx.values.permission ?? []) {
            if (!RULE_KEY.test(p)) throw new UsageError(`Not a permission key: ${p}`);
            q.append('permissions[]', p);
          }
          if (ctx.values.group?.length) {
            const list = await listGroups(client);
            for (const ref of ctx.values.group) q.append('groups[]', findGroup(list, ref).id);
          }
          return client.call('GET', `/PBX/AclGroups/Permissions/${q.size ? `?${q}` : ''}`, undefined, SCOPE);
        },
        text: (list, ctx) => {
          const c = paint(ctx);
          if (!list?.length) return 'No permissions';
          const who = (p) =>
            (p.groups ?? [])
              .map((g) => {
                if (!p.containSubGroups) return g.access ? g.groupName : c.dim(`-${g.groupName}`);
                const to = (g.subGroups ?? []).filter((s) => s.access).map((s) => s.groupName);
                return `${g.groupName}→${to.length === (g.subGroups ?? []).length ? 'all' : to.length ? to.join('+') : 'none'}`;
              })
              .join(' ');
          return table(list.map((p) => [p.key, p.name ?? '', who(p)]));
        },
      },
      rules: {
        summary: 'the rules an ACL group can have: keys, abilities, whether they are about other groups',
        usage: 'wx-admin acl rules [--admin]',
        options: {
          admin: {type: 'boolean', description: 'the admin rules (what an admin of the group may manage in WMS)'},
        },
        args: [0, 0],
        async run(ctx) {
          return (await pbxClient(ctx)).call('GET', '/PBX/AclGroups/Rules/', undefined, SCOPE);
        },
        text: (r, ctx) => {
          if (ctx.values.admin)
            return table(
              (r.adminList ?? []).flatMap((x) => (x.access ?? []).map((a) => [a.subject, x.ability.join('/'), a.name])),
            );
          return table(
            (r.list ?? []).flatMap((x) =>
              (x.access ?? []).map((a) => [a.key, x.ability.join('/'), a.group ? 'to groups' : '', a.name]),
            ),
          );
        },
      },
    },
  },
};
