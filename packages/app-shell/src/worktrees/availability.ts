/**
 * Lightweight capability entry for the worktree surface. Mirrors
 * `changes/availability.ts` — it re-exports ONLY the capability check plus the
 * required-method pin the desktop preload contract test consumes, so importing
 * it from `apps/desktop` cannot pull `@brainstrike/ui` into a startup chunk.
 */

export type { WorktreesBridge } from './worktrees-bridge';
export {
  isWorktreesBridgeAvailable,
  resolveWorktreesBridge,
  WORKTREES_BRIDGE_REQUIRED_METHODS,
} from './worktrees-bridge';
