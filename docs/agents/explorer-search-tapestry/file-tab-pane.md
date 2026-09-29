# Per-file explorer pane — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "PER-FILE EXPLORER PANE".
Read before changing file-tab pane persistence, its absence-means-open default, or its boot hydration merge.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '199,236p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

## PER-FILE EXPLORER PANE (FILE TABS, BST-1269 / BST-1318)

Every file tab hosts a navigation-only tree pane (own `FileTreeProvider` per
tab root, pane-local expansions in `file-tab-pane-store`, per-thread durable
via the workspace snapshot `editors[*].pane`).

- **Absence means OPEN (BST-1318).** A compositeKey with NO store entry
  renders the pane OPEN — the pane auto-opens with its file, revealed to the
  file's location (mount-time reveal at nonce 0). A manual close is recorded
  as an EXPLICIT `open: false` entry so it sticks per file across thread
  switches and restarts; deleting the entry instead would evaporate the
  user's choice on the next hydrate. Old snapshots without pane entries adopt
  auto-open retroactively BY DESIGN — no migration. Every store action that
  materializes an absent key (`togglePane`, `setPaneWidthPct`,
  `toggleExpandedPath`) starts from the OPEN template, and truthiness checks
  on `pane?.open` are a bug class: absent must never read as closed (a
  review-caught regression closed the auto-opened pane on breadcrumb click).
- **Docked RIGHT.** The pane is the SECOND panel of the file-tab split
  (content first), mirroring the main explorer. `widthPct` (clamped 10–70 on
  both write and hydrate) still means pane width.
- **Reveal is one-shot LOCAL state**, never persisted: `(revealNonce,
  revealPath)` keyed per activation; the header toggle and breadcrumb folder
  clicks bump the nonce (re-clicking the same target re-reveals).
- **Boot hydration preserves explicit live pane edits.** The active thread may
  restore before its PGlite workspace snapshot is available. The renderer
  coordinator suppresses saves during that initial read, diffs the complete
  live workspace against its boot baseline, and merges pane fields only for
  tabs admitted by the loaded snapshot (or preserves the live editor map
  atomically when the user changed the tab set). It then applies panes through
  the existing wholesale replacement boundary and persists the merged snapshot
  immediately. This prevents a stale `open: true` row from undoing a manual
  close without leaking a pane from another thread. The complete ordering and
  rejection contract lives in `docs/agents/assistant-persistence.md`.

Paired tests: `file-tab-pane-store.test.ts`,
`file-tab-body-pane.test.tsx`, `apps/web/e2e/file-tab-pane.test.ts`, and
`packages/app-shell/src/thread-workspace/__tests__/use-thread-workspace-coordinator.test.tsx`.
When changing pane semantics, update this section and those tests together.
