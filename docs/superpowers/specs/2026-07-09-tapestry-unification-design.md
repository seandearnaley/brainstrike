# Tapestry Unification — Design Spec

**Date:** 2026-07-09
**Status:** Approved in conversation (user: "the tapestry idea in general is greenfield… I'm open to ideas" → proposal accepted; "separate PR is fine, land the search one first")
**Branch:** `feature/tapestry-implicit-whole-file` (off main after PR #1514 merges)

## 1. The model

**"Files are membership. Ranges are refinement. No ranges = whole file."**

| Decision | Rule |
|---|---|
| Selecting a file (Explorer checkbox, Search file checkbox, anywhere) | File membership ONLY. No materialized whole-file range. |
| Rangeless selected file in Tapestry | Rendered as an IMPLICIT whole-file state: soft full tint, "Whole file" affordance, NO drag handles/slice chrome. |
| First refinement (Tapestry drag, or Search chunk check) | Creates explicit ranges; file switches visually to "refined" mode with real slices. |
| Context assembly (report generator, `listWorkspaceContext`, token summary) | Rangeless → whole file. Ranges present → union of ACTIVE ranges. Per-file, no global switch. |
| `useTapestryRanges` global toggle | RETIRED. Replaced by per-file semantics; the existing `TapestryControls` "Reset ranges" button now clears (never re-seeds) each targeted file's ranges instead of restoring a default slice — no new dedicated single-file reset control was added. |
| Search-managed ranges (`origin:'search'`) | Unchanged: derived one-way from the selected-chunk set; never touch userModified/default ranges (there IS no default range anymore). |

## 2. What gets deleted (the payoff)

- `createDefaultTapestryRanges` and every callsite (the explicit `[0,totalLines)` default slice).
- `shouldStretchDefaultRange` / `stretchDefaultRange` — the entire auto-stretch heuristic (existed only to maintain the default slice; caused the clamp/stretch bug).
- The `useTapestryRanges` boolean on `WorkspaceContextCurationSnapshot` + its toggle UI + every consumer branch (report generator, token summary, `toRuntimeWorkspaceContext`).
- The "whole file has two representations" ambiguity that produced three bugs in the search feature work.

Clamping of out-of-bounds ranges to real totals stays (content-ready-gated, as landed in #1514).

## 3. Blast radius (each site needs a task)

1. `packages/file-explorer-ui/src/utils/tapestry-range-sync.ts` — remove default creation + stretch; keep ready-gated clamp.
2. `packages/file-explorer-ui/src/tapestry/*` — minimap/view renders implicit-whole-file state for rangeless files; drag-to-create-first-range interaction (today the first range exists to be resized — verify create-by-drag works on an empty file and add it if the interaction assumed the default slice); repoint the existing "Reset ranges" control to clear instead of re-seed.
3. `packages/file-explorer-ui/src/preview/preview-panel.tsx` + `utils/context-selected-token-summary.ts` — snapshot building: rangeless file → whole-file tokens; ranged file → range tokens. Delete useTapestryRanges branches.
4. `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts` (`toRuntimeWorkspaceContext`, `buildAssistantTapestryRange`) — same per-file rule for what the assistant's `listWorkspaceContext` reports.
5. Report generator — find every consumer of `useTapestryRanges`/`snapshot.files[].ranges` (grep) and convert to the per-file rule.
6. `packages/workspace-search/src/bridge` — simplification: the "whole-file coverage via default range" display path goes away; `chunkState` = set membership OR whole-file-selected (rangeless), which is ALREADY the model — mostly doc/test updates.
7. AGENTS.md — update WORKSPACE SEARCH bridge invariant + add/adjust a TAPESTRY section documenting the unified model.
8. Migration/compat: existing sessions may hold persisted… (tapestryRangesByKey is session-only — no persistence migration needed; snapshot is session-only too. Factory reset unaffected.) Verify nothing persists ranges (grep persist keys).

## 4. UX details

- Implicit whole-file rendering: full-height soft tint in the minimap (distinct from an explicit full-file range's solid slice), label "Whole file", tooltip "Drag to select specific lines".
- Refined file: existing slice rendering; the pre-existing `TapestryControls` "Reset ranges" button clears ranges for its targeted files (userModified included — it's an explicit user action; confirm-free, undoable by re-dragging) instead of restoring a default slice. Shipped as-is (no new per-file-only reset control); see `preview-panel.tsx`'s `handleResetTapestryRanges`.
- Search panel footer note ("Ranges apply in Tapestry ranges mode") becomes obsolete → remove; token count is now always live-accurate per-file.
- Explorer/preview flows must FEEL unchanged for pure file-pickers: select files → whole files in context (same as today with the toggle off/on default paths — verify what today's default effectively is and preserve effective behavior for that path).

## 5. Testing

- Unit: range-sync (no default creation; rangeless passthrough; clamp still works), token summary (rangeless=whole-file tokens, ranged=range tokens), snapshot builder branches, runtime-context mapping, search bridge display states.
- Interaction: tapestry drag-to-create on a rangeless file; reset-to-whole-file; userModified preservation unchanged.
- Live CDT (web fixture + desktop real profile): select file → whole-file implicit; drag a slice → refined + tokens shrink; search chunk check → refined with derived slice; reset → whole file. Report/assistant context spot-check via listWorkspaceContext (desktop).
- Full exit-bar sweep before PR.

## 6. Out of scope

Search-polish items (select-all, paging, semantic gating, etc.) — separate `feature/workspace-search-polish` PR. Persistence of curation state across sessions. Multi-select drag UX changes beyond the first-range creation necessity.
