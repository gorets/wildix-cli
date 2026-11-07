// wx-admin status: the version, the PBX signed in to (* the default one), how and until when. No network unless
// --check, which reads each PBX once (a WMS sign-in first tries Basic once, and moves to it when the PBX takes it).
import {paint, localTime, table} from 'wldx-core/format';
import {program} from 'wldx-core/program';
import {accessLabel, defaultPbx, pbxClient, pbxHostOf, savedPbxs, signInUntil} from '../pbx.mjs';

async function check(ctx, host) {
  try {
    // The saved access of this PBX, never the key of the environment.
    const env = {...ctx.env, WILDIX_PBX_API_KEY: undefined, WILDIX_PBX_HOST: undefined};
    const client = await pbxClient({...ctx, env, pbx: host});
    await client.target.preferBasic?.(); // a WMS sign-in moves to Basic when the PBX takes it (one attempt)
    await client.call('GET', '/Dictionaries');
    return {accepted: true};
  } catch (e) {
    return {accepted: false, error: e.message};
  }
}

const describe = (p, byDefault) => ({
  host: p.host,
  port: p.port ?? 443,
  serial: p.serial ?? null,
  auth: p.auth,
  ...(p.auth === 'password' ? {mode: p.mode, user: p.user} : {}),
  ...(p.auth === 'password' && p.mode === 'token' && !p.refused ? {until: signInUntil(p)} : {}),
  ...(p.refused ? {refused: true} : {}),
  default: p.host === byDefault,
});

export const status = {
  summary: 'the PBX signed in to: which one commands use, how, and until when; the version of wx-admin',
  usage: 'wx-admin status [--check]',
  details:
    'A WMS sign-in lasts while it is used at least every 36 hours, until the PBX restarts, 15 days at most (7 for admin).',
  options: {check: {type: 'boolean', description: 'also read each PBX once: is the access accepted?'}},
  args: [0, 0],
  async run(ctx) {
    const listed = () => {
      const saved = savedPbxs(ctx.env);
      const byDefault = defaultPbx(ctx.env) ?? (saved.length === 1 ? saved[0].host : null);
      return saved.map((p) => describe(p, byDefault));
    };
    let pbxs = listed();
    const out = {
      version: program.version,
      pbxs,
      environmentKey:
        ctx.env.WILDIX_PBX_API_KEY && ctx.env.WILDIX_PBX_HOST ? pbxHostOf(ctx.env.WILDIX_PBX_HOST, ctx) : null,
    };
    if (!ctx.values.check) return out;
    const results = {};
    for (const p of pbxs) results[p.host] = await check(ctx, p.host);
    pbxs = listed().map((p) => ({...p, ...results[p.host]}));
    out.pbxs = pbxs;
    const refused = pbxs.filter((p) => !p.accepted).length;
    if (!refused) return out;
    ctx.emit(out);
    const err = new Error(`${refused} of ${pbxs.length} PBX refused the access`);
    err.exitCode = 1;
    throw err;
  },
  text(r, ctx) {
    const c = paint(ctx);
    const lines = [`${program.name}  ${r.version}`];
    if (!r.pbxs.length) lines.push('Not signed in to any PBX: wx-admin login <host>');
    else {
      const rows = r.pbxs.map((p) => [
        p.default ? '*' : ' ',
        p.host + (p.port !== 443 ? `:${p.port}` : ''),
        p.serial ? `serial ${p.serial}` : '',
        accessLabel(p),
        p.refused ? c.red('password refused: wx-admin login') : p.until ? `until about ${localTime(p.until)}` : '',
        p.accepted === undefined ? '' : p.accepted ? c.green('accepted') : c.red(`refused: ${p.error}`),
      ]);
      lines.push(...table(rows).map((l, i) => `${i ? '          ' : 'PBX       '}${l}`));
      if (r.pbxs.some((p) => p.default)) lines.push('          * the default PBX: commands without --pbx go there');
    }
    if (r.environmentKey) lines.push(`Key       WILDIX_PBX_API_KEY for ${r.environmentKey} (it is used instead)`);
    return lines.join('\n');
  },
};
