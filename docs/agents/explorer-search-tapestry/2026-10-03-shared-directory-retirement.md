# Shared traversal and physical directory retirement

The Workspace Index and legacy UI tree entries use one traversal implementation
in `@brainstrike/file-system/directory-tree`. The public capability requires only
`readDirectory`; a Node owner needs no browser or dialog implementation. The old
UI modules re-export the same functions. Path/depth/root-handle identity, filters,
sorting, streaming snapshots and explicit truncation remain the existing rules.

The previous worker loop could reject on cancellation or strict directory error
while another admitted directory read remained pending. Two controlled tests
hold those reads, advance only the existing loop timer, and observe the public
walk settling too early. The shared implementation retains admitted worker
promises and joins them before public rejection. It preserves the original strict
read error when cancellation arrives during that join. It adds no timeout,
concurrency policy, retry, walker or watcher scheduler.

Guards: `file-explorer-ui/src/utils/__tests__/parallel-directory-walker.test.ts`
and `read-full-tree.test.ts`; reader option tests moved to
`file-system/src/__tests__/directory-tree.test.ts`. The uncached artifact case in
`directory-tree.integration.test.ts` loads the built public entry in plain Node
with a real temporary filesystem fixture and bundles that entry for the browser.

This is a traversal/library boundary. Utility source/catalog composition,
mounted-root authority transfer, watcher ownership and actual app acceptance are
separate work. A standalone adapter fixture does not qualify those paths.
