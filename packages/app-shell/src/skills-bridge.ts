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
 * Deliberately dependency-light (logging + contract types only) so the desktop
 * preload contract test can import the required-method pin without pulling UI
 * graphs.
 */

import type { SkillsScanResultSummary } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('SkillsBridge');

export interface SkillsBridge {
  scan: () => Promise<SkillsScanResultSummary>;
}

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
export const SKILLS_BRIDGE_REQUIRED_METHODS: readonly (keyof SkillsBridge)[] = ['scan'];

/**
 * Resolve the `window.skills` bridge, or `null` when it is absent (web) or
 * malformed (a present-but-broken bridge logs an error and stays absent — no
 * silent degradation).
 */
export function resolveSkillsBridge(): SkillsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = window.skills;
  if (!bridge) {
    return null;
  }
  const missing = SKILLS_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.skills bridge is malformed; skill slash commands disabled', { missing });
    return null;
  }
  return bridge as SkillsBridge;
}
