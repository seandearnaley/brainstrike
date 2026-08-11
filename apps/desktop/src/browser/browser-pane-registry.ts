/**
 * Registry of live browser pane hosts (BST-1176 PR2).
 *
 * Pane hosts are created per visible window in main.ts; the assistant
 * server's browser tools reach the CURRENT one through here without threading
 * it through every layer. Kept as a small stack rather than a single slot so
 * closing a newer window falls back to an older still-live host instead of
 * reporting `browser_unavailable` while a pane is visibly open (single
 * visible window is today's normal case, not an enforced invariant).
 */
import type { BrowserPaneHost } from './browser-pane-host';

const liveHosts: BrowserPaneHost[] = [];

export function setActiveBrowserPaneHost(host: BrowserPaneHost): void {
  const index = liveHosts.indexOf(host);
  if (index !== -1) {
    liveHosts.splice(index, 1);
  }
  liveHosts.push(host);
}

export function clearActiveBrowserPaneHost(host: BrowserPaneHost): void {
  const index = liveHosts.indexOf(host);
  if (index !== -1) {
    liveHosts.splice(index, 1);
  }
}

/** The most recently registered still-live host; null when none exists. */
export function getActiveBrowserPaneHost(): BrowserPaneHost | null {
  return liveHosts.at(-1) ?? null;
}
