import { type BoundaryTransport, callBoundary } from './boundary-result.js';
/**
 * Structural typing + capability resolution for the desktop
 * `window.assistantPersonas` subagent persona discovery bridge (Settings →
 * Subagents). The desktop contract (`apps/desktop/src/ipc-domains/
 * user-personas.contract.ts`) derives its preload bridge from the same
 * shape and pins the two equal at compile time (BST-1648); settings-ui
 * consumes this interface instead of re-declaring it.
 *
 * Capability gating: a consumer is desktop-only because it is constructed
 * only when `resolveAssistantPersonasBridge()` returns a fully-formed bridge.
 * Web never sees it — there is no `isElectron()` check anywhere.
 */

import { createLogger } from '@brainstrike/logging';
import type { AssistantPersonasListResult } from './user-personas.js';

const logger = createLogger('AssistantPersonasBridge');

export interface AssistantPersonasBridge {
  list: () => Promise<AssistantPersonasListResult>;
}

// Compile-time exact-set proof (see skills-bridge.ts for the rationale).
const ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHOD_SET = {
  list: true,
} as const satisfies Record<keyof AssistantPersonasBridge, true>;

/** Every method name the bridge must expose to be considered fully formed (EXACT set). */
export const ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS = Object.keys(
  ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof AssistantPersonasBridge)[];

/**
 * Resolve the `window.assistantPersonas` bridge, or `null` when it is absent
 * (web) or malformed (logged, never silently degraded to a partial surface).
 */
export function resolveAssistantPersonasBridge(): AssistantPersonasBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (
    window as Window & { assistantPersonas?: Partial<BoundaryTransport<AssistantPersonasBridge>> }
  ).assistantPersonas;
  if (!bridge) {
    return null;
  }
  const missing = ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.assistantPersonas bridge is malformed; persona surfaces disabled', {
      missing,
    });
    return null;
  }
  const transport = bridge as BoundaryTransport<AssistantPersonasBridge>;
  return { list: () => callBoundary(() => transport.list()) };
}
