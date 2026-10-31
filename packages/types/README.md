# @brainstrike/types

Shared contracts and runtime constants for filesystem handles, explorer state/selection, database DTOs, changesets and related boundaries.

- Import types with `import type`. Root is routed by [`index.ts`](src/index.ts); subpaths are in [`package.json`](package.json).
- Keep durable root identity and composite selection keys separate from display paths.
- File-tree `loadMore`/`truncated` pseudo-nodes never count as files or affect selection rollups.
- A DTO identity is not a filesystem grant or a second persistence owner; runtime validation belongs at the admitted boundary.
