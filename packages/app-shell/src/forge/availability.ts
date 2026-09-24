/**
 * Lightweight capability entry for forge PR awareness.
 *
 * Mirrors `git-panel/availability.ts`: it re-exports ONLY the capability check
 * and the required-method pin from the dependency-light `forge-bridge` module,
 * so the desktop preload contract test can import it without pulling any React
 * or `@brainstrike/ui` code into that test's module graph.
 */

export type { ForgeBridge } from './forge-bridge';
export {
  FORGE_BRIDGE_REQUIRED_METHODS,
  isForgeBridgeAvailable,
  resolveForgeBridge,
} from './forge-bridge';
