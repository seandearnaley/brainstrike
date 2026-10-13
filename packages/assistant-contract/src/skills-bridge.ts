import { type BoundaryTransport, callBoundary } from './boundary-result.js';
/**
 * Structural typing + capability resolution for the desktop `window.skills`
 * Agent Skills discovery bridge (Settings → Skills panel + the composer's "/"
 * menu).
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): a consumer is
 * desktop-only because it is constructed only when `resolveSkillsBridge()`
 * returns a fully-formed bridge. Web never sees it — there is no
 * `isElectron()` check anywhere.
 *
 * Lives in assistant-contract (not app-shell) because BOTH app-shell (composer
 * "/" menu) and settings-ui (Settings → Skills) consume it, and settings-ui
 * cannot import app-shell (app-shell depends on settings-ui — a package
 * cycle). Deliberately dependency-light (logging + the sibling skills wire
 * shapes only) so the desktop preload contract test can import the
 * required-method pin without pulling UI graphs.
 */

import { createLogger } from '@brainstrike/logging';
import type { SkillsScanResultSummary } from './skills.js';

const logger = createLogger('SkillsBridge');

export interface SkillsBridge {
  scan: () => Promise<SkillsScanResultSummary>;
}

// Compile-time exact-set proof: `satisfies Record<keyof SkillsBridge, true>`
// fails the build if any interface method is missing here, and excess keys are
// rejected — so the pin can never silently become a subset (or superset) of
// the interface. The runtime pin only checks preload ↔ constant; this closes
// interface ↔ constant.
const SKILLS_BRIDGE_REQUIRED_METHOD_SET = {
  scan: true,
} as const satisfies Record<keyof SkillsBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.skills` `exposeInMainWorld` key set to this exact list.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 */
export const SKILLS_BRIDGE_REQUIRED_METHODS = Object.keys(
  SKILLS_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof SkillsBridge)[];

/**
 * Resolve the `window.skills` bridge, or `null` when it is absent (web) or
 * malformed (a present-but-broken bridge logs an error and stays absent — no
 * silent degradation).
 */
export function resolveSkillsBridge(): SkillsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { skills?: Partial<BoundaryTransport<SkillsBridge>> }).skills;
  if (!bridge) {
    return null;
  }
  const missing = SKILLS_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.skills bridge is malformed; skills surfaces disabled', { missing });
    return null;
  }
  const transport = bridge as BoundaryTransport<SkillsBridge>;
  return { scan: () => callBoundary(() => transport.scan()) };
}
