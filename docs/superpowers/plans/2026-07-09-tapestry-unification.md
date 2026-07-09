# Tapestry Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the `useTapestryRanges` global toggle and the auto-created whole-file default range; per-file rule everywhere: **no ranges = whole file; ranges = union of active ranges**.

**Architecture:** Deletion-heavy. The report generator (`buildFileContextContent`) and the assistant's ranged reader (`buildRuntimeTapestryRangesByPath` skipping rangeless files) ALREADY implement the per-file rule when the toggle is on — the work is removing the toggle's plumbing, the default-range seeding, and the dual presentation branches, plus a small implicit-whole-file affordance in the Minimap.

**Tech Stack:** TypeScript strict, React 19, Zustand, Vitest. Branch: `feature/tapestry-implicit-whole-file` (off main post-#1514).

**Spec:** `docs/superpowers/specs/2026-07-09-tapestry-unification-design.md`. **Seam map** (verified file:line, embedded per task below) came from a live sweep on this branch.

## Global Constraints

- TypeScript strict; NEVER `any`; `exactOptionalPropertyTypes` ON (conditional spread; never explicit `undefined`).
- No silent fallbacks. RED/GREEN TDD: behavior changes get a failing test first; pure deletions get their paired tests updated in the same step, never weakened — port assertions to the new semantics.
- Every touched file has a `__tests__` neighbor — update it in the same task.
- Biome/Ultracite: `pnpm dlx ultracite fix` before each commit. Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Known default-user behavior changes (deliberate, spec-approved; do NOT "fix" them back):** (a) export/assistant framing flips from whole-file `<selection>` wrapper to bare `<file>` for untouched files (content identical); (b) `rangeAdjustedFilesCount`/`activeRangeFilesCount` stop counting untouched files; (c) `outputApproxTokens` becomes the file's tokens instead of `null`; (d) token meter/summary lock to the "Output" presentation.
- React Doctor gate: no `ref.current` writes during render. Static gate: any NEW package must be classified in `architecture/domain-map.json` (none expected here).
- Do not run dev servers; run package suites + type-checks per task; full exit-bar sweep only in the final task.

---

### Task 1: Stop seeding the default range; reset means "clear"; Minimap implicit-whole-file affordance

**Files:**
- Modify: `packages/file-explorer-ui/src/utils/tapestry-range-sync.ts`
- Modify: `packages/file-explorer-ui/src/preview/preview-panel.tsx` (reset handlers ~795-810; `createDefaultTapestryRanges` imports at :44, :804)
- Modify: `packages/file-explorer-ui/src/tapestry/minimap.tsx` (empty-state affordance, near the "Create range" background button ~:577-583)
- Tests: the paired `__tests__` files for all three (find exact names; `tapestry-range-sync.test.ts` exists from #1514)

**Interfaces:**
- Consumes: post-#1514 `syncTapestryRanges` (content-ready-gated clamp stays).
- Produces: `syncTapestryRanges` NEVER creates ranges (the `if (!next[compositeKey]) { createDefaultTapestryRanges }` branch at ~:94-98 is deleted; a selected file with no ranges passes through with no entry). `createDefaultTapestryRanges`, `shouldStretchDefaultRange`, `stretchDefaultRange` deleted entirely (the stretch is dead once nothing seeds `userModified:false` startLine-0 ranges). Reset handlers set `[]` (or delete the key) instead of re-seeding.

- [ ] **Step 1 (RED):** In the range-sync tests: change the "creates default ranges for new keys" cases to assert NO entry is created for a rangeless selected file; keep/port the clamp + ready-gate cases; add: a file with existing ranges is untouched by selection sync. In preview-panel/tapestry tests: reset action yields `[]` for the key. Minimap: with `selections: []`, an "Whole file — drag to select lines" affordance renders (visible label or title attr — pick what Minimap's test harness can assert) alongside the existing create-range background. Run → FAIL.
- [ ] **Step 2 (GREEN):** Delete the three functions + seeding branch from `tapestry-range-sync.ts`; repoint both reset paths in `preview-panel.tsx` to clear; add the Minimap empty-state affordance (presentation-only; reuse existing muted-text styles; drag-create path untouched).
- [ ] **Step 3:** `cd packages/file-explorer-ui && pnpm test && pnpm type-check` → green. Commit: `feat(tapestry): no implicit default range — rangeless selection is whole-file`.

### Task 2: Token math + meters — per-file rule, single presentation

**Files:**
- Modify: `packages/file-explorer-ui/src/utils/context-selected-token-summary.ts` (remove `useTapestryRangesForContextOutput` arg + the early-return at ~:193-195; the per-file loop at :208-225 already implements the rule)
- Modify: `packages/file-explorer-ui/src/indexing/token-meter.tsx` (:106,:109,:143) and `token-summary-bar.tsx` (:112-:248) — delete the toggle prop; lock to the "Output" presentation (`showSourceTokens` semantics: keep whichever branch the toggle-ON state renders today)
- Modify: `packages/file-explorer-ui/src/preview/preview-panel.tsx` — `outputApproxTokens: hasRanges ? null : item.tokens` (~:377) becomes the real per-file number: rangeless → `item.tokens`; ranged → the range-adjusted estimate the summary already computes (thread it; if per-file adjusted tokens aren't exposed, keep `null` for ranged files and note it — do NOT invent a second estimator)
- Tests: `context-selected-token-summary.test.ts`, `token-summary-bar.test.tsx`, meter tests

- [ ] **Step 1 (RED):** summary tests: same inputs, no toggle arg; rangeless file counts full tokens; ranged file counts adjusted tokens; all-inactive counts 0 with `hasActiveSelection:false`. Meter/summary-bar tests: single presentation, no prop. → FAIL.
- [ ] **Step 2 (GREEN):** implement; delete prop threading from all callsites (grep `useTapestryRanges` within file-explorer-ui to catch stragglers — footer/preferences are Task 3's, leave compiling via default args if needed, else order edits so each commit compiles).
- [ ] **Step 3:** package tests + type-check green. Commit.

### Task 3: Preference + footer switch removal

**Files:**
- Modify: `packages/file-explorer-ui/src/preview/use-preview-panel-preferences.ts` (field `:51`, sanitizer `:172-179`, read/persist `:233-238`, `:304-311`, `:328`, `:354`, defaults `:72`)
- Modify: `packages/file-explorer-ui/src/preview/preview-panel-footer.tsx` (switch block :539-567 + prop threading) and `preview-panel.tsx` wiring (:942/:950/:976/:984, contextExportOptions at :813-820 — the export-options part overlaps Task 4; remove only the pref/UI side here, keep `useTapestryRanges: true` hardcoded temporarily if the type still requires it)
- Tests: `use-preview-panel-preferences.test.tsx`, `preview-panel-footer.test.tsx`

- [ ] **Step 1 (RED):** preference tests: stored blob WITH the stale field loads cleanly and the field is gone from state/save-object; footer tests: no switch. → FAIL.
- [ ] **Step 2 (GREEN):** delete field/sanitizer/setter/prop chain. No migration mechanism exists and none is needed (stale key ignored — assert it).
- [ ] **Step 3:** green; commit.

### Task 4: Snapshot type + report chain — always per-file

**Files:**
- Modify: `packages/file-explorer-ui/src/workspace-context-curation-store.ts` (drop `useTapestryRanges: boolean` from `WorkspaceContextCurationSnapshot` :32)
- Modify: `packages/file-explorer-ui/src/preview/preview-panel.tsx` (snapshot object :398; contextExportOptions :813-820)
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts` (ONLY the `useTapestryRanges: snapshot.useTapestryRanges` copy at :348 — the contract field stays optional until Task 5 so this compiles)
- Modify: `packages/file-explorer-ui/src/context-export-options.ts` (drop the field), `use-preview-panel-report-actions.ts` (`toContextGenerationOverrides` :25-46), `packages/hooks/src/use-report-generation.ts` (default at :173), `packages/workers/report-generation-worker.ts`, `packages/utils/src/report-generator.ts` (`buildFileContextContent` :226-283 — remove the `useTapestryRanges` param and its `:242` gate; the per-file logic below it stays verbatim)
- Tests: store, report-generator, worker, use-report-generation, report-actions tests

**Interfaces:** report chain signature after this task: `buildFileContextContent({ filePath, fileContents, selectedLineRangesByFile })` (or current shape minus the flag) — rangeless/missing-key → full `<file>`; active ranges → `<selection>` slices; all-inactive → the existing `<selection_summary>` empty notice.

- [ ] **Step 1 (RED):** report-generator tests: same fixtures minus the flag; rangeless → full file; ranged → slices; all-inactive → summary notice. Worker/hooks tests: no flag in request/overrides. Store test: snapshot type without the field. → FAIL (type + behavior).
- [ ] **Step 2 (GREEN):** delete the flag through the chain bottom-up (generator → worker → hooks → export-options → preview-panel → store type → runtime copy at app-shell :348).
- [ ] **Step 3:** file-explorer-ui + hooks + workers + utils + app-shell tests/type-checks green. Commit.

### Task 5: Assistant contract + desktop consumers

**Files:**
- Modify: `packages/assistant-contract/src/runtime-data.ts` (drop `useTapestryRanges?` from `RuntimeWorkspaceContextMetadata` :100)
- Modify: `apps/desktop/src/assistant-server/assistant-tools.ts` (gate :1580-1584 → `useTapestrySelections !== false`; `summarizeCuratedContext` :1098-1107 drops the flag from the summary payload; `buildRuntimeTapestryRangesByPath` :1043-1057 unchanged — it already skips rangeless files)
- Modify: `apps/desktop/src/ipc-tools.ts` (sanitizer :287-291)
- Tests: `apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts`, `apps/desktop/src/__tests__/main/ipc-tools.test.ts`

- [ ] **Step 1 (RED):** assistant-tools tests: a context file with `ranges: []` reads as bare whole file; with active ranges reads `<selection>`-wrapped; listWorkspaceContext summary has no `useTapestryRanges` field; sanitizer accepts payloads without the flag. → FAIL.
- [ ] **Step 2 (GREEN):** implement; contract field deletion last so each package compiles in dependency order (contract → app-shell already clean from Task 4 → desktop).
- [ ] **Step 3:** assistant-contract + desktop suites/type-checks green. Commit.

### Task 6: workspace-search follow-through + docs + e2e comment

**Files:**
- Modify: `packages/workspace-search/src/panel/workspace-search-panel.tsx` (delete the "Ranges apply in Tapestry ranges mode" footer note + its test — the note is now meaningless; token footer stays)
- Modify: `AGENTS.md` (WORKSPACE SEARCH bridge invariant wording; ADD a short `## TAPESTRY` section: the per-file rule, no default range, origin:'search' derivation, reset-means-clear, and the four deliberate default-user changes)
- Modify: `apps/web/e2e/file-explorer.test.ts` (:830-835 comment rationale now moot — update comment only, assertion stays)
- Modify: spec self-review fixes if any section drifted from what shipped
- Tests: workspace-search panel test update

- [ ] **Step 1:** make the changes (comment/doc edits + one test-backed UI deletion). workspace-search suite green. Commit.

### Task 7: Live verification + exit-bar sweep + PR

- [ ] **Step 1 (live CDT, web):** start web dev server if not running; fixture workspace; verify: select file in Explorer → appears in Tapestry as implicit whole-file (no range chrome), token summary counts full file; drag a slice → refined + tokens shrink; search a term, check a chunk → derived `origin:'search'` slice appears; reset-to-whole-file clears to implicit state; uncheck → clean. Read the curation store via the `/@id/@brainstrike/file-explorer-ui/preview` import trick to confirm NO ranges exist for untouched files.
- [ ] **Step 2 (live CDT, desktop):** built app on the real profile (launch recipe in `.superpowers/sdd/progress.md` history / memory): spot-check `listWorkspaceContext` via the assistant server path if cheap, else verify the same UI flows + that existing selections still render.
- [ ] **Step 3 (sweep):** `pnpm dlx ultracite check`; `pnpm turbo type-check`; `pnpm run test:fast`; `pnpm build`; db lane checks — all green in ONE run.
- [ ] **Step 4:** push branch; `gh pr create` against main titled `feat: Tapestry unification — files are membership, ranges are refinement`; body: model summary, the four deliberate behavior changes called out prominently, AGENTS.md-format file summary, follow-ups. **Do NOT merge** — user reviews. Keep the branch fresh vs main while open.

---

## Plan Self-Review

- **Spec coverage:** §1 model → T1/T2/T4/T5; §2 deletions → T1 (default+stretch), T3 (toggle UI/pref), T4 (snapshot flag + chain), T5 (contract); §3 blast radius items 1-8 → T1,T1,T2/T4,T4/T5,T4,T6,T6,(persistence: none needed — verified, T3 asserts); §4 UX → T1 (implicit state, reset), T6 (footer note); §5 testing → per-task + T7. Gap check: §4's "Reset to whole file" per-file action = existing reset handlers repointed (T1) — no new surface needed since the handlers already exist per-file.
- **Placeholder scan:** none; every step names exact files/lines from the verified seam map and the assertion to write.
- **Type consistency:** the flag removal is ordered so every commit compiles: seeding (T1) → math/presentation (T2) → pref/UI (T3) → snapshot+chain with contract field still optional (T4) → contract+desktop (T5).
