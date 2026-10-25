import type { BrowserBridge } from '../browser-pane/browser-bridge';
import type { ChangesBridge } from '../changes/changes-bridge';
import type { PlatformBridge } from '../platform-bridge';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';

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
     * Desktop-only changeset diff bridge (BST-1113/BST-1114). Absent on web
     * (no preload) — capability-check via `resolveChangesBridge()`
     * (`changes-bridge.ts`) rather than `isElectron()`. Derived from
     * `ChangesBridge` so this declaration cannot drift from the interface;
     * `Partial` because a present-but-incomplete bridge is possible until the
     * resolver validates it.
     */
    changes?: Partial<ChangesBridge>;
    /**
     * Desktop-only OS shell integration bridge. Absent on web (no preload) —
     * capability-check via `resolvePlatformBridge()` (`platform-bridge.ts`)
     * rather than `isElectron()`. Derived from `PlatformBridge` so this
     * declaration cannot drift from the interface; `Partial` because a
     * present-but-incomplete bridge is possible until the resolver validates
     * it.
     */
    platform?: Partial<PlatformBridge>;
    /**
     * Desktop-only managed-worktree bridge (BST-1390). Absent on web (no
     * preload) — capability-check via `resolveWorktreesBridge()` rather than
     * `isElectron()`. Derived from `WorktreesBridge` so this declaration cannot
     * drift; `Partial` because a present-but-incomplete bridge is possible
     * until the resolver validates it.
     */
    worktrees?: Partial<WorktreesBridge>;
  }
}
