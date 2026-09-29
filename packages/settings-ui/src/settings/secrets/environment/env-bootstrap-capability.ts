import type { EnvBootstrapCapability } from '@brainstrike/assistant-contract/env-bootstrap-bridge';

/**
 * The bridge shape is defined ONCE in
 * `@brainstrike/assistant-contract/env-bootstrap-bridge`; this re-export keeps
 * the settings-ui import surface stable.
 */
export type { EnvBootstrapCapability } from '@brainstrike/assistant-contract/env-bootstrap-bridge';

/**
 * Reads the optional desktop bridge by capability, without platform
 * detection. Web has no preload, so this resolves `undefined` and the whole
 * Environment section is omitted — never stubbed, never `isElectron()`.
 */
export function getEnvBootstrapCapability(): EnvBootstrapCapability | undefined {
  const bridge = (window as unknown as { envBootstrap?: Partial<EnvBootstrapCapability> })
    .envBootstrap;
  return typeof bridge?.read === 'function' ? (bridge as EnvBootstrapCapability) : undefined;
}
