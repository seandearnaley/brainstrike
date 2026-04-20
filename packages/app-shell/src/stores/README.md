# App Shell Stores

This folder contains lightweight Zustand slices used by the app shell. Slices are persisted with storage adapters that work in browser and tests.

- `context-explorer-layout-store.ts`: Route-local context explorer panel layout.
- `search-panel-store.ts`: Search tab filters (query/regex/case/whole-word/globs).
- `db-panel-store.ts`: Database tab UI (active subtab, paging, sort, filter).
- `import-settings-store.ts`: Database import settings (chunking + embeddings).
- `vector-preferences-store.ts` and `vector-status-ui-store.ts`: Vector UI preferences + active set id.

Selectors: prefer tuple/primitives selectors exported by each store to reduce object churn and keep React Compiler friendly.

Testing: most stores expose `__reset*ForTests()` to clear memory + storage to avoid cross-test pollution.
