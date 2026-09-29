/**
 * Lightweight capability entry for the Terminal panel.
 *
 * The desktop root layout imports this at STARTUP to decide whether to surface
 * the Terminal tab. It deliberately re-exports ONLY the capability check (plus
 * the required-method pins the desktop preload contract test consumes, covering
 * both the `window.terminal` and `window.commandSessions` bridges) from the
 * dependency-light `terminal-bridge` / `command-session-bridge` modules — it
 * must NOT pull in `TerminalPanel` (which imports `@xterm/xterm`), so importing
 * it does not defeat the lazy code-split in `terminal-page-content.tsx`.
 */
export {
  COMMAND_SESSION_BRIDGE_REQUIRED_METHODS,
  type CommandSessionBridge,
  type CommandSessionIdentityParams,
  type CommandSessionInfo,
  type CommandSessionReadPage,
  type CommandSessionResult,
} from './command-session-bridge';
export {
  isTerminalBridgeAvailable,
  resolveTerminalBridge,
  TERMINAL_BRIDGE_REQUIRED_METHODS,
  type TerminalBridge,
  type TerminalCreateResult,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalResult,
} from './terminal-bridge';
