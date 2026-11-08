// The portable hooks of the PBX kinds: each turns the values of one object that point outside it (another object, the
// PBX itself, a secret, something outside the PBX) into markers through the helper `h` that toPortable gives it (see
// refs.mjs). A hook mutates `data`, a copy of the object read. This module imports nothing of the transfer engine but
// the leaf keys.mjs, so kinds.mjs can attach the hooks without a cycle.
import {isMarker} from './keys.mjs';

// The parameters of dialplan applications that point at objects, found live on WMS 7.11 (an empty rule per
// application: the PBX names what it requires). `by` is the form the PBX uses first.
const ID = 'id';
const NAME = 'name';
export const APP_REFS = {
  Queue: {queueId: ['queues', ID], mohClass: ['moh']},
  Timetable: {timetableId: ['timetables', ID], dialplan: ['dialplans', NAME]},
  IVR: {ivrName: ['ivr', NAME]},
  GotoIfSwitchIsOn: {switchId: ['switches', ID], dialplan: ['dialplans', NAME]},
  GotoIf3SwitchIsOnOrBlinking: {
    switchId: ['switches', ID],
    dialplanOn: ['dialplans', NAME],
    dialplanBlinking: ['dialplans', NAME],
  },
  FeaturePaging: {groupId: ['paging', ID]},
  DialTrunk: {trunk: ['trunks-sip', NAME]},
  DialHuntGroup: {huntGroup: ['trunk-groups', NAME]},
  GotoIfUserStatus: {user: ['users', NAME, 'soft'], dialplan: ['dialplans', NAME]},
  Goto: {dialplan: ['dialplans', NAME]},
  GotoIf: {dialplan: ['dialplans', NAME]},
  GotoIfBusyCongested: {dialplan: ['dialplans', NAME]},
  VerifyCaller: {dialplan: ['dialplans', NAME]},
  CorrectOutgoingNumber: {dialplan: ['dialplans', NAME]},
  GotoIfGroupCount: {dialplan: ['dialplans', NAME]},
  DialRemotePbx: {dialplan: ['dialplans', NAME]},
  LookUpCidNameInPhonebook: {phonebookId: ['phonebooks']},
  LookUpDestCidNameInPhonebook: {phonebookId: ['phonebooks']},
  Playback: {filename: ['sounds']},
};
export const EXTERNAL = {VoiceBot: {botId: 'voicebot'}, DialRemotePbx: {pbx: 'remote-pbx'}};

// Secret fields of a trunk ("key" alone is not one: it names a codec).
const SECRET_KEY = /secret|password|passwd|^register$|apikey|token/i;
const PBXID = /^pbxid=([^,]+),dc=wildix$/i;

const pathOf = (base, k) => (base ? `${base}.${k}` : k);

// Every non-empty secret of a trunk becomes {$secret: <its path>}.
function hideSecrets(h, o, base) {
  for (const [k, v] of Object.entries(o)) {
    const path = Array.isArray(o) ? `${base}[${k}]` : pathOf(base, k);
    if (SECRET_KEY.test(k) && typeof v === 'string' && v !== '') h.secret(o, k, path);
    else if (v && typeof v === 'object' && (Array.isArray(v) || !isMarker(v))) hideSecrets(h, v, path);
  }
}

export const PBX_PORTABLE = {
  dialplans(data, h) {
    data.includedDialplans = (data.includedDialplans ?? []).map((x, i) => ({
      ...x,
      dialplanId: h.ref(x.dialplanId, 'dialplans', `includedDialplans[${i}].dialplanId`, [ID, NAME]),
    }));
    for (const [n, num] of (data.numbers ?? []).entries()) {
      for (const [a, application] of (num.apps ?? []).entries()) {
        const params = application.params;
        if (!params || Array.isArray(params)) continue;
        const base = `numbers[${n}].apps[${a}].params`;
        for (const [p, [target, by, how]] of Object.entries(APP_REFS[application.name] ?? {})) {
          if (!(p in params)) continue;
          params[p] = h.ref(params[p], target, pathOf(base, p), by === ID ? [ID, NAME] : [NAME, ID, 'login'], how);
        }
        for (const [p, what] of Object.entries(EXTERNAL[application.name] ?? {}))
          if (p in params) params[p] = h.external(pathOf(base, p), what, params[p]);
      }
    }
  },
  'acl-groups'(data, h) {
    if (data.inherits?.dn)
      data.inherits = {...data.inherits, dn: h.ref(data.inherits.dn, 'acl-groups', 'inherits.dn', ['dn'])};
    data.rules = (data.rules ?? []).map((r, i) => ({
      ...r,
      group: h.ref(r.group, 'acl-groups', `rules[${i}].group`, ['dn']),
    }));
    // An admin rule about this PBX is about the target; one about another PBX (or when the serial is not known)
    // stays as it is and is reported: giving a group admin rights on the target it did not have is not a guess.
    data.adminRules = (data.adminRules ?? []).map((r, i) => {
      const m = PBXID.exec(String(r.subject ?? ''));
      if (!m) return r;
      if (h.serial && m[1].toLowerCase() === String(h.serial).toLowerCase()) return {...r, subject: h.self()};
      h.unresolved(`adminRules[${i}].subject`, r.subject);
      return r;
    });
  },
  users(data, h) {
    if ('groupDn' in data) data.groupDn = h.ref(data.groupDn, 'acl-groups', 'groupDn', ['dn']);
    for (const f of ['dialplan', 'faxDialplan']) if (f in data) data[f] = h.ref(data[f], 'dialplans', f, [NAME]);
  },
  queues(data, h) {
    if (data.settings && 'aclGroup' in data.settings)
      data.settings.aclGroup = h.ref(data.settings.aclGroup, 'acl-groups', 'settings.aclGroup', ['dn', ID, NAME]);
    for (const m of data.members ?? []) h.soft(`users/${String(m).split(/[@,]/)[0]}`);
  },
  'trunk-groups'(data, h) {
    data.rules = (data.rules ?? []).map((r, i) => ({
      ...r,
      trunkName: h.ref(r.trunkName, 'trunks-sip', `rules[${i}].trunkName`, [NAME, 'login', ID]),
    }));
  },
  'trunks-sip'(data, h) {
    if (data.settingsPbx && 'context' in data.settingsPbx)
      data.settingsPbx.context = h.ref(data.settingsPbx.context, 'dialplans', 'settingsPbx.context', [NAME]);
    hideSecrets(h, data, '');
  },
};
