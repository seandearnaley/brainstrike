# Explorer preview

Owns Tapestry composition, grouping/pagination, natural-height summary, report
actions and workspace context curation. The retired table preview is not another
surface to recreate; directory columns/sorting belong to the Explorer tree.

Use `@brainstrike/file-explorer-ui/preview` across packages, through
[`index.ts`](index.ts). Keep the preview composed from its existing state,
summary and report-action owners. Per-file ranges preserve the current composite
identity and original source spans; inaccessible/binary content remains visible
rather than being treated as an empty successful read.

Dependencies point toward token state, explorer shell types, shared UI/types and
React. App, desktop/web and assistant runtime internals stay outside this slice;
consumers inject the required capabilities.

[Preview contracts](../../../../docs/agents/explorer-search-tapestry.md) and
[shared contribution/validation policy](../../../../AGENTS.md) apply. Actual props,
exports and checks live in source and the package manifest.
