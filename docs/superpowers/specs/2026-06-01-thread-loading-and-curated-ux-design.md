# Thread Loading And Curated UX Design

## Scope

This work improves the assistant thread surfaces in two independently reviewable
PRs.

1. Remove transient startup error flashes in the thread history panel and
   assistant thread workspace.
2. Revamp thread rows with curated icon and color metadata, polished rename and
   delete interactions, and automatic expanded details.

The implementation remains local-first. Thread display metadata is stored in the
existing Mastra thread `metadata` JSON, not in a new persistence layer.

## PR 1: Startup Loading States

The current UI treats a missing repository as an error. During startup,
`usePGliteDatabase()` can be temporarily `null` while the provider is still
initializing, which can briefly render unavailable or failed states before the
database connects.

The fix uses the existing database initialization and provider-error state:

- render an intermittent loading state while PGlite is initializing;
- render database-unavailable copy only when initialization is complete and no
  repository can be constructed;
- render error copy only for a real database provider error or thread repository
  load failure;
- keep early returns explicit in both the threads panel and assistant thread
  workspace.

Tests must cover the startup path where the database handle is initially absent
without showing `Failed to load threads` or `Assistant threads failed to load`.

## PR 2: Curated Thread UX

Thread rows become compact, scannable chips/cards with curated visual identity.
Primary row content shows:

- curated icon;
- curated color accent;
- title;
- selected/open state;
- automatic run badges when present.

The UUID is removed from the primary row. It appears only in the expanded
automatic details area under a diagnostics label, below the human-readable
metadata, and it is never the main visual identifier.

### Curated Metadata

Supported metadata keys:

- `icon`: curated icon id;
- `color`: curated color id.

The icon set is fixed and mapped to existing `lucide-react` icons. The color set
is fixed, accessible, and expressed through local class maps rather than
user-provided color strings. Invalid metadata is ignored by the renderer and not
silently substituted into the saved model.

Thread metadata is updated through the existing
`AssistantThreadRepository.updateThreadMetadata()` path and reflected into the
Zustand store. No new storage key is introduced.

### Rename And Delete

Rename remains inline but is visually clearer:

- edit state keeps the icon and color context visible;
- save/cancel are icon buttons with accessible labels;
- empty titles are rejected by the existing repository validation and surfaced
  next to the input.

Delete becomes a deliberate confirmation state:

- destructive action is visually isolated;
- confirm/cancel are stable controls;
- deletion progress disables repeated submits;
- delete errors stay local to the row and do not collapse the whole thread list.

### Expanded Automatic Details

The row supports a compact expansion with automatic metadata only:

- provider;
- model;
- runtime kind;
- latest run status;
- created and updated timestamps;
- reasoning effort and max output tokens when present.

There is no user-editable note or free-form description in this iteration.

## Testing

Use red-green TDD for each behavior.

PR 1 tests:

- unit/integration coverage for loading-vs-error startup state in
  `ThreadsPanel`;
- unit/integration coverage for loading-vs-error startup state in
  `AssistantThreadTabsWorkspace`;
- manual browser verification that no transient error text appears during
  startup.

PR 2 tests:

- repository/store coverage for curated metadata save and reload;
- component tests for icon/color rendering, metadata edit, rename, delete, and
  expanded details;
- Playwright coverage for the thread customization flow and no-UUID primary row;
- Chrome DevTools/manual verification of startup, customization, reload, and
  delete flows.

Before every PR push, run:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

After every PR push, monitor GitHub checks and unresolved review threads until
the latest head is merge-clean or a real blocker is identified.

## Boundaries

This work does not change:

- assistant runtime provider behavior;
- Mastra memory schema;
- database migrations;
- model catalog behavior;
- Electron main-process embedding or local LLM architecture.
