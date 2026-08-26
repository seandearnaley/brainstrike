/**
 * Structural typing + capability resolution for the desktop `window.forge`
 * bridge (BST-1391).
 *
 * Capability gating, never `isElectron()`: web has no preload, so
 * `window.forge` is simply absent and every forge surface is omitted. A
 * PRESENT-but-malformed bridge logs an error and stays absent — no partial
 * surface, no silent degradation.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  ForgeIdentityState,
  ForgePrStatus,
  ForgePrUpdatedEvent,
  ForgeRendererRefreshReason,
  ForgeResult,
} from '@brainstrike/types';

const logger = createLogger('ForgeBridge');

export interface ForgeBridge {
  identity: (rootId: string) => Promise<ForgeResult<ForgeIdentityState>>;
  /** One-way main→renderer pushes. Returns the unsubscribe function. */
  onPrUpdated: (callback: (event: ForgePrUpdatedEvent) => void) => () => void;
  prStatus: (rootId: string) => Promise<ForgeResult<ForgePrStatus>>;
  refresh: (
    rootId: string,
    params: { readonly reason: ForgeRendererRefreshReason }
  ) => Promise<ForgeResult<ForgePrStatus>>;
}

// Compile-time exact-set proof: a missing key fails the build, an excess key is
// rejected. The runtime pin below only closes preload ↔ constant; this closes
// interface ↔ constant.
const FORGE_BRIDGE_REQUIRED_METHOD_SET = {
  identity: true,
  onPrUpdated: true,
  prStatus: true,
  refresh: true,
} as const satisfies Record<keyof ForgeBridge, true>;

/**
 * Every method the bridge must expose to count as fully formed. Consumed by
 * the desktop preload-runtime contract test, which pins the `window.forge`
 * `exposeInMainWorld` key set to this EXACT list — there is no such thing as
 * an optional bridge method.
 */
export const FORGE_BRIDGE_REQUIRED_METHODS = Object.keys(
  FORGE_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof ForgeBridge)[];

export function resolveForgeBridge(): ForgeBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { forge?: Partial<ForgeBridge> }).forge;
  if (!bridge) {
    return null;
  }
  const missing = FORGE_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.forge bridge is malformed; PR awareness disabled', { missing });
    return null;
  }
  return bridge as ForgeBridge;
}

/** True when a fully-formed desktop `window.forge` bridge is present. */
export function isForgeBridgeAvailable(): boolean {
  return resolveForgeBridge() !== null;
}
