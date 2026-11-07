// Choosing an object by its name: the exact name first, else the name without case; more than one match at either
// step is an error that asks for the id (picking one silently could send a change to the wrong object).
import {UsageError} from 'wldx-core/errors';

export function pickByName(list, ref, nameOf, noun, hint) {
  const want = String(ref);
  const exact = list.filter((r) => String(nameOf(r) ?? '') === want);
  const pool = exact.length ? exact : list.filter((r) => String(nameOf(r) ?? '').toLowerCase() === want.toLowerCase());
  if (pool.length > 1)
    throw new UsageError(
      `Several ${noun}s are named ${ref} (ids ${pool.map((r) => r.id).join(', ')}): give the id${hint ? ` (${hint})` : ''}`,
    );
  if (!pool.length) throw new UsageError(`No ${noun} named ${ref}${hint ? ` (${hint})` : ''}`);
  return pool[0];
}
