/**
 * Structural typing for the terminal bridge (a PTY backend).
 *
 * app-shell cannot import `apps/desktop` types, so this is the package-owned
 * bridge shape the Terminal panel consumes. The desktop builds it from its
 * agent-host connection and provides it through
 * `WorkspaceTerminalServicesProvider` (ADR-0029); a tree without a provider has
 * none, and every surface built on it is omitted, never stubbed. There is no
 * `isElectron()` check anywhere.
 */

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
     * `apps/desktop/src/agent-host-platform/desktop-terminals.ts`.
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
