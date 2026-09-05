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
 *
 * ROW SHAPE (amended in place for BST-1391 round 2, review comment
 * 3847743481): a row is EITHER a "PR" observation (every PR-specific column
 * populated) OR an observed-ABSENCE ("none") observation (every PR-specific
 * column NULL) — `review_decision` is always independently nullable, PR or
 * not. `gh` answering "this branch has no pull request" is itself a durable
 * fact — the whole point of this table is instant boot rendering, and an
 * observed `none` deserves the same durability as an observed PR, with its
 * own real `observed_at` rather than being memoized only in session state
 * (lost on every restart). The trailing CHECK enforces the all-or-nothing
 * invariant so a partially-populated row can never exist. This amends the
 * table shape of an UNRELEASED migration (BST-1391 has not merged; no
 * installed database has ever run version 110), so the change is made in
 * place rather than as a new migration.
 */
export const migration110ForgePrCache: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_forge_prs;',
  ledgerKey: 'custom-110-forge-pr-cache',
  name: 'forge_pr_cache',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_forge_prs (
      repo_common_dir text NOT NULL,
      branch text NOT NULL,
      number integer,
      url text,
      title text,
      state text CHECK (state IS NULL OR state IN ('open', 'closed', 'merged')),
      is_draft boolean,
      review_decision text,
      checks_json jsonb,
      head_sha text,
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (repo_common_dir, branch),
      CHECK (
        (
          number IS NULL AND url IS NULL AND title IS NULL AND state IS NULL
          AND is_draft IS NULL AND checks_json IS NULL AND head_sha IS NULL
        ) OR (
          number IS NOT NULL AND url IS NOT NULL AND title IS NOT NULL AND state IS NOT NULL
          AND is_draft IS NOT NULL AND checks_json IS NOT NULL AND head_sha IS NOT NULL
        )
      )
    );
  `,
  version: 110,
};
