// The Wildix cloud services wx-admin reaches with the CPA token of a PBX, and their addresses per environment (the
// `servers` of their OpenAPI, 2026-11-07, corrected where the service does not exist: the knowledge base has no
// stable, although its spec names one).
import {UsageError} from 'wldx-core/errors';

export const ENVIRONMENTS = ['prod', 'stable', 'stage'];

export const SERVICES = {
  kb: {
    label: 'the knowledge base',
    bases: {prod: 'https://kb.wim.wildix.com', stage: 'https://kb.wim-stage.wildix.com'},
  },
  voicebots: {
    label: 'voicebots',
    bases: {
      prod: 'https://wim.wildix.com',
      stable: 'https://wim-stable.wildix.com',
      stage: 'https://wim-stage.wildix.com',
    },
  },
  tools: {
    label: 'WIM tools',
    bases: {
      prod: 'https://tools.wim.wildix.com',
      stable: 'https://tools.wim-stable.wildix.com',
      stage: 'https://tools.wim-stage.wildix.com',
    },
  },
  // The WIM console API (/console/integrations), the integrations hub and the traces: no OpenAPI, so not one of the
  // services of `wx-admin cloud`; `wx-admin integration` calls it.
  integrations: {
    label: 'WIM integrations',
    spec: false,
    bases: {
      prod: 'https://wim.wildix.com',
      stable: 'https://wim-stable.wildix.com',
      stage: 'https://wim-stage.wildix.com',
    },
  },
  wilma: {
    label: 'Wilma',
    bases: {
      prod: 'https://api.wilma.wildix.com',
      stable: 'https://api-stable.wilma.wildix.com',
      stage: 'https://api-stage.wilma.wildix.com',
    },
  },
};

// The environment of the PBX, from the address of its WIM console (the `portal` of the CPA route).
export function envOf(portal) {
  const host = (() => {
    try {
      return new URL(String(portal)).hostname;
    } catch {
      return '';
    }
  })();
  if (host.includes('-stage.')) return 'stage';
  if (host.includes('-stable.')) return 'stable';
  return 'prod';
}

// The services `wx-admin cloud` offers: those with an OpenAPI in specs/.
export const SPEC_SERVICES = Object.fromEntries(Object.entries(SERVICES).filter(([, s]) => s.spec !== false));

export function baseOf(service, env) {
  if (!Object.hasOwn(SERVICES, service))
    throw new UsageError(`Unknown cloud service: ${service}. Known: ${Object.keys(SERVICES).join(', ')}`);
  const s = SERVICES[service];
  if (!Object.hasOwn(s.bases, env))
    throw new UsageError(`${s.label} has no ${env} environment: ${Object.keys(s.bases).join(' or ')}`);
  return s.bases[env];
}
