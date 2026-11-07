// wx user: people of the corporate directory on the stream service (the agent skill's users.sh and search.sh
// users): who you are, a colleague by name (any script, typos, as it sounds), e-mail or phone.
import {jwtClaims} from 'wldx-core/auth';
import {UsageError} from 'wldx-core/errors';
import {paint, table} from 'wldx-core/format';
import {query} from 'wldx-core/http';
import {nextPage, userLine} from '../chat/format.mjs';
import {api, checkId, checkInt, displayName} from '../chat/lib.mjs';

const me = {
  summary: 'the logged-in user: id, name, e-mail, extension',
  usage: 'wx user me',
  options: {},
  args: [0, 0],
  async run(ctx) {
    const email = jwtClaims(ctx.token).email;
    if (!email) throw new Error('The login token carries no e-mail');
    const r = await api(ctx).call('POST', '/users/query', {query: {emails: [email]}});
    return r?.users?.[0] ?? null;
  },
  text(u, ctx) {
    if (!u) return 'Not found in the chat directory.';
    const rows = [
      ['Name', paint(ctx).bold(displayName(u) ?? '')],
      ['Id', u.id],
      ['E-mail', u.email ?? ''],
    ];
    if (u.pbxExtension) rows.push(['Extension', u.pbxExtension]);
    if (u.timeZone) rows.push(['Time zone', u.timeZone]);
    if (u.locale) rows.push(['Locale', u.locale]);
    return table(rows);
  },
};

const brief = (r) => ({
  margin: r?.margin,
  nextCursor: r?.nextCursor,
  results: (r?.results ?? []).map((x) => ({
    id: x.user?.id,
    name: x.user?.displayName,
    email: x.user?.email,
    extension: x.user?.pbxExtension,
    bot: x.user?.bot,
    confidence: x.confidence,
    matchedOn: x.matchedOn,
  })),
});

const find = {
  summary: 'find a colleague by name (any script, typos, as it sounds), e-mail or phone',
  usage:
    'wx user find <query> [--mode auto|name|email|phone] [--kind human|bot|all] [--with-extension] [--min-confidence 0..1] [--brief] [--size 1-50] [--cursor C]',
  details: [
    'An e-mail or a phone number (with its country code, +…) is looked up exactly (confidence 1). confidence (0..1)',
    'is how much the query looks like the name, not the probability that it is the right person (default cut 0.5;',
    '--min-confidence 0 shows every candidate). margin is the confidence of the first hit minus the second: near 0,',
    'the answer is ambiguous: ask which one, never guess. --brief keeps id, name, email, extension, bot, confidence,',
    'matchedOn (JSON).',
  ].join('\n'),
  options: {
    mode: {
      type: 'string',
      choices: ['auto', 'name', 'email', 'phone'],
      description: 'what the query is (auto by default)',
    },
    kind: {type: 'string', choices: ['human', 'bot', 'all'], description: 'people (default), bots or both'},
    'with-extension': {type: 'boolean', description: 'only people with a PBX extension'},
    'min-confidence': {
      type: 'string',
      placeholder: '0..1',
      description: 'drop hits below this confidence (default 0.5)',
    },
    brief: {type: 'boolean', description: 'only the fields needed to pick a person'},
    size: {type: 'string', placeholder: '1-50', description: 'results per page (default 20)'},
    cursor: {type: 'string', description: 'the next page (nextCursor of the previous one)'},
  },
  args: [1, 1],
  async run(ctx) {
    const {values} = ctx;
    const minc = values['min-confidence'];
    if (minc !== undefined && !/^(0|1|0?\.[0-9]+|1\.0+)$/.test(minc))
      throw new UsageError(`--min-confidence is a number from 0 to 1: ${minc}`);
    const q = query({
      q: ctx.positionals[0],
      mode: values.mode,
      kind: values.kind,
      withExtensionOnly: values['with-extension'] && 'true',
      minConfidence: minc,
      size: checkInt('size', values.size, 1, 50),
      cursor: values.cursor,
    });
    const r = await api(ctx).call('GET', `/search/users${q}`);
    return values.brief ? brief(r) : r;
  },
  text(r, ctx) {
    const c = paint(ctx);
    const hits = r?.results ?? [];
    if (!hits.length) return 'Nobody found.';
    const rows = hits.map((x) => {
      const u = x.user ?? {id: x.id, displayName: x.name, email: x.email, pbxExtension: x.extension, bot: x.bot};
      return [...userLine(u, c), `${Number(x.confidence ?? 0).toFixed(2)} ${x.matchedOn ?? ''}`.trim()];
    });
    const lines = table(rows);
    if (hits.length > 1 && typeof r.margin === 'number')
      lines.push(
        r.margin < 0.1
          ? c.yellow(`Ambiguous (margin ${r.margin.toFixed(2)}): several people fit, ask which one`)
          : c.dim(`margin ${r.margin.toFixed(2)}`),
      );
    return [...lines, ...nextPage(r.nextCursor, c)];
  },
};

const EMAIL = /@/;
const PHONE = /^\+?[0-9]{4,17}$/;

const get = {
  summary: 'people by user id, e-mail or phone (exact lookup)',
  usage: 'wx user get [<id|email|phone>...] [--id USERID]... [--email EMAIL]... [--phone PHONE]...',
  details:
    'A value given without an option is an e-mail when it has "@", a phone when it is digits (+ allowed), else a user id. For a search by name: wx user find.',
  options: {
    id: {type: 'string', multiple: true, placeholder: 'USERID', description: 'a user id'},
    email: {type: 'string', multiple: true, placeholder: 'EMAIL', description: 'an e-mail address'},
    phone: {type: 'string', multiple: true, placeholder: 'PHONE', description: 'a phone number'},
  },
  args: [0, 100],
  async run(ctx) {
    const {values} = ctx;
    const ids = [...(values.id ?? [])];
    const emails = [...(values.email ?? [])];
    const phones = [...(values.phone ?? [])];
    for (const v of ctx.positionals) {
      if (EMAIL.test(v)) emails.push(v);
      else if (PHONE.test(v.replace(/[\s()-]/g, ''))) phones.push(v.replace(/[\s()-]/g, ''));
      else ids.push(v);
    }
    const q = {};
    if (ids.length) q.ids = ids.map((id) => checkId('The user id', id));
    if (emails.length) q.emails = emails;
    if (phones.length) q.phones = phones;
    if (!Object.keys(q).length)
      throw new UsageError('Give a user id, an e-mail or a phone (or --id, --email, --phone)', ctx.usage());
    return api(ctx).call('POST', '/users/query', {query: q});
  },
  text(r, ctx) {
    const c = paint(ctx);
    const list = r?.users ?? [];
    return list.length ? table(list.map((u) => userLine(u, c))) : 'Nobody found.';
  },
};

const user = {
  summary: 'people: you, a colleague by name, e-mail or phone',
  auth: true,
  commands: {me, find, get},
};

export const groups = {user};
