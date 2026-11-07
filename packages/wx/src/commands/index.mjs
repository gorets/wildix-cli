// The commands of wx. GROUPS: `wx <group> <command>`; COMMANDS: single commands, `wx <command>`. What a group and
// a command are: wldx-core/registry. login, logout, status and profile come from the core, shared with wx-admin.
import {groups as calls} from './calls.mjs';
import {groups as channel} from './channel.mjs';
import {groups as chat} from './chat.mjs';
import {groups as conversations} from './conversations.mjs';
import {groups as file} from './file.mjs';
import {groups as inbox} from './inbox.mjs';
import {groups as live} from './live.mjs';
import {login, logout} from 'wldx-core/commands/login';
import {groups as meetings} from './meetings.mjs';
import {groups as phone} from './phone.mjs';
import {groups as profile} from 'wldx-core/commands/profile';
import {groups as reports} from './reports.mjs';
import {groups as section} from './section.mjs';
import status from 'wldx-core/commands/status';
import {groups as user} from './user.mjs';

// In the order of the help: chats, then calls and meetings on record, then now, then the phone.
export const GROUPS = {
  ...chat,
  ...channel,
  ...inbox,
  ...file,
  ...user,
  ...section,
  ...calls,
  ...meetings,
  ...conversations,
  ...reports,
  ...live,
  ...phone,
  ...profile,
};

export const COMMANDS = {login, logout, status};
