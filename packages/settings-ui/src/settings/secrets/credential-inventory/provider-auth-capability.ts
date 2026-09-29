import type { ProviderAuthBridge } from '@brainstrike/assistant-contract/provider-auth';

/**
 * The bridge shape is defined ONCE in
 * `@brainstrike/assistant-contract/provider-auth`; this re-export keeps the
 * settings-ui import surface stable.
 */
export type { ProviderAuthBridge } from '@brainstrike/assistant-contract/provider-auth';

/**
 * Reads the optional desktop provider-OAuth bridge by capability, without
 * platform detection. Web has no preload, so this resolves `undefined` and the
 * subscription row offers no connect affordance at all — never stubbed, never
 * `isElectron()`. Every method is probed: a partial preload is not a bridge.
 */
export function getProviderAuthCapability(): ProviderAuthBridge | undefined {
  const bridge = (window as unknown as { providerAuth?: Partial<ProviderAuthBridge> }).providerAuth;
  const complete =
    typeof bridge?.cancel === 'function' &&
    typeof bridge?.disconnect === 'function' &&
    typeof bridge?.start === 'function' &&
    typeof bridge?.status === 'function';
  return complete ? (bridge as ProviderAuthBridge) : undefined;
}
