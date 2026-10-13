import { type BoundaryTransport, callBoundary } from './boundary-result.js';
/**
 * Structural typing + capability resolution for the desktop
 * `window.contextFiles` workspace-instructions scan bridge (Settings →
 * Workspace Instructions). The desktop contract (`apps/desktop/src/
 * ipc-domains/context-files.contract.ts`) derives its preload bridge from
 * this shape and pins the two equal at compile time (BST-1648); settings-ui
 * and desktop main both import `WorkspaceContextFileStatus` from here.
 */

import { createLogger } from '@brainstrike/logging';

const logger = createLogger('ContextFilesBridge');

/**
 * The Settings UI's per-root view of a detected workspace instructions file.
 * `status`:
 * - `none`     — no `AGENTS.md`/`AGENT.md`/`CLAUDE.md` at the root's top level.
 * - `fits`     — a file at/under the per-file char budget (auto-injected).
 * - `oversized`— a file over the budget (injected ONLY if the root is opted in;
 *                otherwise detected-but-not-injected).
 * - `error`    — the file could not be read (surfaced, never silently hidden).
 */
export interface WorkspaceContextFileStatus {
  approxTokens: number | null;
  displayName: string;
  error?: string;
  fileName: string | null;
  oversized: boolean;
  path: string | null;
  rootId: string;
  sizeBytes: number | null;
  status: 'none' | 'fits' | 'oversized' | 'error';
}

export interface ContextFilesBridge {
  scan: () => Promise<WorkspaceContextFileStatus[]>;
}

// Compile-time exact-set proof (see skills-bridge.ts for the rationale).
const CONTEXT_FILES_BRIDGE_REQUIRED_METHOD_SET = {
  scan: true,
} as const satisfies Record<keyof ContextFilesBridge, true>;

/** Every method name the bridge must expose to be considered fully formed (EXACT set). */
export const CONTEXT_FILES_BRIDGE_REQUIRED_METHODS = Object.keys(
  CONTEXT_FILES_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof ContextFilesBridge)[];

/**
 * Resolve the `window.contextFiles` bridge, or `null` when it is absent (web)
 * or malformed (logged, never silently degraded to a partial surface).
 */
export function resolveContextFilesBridge(): ContextFilesBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (
    window as Window & { contextFiles?: Partial<BoundaryTransport<ContextFilesBridge>> }
  ).contextFiles;
  if (!bridge) {
    return null;
  }
  const missing = CONTEXT_FILES_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.contextFiles bridge is malformed; context-file surfaces disabled', {
      missing,
    });
    return null;
  }
  const transport = bridge as BoundaryTransport<ContextFilesBridge>;
  return { scan: () => callBoundary(() => transport.scan()) };
}
