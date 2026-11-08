// The cloud kinds of the config transfer, in the order they are written (what others point at first), the lookup
// kinds after them. Modules of this folder never import refs.mjs or kinds.mjs (kinds.mjs imports them).
import {INTEGRATION_KINDS} from './integrations.mjs';
import {KB_KINDS} from './kb.mjs';
import {KITE_KINDS} from './kite.mjs';
import {LOOKUP_KINDS} from './lookups.mjs';
import {WILMA_KINDS, WILMA_SECRET_KINDS} from './wilma.mjs';
import {WILMA_AGENT_KINDS} from './wilma-agents.mjs';

export const CLOUD_KINDS = {
  ...WILMA_SECRET_KINDS,
  ...KB_KINDS,
  ...WILMA_KINDS,
  ...WILMA_AGENT_KINDS,
  ...INTEGRATION_KINDS,
  ...KITE_KINDS,
  ...LOOKUP_KINDS,
};
