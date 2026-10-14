# @brainstrike/types

Shared contracts and runtime constants/helpers for filesystem handles, explorer
state/selection, database DTOs, changesets and related package boundaries.

Import types with `import type`. The root and explicit subpaths are declared in
[`package.json`](package.json); [`index.ts`](src/index.ts) routes the owning modules.
Do not recreate a partial `FileExplorerState` object from an old README: current
state, actions, persistence and defaults are owned by their real interfaces and
store constructors.

Preserve durable root identity and composite selection keys separately from display
paths. File-tree `loadMore`/`truncated` pseudo-nodes do not count as files or affect
selection rollups. DTO identity is not a filesystem grant or a second persistence
owner; executable validation belongs to the admitted runtime boundary.

Local dependencies use `workspace:*`. Build/check scripts come from the manifest;
[shared contribution and validation policy](../../AGENTS.md) applies.
