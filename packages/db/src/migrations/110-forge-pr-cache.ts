import type { Migration } from './migration-runner';

/**
 * Migration 110 (BST-1391, W4): the forge pull-request cache.
 *
 * One row per `(repository, branch)` — the repository identified by its
 * realpath'd git common dir, the same identity `GitInventoryService` and the
 * Changes surface already key on, so two worktrees of one repository share a
 * repository identity while keeping separate branch rows.
 *
 * It exists so the Threads panel and the Worktree Map can render PR badges
 * INSTANTLY on boot, offline, and across restarts: the composer chip asks the
 * live `window.forge` bridge, but a list-wide projection cannot make one `gh`
 * call per row. The main-process ForgeService is the only writer; every
 * renderer read is a live query.
 *
 * Deliberately NOT a thread sidecar: a PR outlives the thread that opened it,
 * and two threads on one branch share its status. It therefore has no FK and
 * no `THREAD_DELETE_SIDECAR_TABLES` entry — and, being FK-less, it MUST be
 * cleared explicitly by every reset path (FACTORY RESET CONTRACT).
 *
 * `checks_json` holds the NORMALIZED `ForgeCheck[]` (`@brainstrike/types`
 * `readForgeChecks`), never raw gh output: the rollup glyph is re-derived from
 * it in the renderer by `rollupForgeChecks`, so both surfaces agree by
 * construction.
 */
export const migration110ForgePrCache: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_forge_prs;',
  name: 'forge_pr_cache',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_forge_prs (
      repo_common_dir text NOT NULL,
      branch text NOT NULL,
      number integer NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      state text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
      is_draft boolean NOT NULL,
      review_decision text,
      checks_json jsonb NOT NULL,
      head_sha text NOT NULL,
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (repo_common_dir, branch)
    );
  `,
  version: 110,
};
