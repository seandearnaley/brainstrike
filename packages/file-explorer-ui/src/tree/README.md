# Explorer tree

Owns TreeTable row models, lazy-loading composition, tree context and selection
projections. Shared TreeTable remains the treegrid/virtualization owner, including
its two-axis scrollport and accessible keyboard/focus contract.

Keep `optimized-file-tree.tsx` as composition over the existing row-model,
selection-count and directory-mutation helpers. Preserve canonical root/composite
identities, load/error state and explicit selection behavior. Truncation or UI
pseudo-nodes cannot establish complete source membership or file counts.

Use `@brainstrike/file-explorer-ui/tree` across packages. Its
[`index.ts`](index.ts) routes public exports; consumers do not deep-import a new
parallel tree implementation. Tree dependencies remain directed toward core
explorer state, shell selectors, tree-worker helpers and shared UI/hooks. Preview
or indexing coupling needs the existing explicit contract/architecture coverage.

For shared behavior see [UI conventions](../../../../docs/agents/ui-conventions.md)
and [explorer contracts](../../../../docs/agents/explorer-search-tapestry.md).
Commands and validation selection live in the package manifest and
[root guidance](../../../../AGENTS.md).
