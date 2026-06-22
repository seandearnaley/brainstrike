/**
 * Lightweight capability entry for the Terminal panel.
 *
 * The desktop root layout imports this at STARTUP to decide whether to surface
 * the Terminal tab. It deliberately re-exports ONLY the capability check from the
 * dependency-light `terminal-bridge` module — it must NOT pull in `TerminalPanel`
 * (which imports `@xterm/xterm`), so importing it does not defeat the lazy
 * code-split in `terminal-page-content.tsx`.
 */
export { isTerminalBridgeAvailable, resolveTerminalBridge } from './terminal-bridge';
