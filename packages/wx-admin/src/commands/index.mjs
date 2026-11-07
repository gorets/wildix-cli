// The commands of wx-admin. GROUPS: `wx-admin <group> <command>`; COMMANDS: single commands, `wx-admin <command>`.
// What a group and a command are: wldx-core/registry. login, logout, status and profile come from the core, shared
// with wx. PBX commands do not set `auth`: they choose their access themselves (src/pbx.mjs). `complete: 'pbxs'`
// offers the PBX with saved access. `readOnly: true` on a command that only reads lets it run with --all-pbx
// (READ_ONLY below sets it).
import {commands as api} from './api.mjs';
import {groups as acl} from './acl.mjs';
import {groups as config} from './config.mjs';
import {groups as device} from './device.mjs';
import {groups as dialplan} from './dialplan.mjs';
import {login, logout} from 'wldx-core/commands/login';
import {groups as pbx} from './pbx.mjs';
import {groups as phonebook} from './phonebook.mjs';
import {groups as profile} from 'wldx-core/commands/profile';
import {groups as queue} from './queue.mjs';
import {groups as records} from './records.mjs';
import {dialplanCommands, groups as routing} from './routing.mjs';
import {groups as sound} from './sound.mjs';
import status from 'wldx-core/commands/status';
import {groups as system} from './system.mjs';
import {groups as trunk} from './trunk.mjs';
import {groups as user} from './user.mjs';

// In the order of the help: the PBX and its people, routing, trunks and devices, content and records, access.
export const GROUPS = {
  ...system,
  ...user,
  ...acl,
  ...queue,
  dialplan: {
    ...dialplan.dialplan,
    summary: 'dialplans (procedures) and their rules, and the general dialplan settings',
    commands: {...dialplan.dialplan.commands, ...dialplanCommands},
  },
  ...routing,
  ...trunk,
  ...device,
  ...phonebook,
  ...sound,
  ...records,
  ...config,
  ...pbx,
  ...profile,
};

export const COMMANDS = {...api, login, logout, status};

// The commands that only read the PBX (no change there, no file written): they may run with --all-pbx.
const READ_ONLY = {
  system: ['info', 'license', 'settings', 'smtp', 'ntp', 'proxy', 'trusted-ip', 'ports', 'upgrade', 'upgrade-settings'],
  user: ['list', 'get', 'presence', 'registrations', 'groups', 'departments'],
  acl: ['groups', 'group', 'permissions', 'rules'],
  queue: ['list', 'get', 'stats'],
  dialplan: ['list', 'get', 'rules', 'apps', 'settings'],
  timetable: ['list', 'get'],
  ivr: ['list', 'get'],
  switch: ['list', 'get'],
  paging: ['list', 'get'],
  db: ['list', 'get'],
  trunk: ['list', 'get', 'groups', 'prices'],
  device: ['list'],
  phonebook: ['list', 'get', 'contacts', 'contact'],
  sound: ['list'],
  records: ['history', 'history-user', 'call', 'recordings', 'voicemails'],
  pbx: ['check'],
};
for (const [group, names] of Object.entries(READ_ONLY)) {
  for (const name of names) {
    const cmd = GROUPS[group]?.commands[name];
    if (!cmd) throw new Error(`READ_ONLY names a command that does not exist: ${group} ${name}`);
    cmd.readOnly = true;
  }
}

// Its global options, taken anywhere like those of the core (--profile, --output, --pretty, --no-color).
export const GLOBAL_OPTIONS = {
  pbx: {
    type: 'string',
    placeholder: 'PBX',
    needs: 'a PBX host',
    description: 'the PBX to work on: name.wildixin.com, name, an IP, or the serial of a known PBX',
    complete: 'pbxs',
  },
  'all-pbx': {type: 'boolean', description: 'run a command that reads on every PBX'},
};
