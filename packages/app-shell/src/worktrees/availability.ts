/**
 * Dependency-light type entry for the managed-worktree capability contract.
 * It re-exports ONLY the bridge type, so
 * importing it from `apps/desktop` cannot pull `@brainstrike/ui` into a startup
 * chunk.
 */

export type { WorktreesBridge } from './worktrees-bridge';
