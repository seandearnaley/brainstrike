/**
 * Registry of the ACTIVE browser pane host (BST-1176 PR2).
 *
 * The pane host is created per visible window in main.ts; the assistant
 * server's browser tools need to reach it without threading it through every
 * layer. One live host at a time (single visible window today) — a new window
 * replaces the registration and window close clears it.
 */
import type { BrowserPaneHost } from './browser-pane-host';

let activeHost: BrowserPaneHost | null = null;

export function setActiveBrowserPaneHost(host: BrowserPaneHost): void {
  activeHost = host;
}

/** Clear only when `host` is still the registered one (close-vs-recreate race). */
export function clearActiveBrowserPaneHost(host: BrowserPaneHost): void {
  if (activeHost === host) {
    activeHost = null;
  }
}

/** Null when no visible window exists yet (or it closed). Callers surface that. */
export function getActiveBrowserPaneHost(): BrowserPaneHost | null {
  return activeHost;
}
