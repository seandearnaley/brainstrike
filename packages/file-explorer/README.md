# @brainstrike/file-explorer

Explorer state, actions, persistence and UI-independent context projection.
The source store/actions and shared types define the API; a path-only example
is not a root/folder identity contract.

Use the exported action owners for directory expansion, explicit/query selection,
folder state and settings. Preserve canonical composite selection keys, acknowledged
root/source membership, large-selection batching and cancellation. A partial tree
or matching path cannot establish missing membership.

Context/filter projection has narrow `/selection`, `/file-tree`,
`/project-tree-text` and `/context-generation` subpaths. It uses the platform-neutral
adapter/handle contracts; raw browser handles belong at the adapter boundary.
Invalid filters and traversal failures remain visible. Context generation never
silently widens a filter or presents an incomplete tree as complete.

Persist only lightweight explorer state in its existing owner. File bytes remain
ephemeral; provider isolation and reset must fence stale content/generations.
Keep paths and file content out of diagnostics.

[`package.json`](package.json) owns exports/scripts. Relevant contracts:
[workspace](../../docs/agents/workspace-context.md) and
[explorer](../../docs/agents/explorer-search-context-map.md).
For contribution and validation policy, use [root guidance](../../AGENTS.md).
