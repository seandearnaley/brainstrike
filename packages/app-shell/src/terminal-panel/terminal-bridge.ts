/**
 * Structural typing + capability resolution for the desktop `window.terminal`
 * bridge (a PTY backend).
 *
 * app-shell cannot import `apps/desktop` types, so the bridge shape is mirrored
 * here as the minimal contract the Terminal panel consumes. It MUST stay in sync
 * with the desktop bridge declared in `apps/desktop/src/types/electron.d.ts` (and
 * the handlers in `apps/desktop/src/terminal-ipc-handlers.ts`).
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): the panel is desktop-only
 * because it is constructed only when `resolveTerminalBridge()` returns a
 * fully-formed bridge. Web never sees it — there is no `isElectron()` check
 * anywhere.
 */
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('TerminalPanel');

/** Discriminated result envelope returned across the IPC boundary (never throws). */
export type TerminalResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

export interface TerminalCreateResult {
  /** The canonical, containment-checked absolute cwd the shell started in. */
  readonly cwd: string;
  /** Opaque id used for write/resize/destroy + event correlation. */
  readonly terminalId: string;
}

/** One-way payload pushed when the pty emits output. */
export interface TerminalDataEvent {
  readonly data: string;
  readonly terminalId: string;
}

/** One-way payload pushed when the pty process exits. */
export interface TerminalExitEvent {
  readonly exitCode: number;
  /** Terminating signal number when killed by a signal (else null). */
  readonly signal: number | null;
  readonly terminalId: string;
}

export interface TerminalBridge {
  create: (params: {
    rootId: string;
    /**
     * Absolute path inside the root to pin the shell to; omitted ⇒ the root
     * itself. Mirrors `TerminalCreateParams` in
     * `apps/desktop/src/terminal-ipc-handlers.ts`.
     */
    cwd?: string;
    cols?: number;
    rows?: number;
  }) => Promise<TerminalResult<TerminalCreateResult>>;
  destroy: (params: { terminalId: string }) => Promise<TerminalResult>;
  onData: (callback: (event: TerminalDataEvent) => void) => () => void;
  onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
  resize: (params: { terminalId: string; cols: number; rows: number }) => Promise<TerminalResult>;
  write: (params: { terminalId: string; data: string }) => Promise<TerminalResult>;
}

// Compile-time exact-set proof: `satisfies Record<keyof TerminalBridge, true>`
// fails the build if any interface method is missing here, and excess keys are
// rejected — so the pin can never silently become a subset (or superset) of
// the interface. The runtime pin only checks preload ↔ constant; this closes
// interface ↔ constant.
const TERMINAL_BRIDGE_REQUIRED_METHOD_SET = {
  create: true,
  destroy: true,
  onData: true,
  onExit: true,
  resize: true,
  write: true,
} as const satisfies Record<keyof TerminalBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.terminal` `exposeInMainWorld` key set to this exact list.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 */
export const TERMINAL_BRIDGE_REQUIRED_METHODS = Object.keys(
  TERMINAL_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof TerminalBridge)[];

/**
 * Resolve the `window.terminal` bridge, or `null` when it is absent (web) or
 * malformed (a present-but-broken bridge logs an error and stays absent — no
 * silent degradation).
 */
export function resolveTerminalBridge(): TerminalBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { terminal?: Partial<TerminalBridge> }).terminal;
  if (!bridge) {
    return null;
  }
  const missing = TERMINAL_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.terminal bridge is malformed; Terminal panel disabled', { missing });
    return null;
  }
  return bridge as TerminalBridge;
}

/** True when a fully-formed desktop `window.terminal` bridge is present. */
export function isTerminalBridgeAvailable(): boolean {
  return resolveTerminalBridge() !== null;
}
