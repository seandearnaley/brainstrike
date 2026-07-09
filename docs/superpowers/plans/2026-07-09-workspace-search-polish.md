# Workspace Search Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Land the deferred search-feature follow-ups as one stacked PR: select-all header, Show-more paging (text mode), semantic-mode gating, shared embedder provider, assistant grep-tool token trim, workspace-search core-subpath code-split, and two db cleanups.

**Branch:** `feature/workspace-search-polish`, stacked on `feature/tapestry-implicit-whole-file` (land bottom-up). Keep rebased on the tapestry branch if it changes.

**Tech Stack:** as the parent PRs. All house rules apply (strict TS, no `any`, `exactOptionalPropertyTypes`, no silent fallbacks, RED/GREEN TDD, Ultracite before commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).

## Global Constraints
- Every task independently green: `pnpm test && pnpm type-check` in each touched package before its commit.
- React Doctor: no ref writes during render. New files classified? No new packages (domain map untouched).
- User-approved scope ONLY — nothing beyond the eight items; YAGNI hard.

---

### Task P1: Select-all header ("Select N shown")
**Files:** `packages/workspace-search/src/panel/search-results-tree.tsx` (+ tests)
Header row above the tree (not TreeTable's built-in header — it's `showHeader={false}`): a tri-state checkbox + label `Select {N} shown` where N = currently loaded FILE results. State derives from the bridge: all files checked → checked; some file/chunk selection among them → indeterminate; none → unchecked. Click semantics: unchecked/indeterminate → `toggleFile(key, true)` for every loaded file (whole-file memberships — cheap, no ranges); checked → `toggleFile(key, false)` for every loaded file. Never touches files outside the loaded results. aria-label exactly `Select {N} shown`. Tests: rollup states, both click directions, count label, operates only on loaded results.

### Task P2: Show-more paging (text mode)
**Files:** `packages/workspace-search/src/core/workspace-search-executor.ts`, `workspace-search-store.ts`, `panel/workspace-search-panel.tsx`, `search-results-tree.tsx` (+ tests)
Executor: `searchText` accepts `maxResults` already — add an `appendResults` path: store gains `loadMore` support — simplest honest design: store keeps `textResultLimit` (default 200); "Show more" bumps it +200 and re-runs the CURRENT text search (generation-guarded, same query); tree renders the larger set. The truncated notice becomes the wired "Show more" button (the honest-copy fallback stays when at service caps — grep's candidateLimit may bound results; surface `candidatesTruncated` distinctly as already done). NO semantic paging (semantic `truncated` stays false — document in code). Tests: bump+rerun flow, generation safety (mode switch mid-load-more), notice→button swap.

### Task P3: Semantic-mode gating
**Files:** `packages/workspace-search/src/panel/search-mode-toggle.tsx`, `search-collection-picker.tsx` or a small `use-semantic-availability.ts` (+ tests), possibly `packages/vector-management` for an availability probe export.
Disable the Semantic button with a named reason (tooltip + aria-disabled) when, for the selected set: (a) hosted embedding model and no API key configured (probe: same key-resolution surface `useSearchEmbedder`/provider registry exposes — investigate the cheapest honest signal; if none exists without instantiating an embedder, gate ONLY on (b)+(c) and leave (a) to the existing error card — document the decision), (b) zero embedded chunks in stats (`embeddedChunkCount === 0`), (c) local runtime unavailable (no WebGPU/WASM — `navigator.gpu` probe consistent with how the app gates its built-in local provider). Text mode never gated. The error card stays as backstop. Tests: each reason renders; enabled path unaffected.

### Task P4: Shared embedder provider + db cleanups + grep tool trim
**Files:** `packages/vector-management/src/search-embedder/` (+ provider), `packages/app-shell` (mount + both consumers), `packages/db/src/repositories/file-chunk-repository.ts` + `drizzle/file-chunk-repository.ts` (IN-list→subquery where flagged), `packages/db/src/search/rrf.ts` (`normalizeRRFScores` NaN guard: all-equal scores → all 1.0, tested), `apps/desktop/src/assistant-server/grep-search-tool.ts` (strip `chunkId`/`chunkStartLine`/`chunkEndLine` from model-facing match output; keep internal use) (+ tests each).
Embedder provider: `SearchEmbedderProvider` React context in vector-management owning ONE `useSearchEmbedder` instance; `useSharedSearchEmbedder()` consumer hook; app-shell mounts it around both the collection browser and search surfaces; db-explorer + workspace-search controller consume the shared hook (fallback to local instance when provider absent — NO, house rule: no silent fallback — throw if absent, mount it properly). Tests: single cache across two consumers (factory called once), provider-absent throws.

### Task P5: Core-subpath code-split + final verify + stacked PR
**Files:** `packages/workspace-search/package.json` (exports `./core`), `src/core/index.ts`, `packages/app-shell/src/use-workspace-search-controller.ts` + `explorer-search-tabs.tsx` imports (+ web/desktop vite alias if package-subpath aliasing requires it — mirror the embedding-models alias precedent), tests.
Controller imports ONLY from `@brainstrike/workspace-search/core` (executor/store/types); the panel stays behind `React.lazy` on the root barrel → bundle-level code-split restored. Verify with a web build chunk inspection (`pnpm --filter @brainstrike/web build` + check the search panel lands in a lazy chunk — record evidence). Then: match-row toggle-reservation improvement ONLY if TreeTable already offers a per-row escape (investigate; if it needs a TreeTable API change, SKIP and note — no fork). Exit-bar sweep (one run, all green). Push stacked branch; `gh pr create --base feature/tapestry-implicit-whole-file` (stacked!) titled `feat: workspace search polish — select-all, paging, semantic gating, shared embedder`; body lists per-item behavior + evidence; do NOT merge.

## Plan Self-Review
- All eight user-approved items mapped: select-all (P1), paging (P2), gating (P3), embedder provider + NaN + IN-list + grep trim (P4), code-split + toggle-reservation-if-free (P5). Nothing extra.
- Type consistency: bridge API used as shipped (`toggleFile(key, boolean)`, `fileState`); store generation guard reused for load-more.
- Honest-uncertainty markers: P3(a) key-probe and P5 toggle-reservation carry explicit investigate-then-decide steps with documented outcomes, not silent scope creep.
