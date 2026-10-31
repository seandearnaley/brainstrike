# `@brainstrike/ui`

Shared UI library: shadcn/Radix primitives on Tailwind v4, plus the heavier shared surfaces other packages compose. Assistant feature code lives in `@brainstrike/assistant-ui`.

## Areas and their contracts

Read the matching `docs/agents/` doc before changing these:

- `src/tree-table/`: the canonical treegrid. `TreeTableViewport` is the sole two-axis scroll owner; WAI-ARIA treegrid semantics → `ui-conventions.md`.
- `src/context-menu/`: Radix wrapper for the shared context-action system; never hand-roll per-surface menus → `ui-conventions.md`.
- `src/markdown-surface/`, `src/shiki/`, `src/code-surface/`: markdown preview, shared cached highlighter, read-only CodeMirror viewer → `explorer-search-context-map.md`.

## Rules

- Browser-safe only: no Electron imports and no `isElectron()`; consumers inject capabilities.
- Never touch `window.Notification`, preference stores or platform bridges directly; report events up through callback props.
- Filenames kebab-case; components export PascalCase; hooks are `use-*.ts`.
