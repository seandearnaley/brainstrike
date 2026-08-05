/**
 * Structural typing + capability resolution for the desktop `window.platform`
 * bridge (OS shell integration: open a URL externally, open a path, reveal a
 * path in the file manager).
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): a consumer is
 * desktop-only because it is constructed only when `resolvePlatformBridge()`
 * returns a fully-formed bridge. Web never sees it — there is no
 * `isElectron()` check anywhere.
 *
 * Deliberately dependency-light (logging only) so the desktop preload contract
 * test can import the required-method pin without pulling UI graphs.
 */

import { createLogger } from '@brainstrike/logging';

const logger = createLogger('PlatformBridge');

export interface PlatformBridge {
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  openPath: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
  showItemInFolder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
}

// Compile-time exact-set proof: `satisfies Record<keyof PlatformBridge, true>`
// fails the build if any interface method is missing here, and excess keys are
// rejected — so the pin can never silently become a subset (or superset) of
// the interface. The runtime pin only checks preload ↔ constant; this closes
// interface ↔ constant.
const PLATFORM_BRIDGE_REQUIRED_METHOD_SET = {
  openExternal: true,
  openPath: true,
  showItemInFolder: true,
} as const satisfies Record<keyof PlatformBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.platform` `exposeInMainWorld` key set to this exact list.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 */
export const PLATFORM_BRIDGE_REQUIRED_METHODS = Object.keys(
  PLATFORM_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof PlatformBridge)[];

/**
 * Resolve the `window.platform` bridge, or `null` when it is absent (web) or
 * malformed (a present-but-broken bridge logs an error and stays absent — no
 * silent degradation).
 */
export function resolvePlatformBridge(): PlatformBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { platform?: Partial<PlatformBridge> }).platform;
  if (!bridge) {
    return null;
  }
  const missing = PLATFORM_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.platform bridge is malformed; shell actions + markdown preview disabled', {
      missing,
    });
    return null;
  }
  return bridge as PlatformBridge;
}
