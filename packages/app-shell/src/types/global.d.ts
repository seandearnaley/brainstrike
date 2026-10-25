import type { BrowserBridge } from '../browser-pane/browser-bridge';
import type { PlatformBridge } from '../platform-bridge';

declare global {
  interface Window {
    /**
     * Desktop-only embedded browser pane bridge (BST-1174). Absent on web (no
     * preload) — capability-check via `resolveBrowserBridge()`
     * (`browser-pane/browser-bridge.ts`) rather than `isElectron()`. Derived
     * from `BrowserBridge` so this declaration cannot drift from the
     * interface; `Partial` because a present-but-incomplete bridge is possible
     * until the resolver validates it.
     */
    browser?: Partial<BrowserBridge>;
    /**
     * Desktop-only OS shell integration bridge. Absent on web (no preload) —
     * capability-check via `resolvePlatformBridge()` (`platform-bridge.ts`)
     * rather than `isElectron()`. Derived from `PlatformBridge` so this
     * declaration cannot drift from the interface; `Partial` because a
     * present-but-incomplete bridge is possible until the resolver validates
     * it.
     */
    platform?: Partial<PlatformBridge>;
  }
}
