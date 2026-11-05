# @brainstrike/file-explorer

Explorer state, actions, persistence and UI-independent context projection. The store, actions and shared types are the API.

- Actions: use the exported owners for directory expansion, explicit/query selection, folder state and settings.
- Identity:
  - Preserve canonical composite selection keys and acknowledged root/source membership.
  - A partial tree or matching path never establishes missing membership.
  - Keep large-selection batching and cancellation.
- Context projection subpaths: `/selection`, `/file-tree`, `/project-tree-text`, `/context-generation`.
  - Uses platform-neutral adapter/handle contracts; raw browser handles stay at the adapter boundary.
  - Invalid filters and traversal failures stay visible; never widen a filter or present an incomplete tree as complete.
- Persistence: only lightweight explorer state. File bytes stay ephemeral; provider isolation and reset fence stale content.
- Keep paths and file content out of diagnostics.
- Contracts: [workspace](../../docs/agents/workspace-context.md), [explorer](../../docs/agents/explorer-search-context-map.md).
