# @brainstrike/db

Shared types and pure helpers for desktop collections, thread search and
diagnostics. It holds no database engine: canonical state belongs to the host
StateStore and committed log, and the derived index is SQLite.

- Root entry (React-free): collection, file-import, thread-search and
  diagnostics types; `createCollectionCatalogRepository`;
  `createThreadSearchService`.
- `@brainstrike/db/react`: `useEmbeddingSetsRepository`, which reads the
  `window.collectionCatalog` capability.
