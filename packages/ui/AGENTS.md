# `@brainstrike/ui` — AGENTS.md (scope: `packages/ui`)

Shared UI component library: shadcn/Radix primitives + Tailwind v4, plus the
heavier shared surfaces other packages compose.

## Commands (from repo root)

- Test: `pnpm --filter @brainstrike/ui test` (single: `pnpm vitest run -t "name"` from `packages/ui`)
- Type check: `pnpm --filter @brainstrike/ui type-check`
- Lint/format: `pnpm dlx ultracite check` / `fix`

## What lives here (and its contract doc)

Detailed invariants live in `docs/agents/` at the repo root — read the matching
doc before changing these areas:

- Assistant panel feature code moved to `packages/assistant-ui`; this package
  retains the shared primitives it composes → `docs/agents/assistant-runtime.md`,
  `docs/agents/assistant-persistence.md`
- `src/tree-table/` — canonical treegrid (`TreeTableViewport` is the sole
  two-axis scroll owner; WAI-ARIA treegrid semantics) → `docs/agents/ui-conventions.md`
- `src/context-menu/` — Radix wrapper for the shared context-action system
  (never hand-roll per-surface menus) → `docs/agents/ui-conventions.md`
- `src/markdown-surface/`, `src/shiki/`, `src/code-surface/` — markdown preview
  + shared cached highlighter + read-only CodeMirror viewer →
  `docs/agents/explorer-search-context-map.md`

## Package rules

- Browser-safe only: no Electron imports, no `isElectron()` — capabilities are
  injected by consumers (see the capability-gating invariant in root `AGENTS.md`).
- This package never touches `window.Notification`, preference stores, or
  platform bridges directly; it reports events up through callback props.
- Filenames kebab-case, components export PascalCase, hooks `use-*.ts`.
