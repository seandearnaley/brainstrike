# DirectoryHandle rootId propagation — evidence

Supports `docs/agents/workspace-context.md` §
"DIRECTORY HANDLE `rootId` PROPAGATION".
Read before adding a rebuild site for child `DirectoryHandle`s or changing nested-root read attribution.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

Distinct from the MAIN/FOCUSED concept above: this is the durable `RootId`
UUID stamped on a `DirectoryHandle` (`DirectoryHandle.rootId?: RootId`,
`packages/types/src/file-system.ts`) when a folder becomes a registered root.
It self-identifies the handle for capability/mount resolution
(`apps/desktop/src/ipc-domains/workspace-root-mounts.ts`
`WorkspaceRootMountTable.resolveForRead`)
and collision-proof folder-state keys — two same-named web roots share a
`path` (the FSA API hides the absolute path) but never a `rootId`.

**The invariant:** every function that rebuilds a child `DirectoryHandle`
during recursive directory traversal — instead of reusing a handle the
adapter returned — must carry `rootId` forward with parent-anchor fallback:

```ts
const entryHandle = entry.handle as Partial<DirectoryHandle> | undefined;
const rootId = entryHandle?.rootId ?? parent.rootId;
return {
  /* ...other fields... */
  ...(rootId === undefined ? {} : { rootId }),
};
```

A self-identifying child (its own handle already carries a `rootId`, e.g. a
nested registered root) wins over the parent anchor. The parent-anchor
fallback matters because on web, adapter child handles are raw
FileSystemAccess handles with no `rootId` of their own
(`packages/file-system/src/adapters/web-adapter.ts` `readDirectory`) — so
forwarding-only logic (checking `entryHandle?.rootId` but never falling back)
silently drops identity at every depth below the root. `platform` uses the
same anchor-with-fallback shape at every site below; `rootId` must match it.

**Enumerated rebuild sites (six, as of BST post-#2514 follow-up):**

1. `packages/file-explorer/src/read-full-file-tree.ts` — `createChildDirectoryHandle`
2. `packages/file-explorer-ui/src/utils/parallel-directory-walker.ts` — `buildChildHandle`
3. `packages/app-shell/src/background-indexing/workspace-collection-sync-scan.ts` — `toDirectoryHandle`
4. `packages/file-explorer-ui/src/utils/lazy-tree-loader.ts` — `buildDirectoryHandle`
5. `packages/file-explorer-hooks/src/use-file-tree.ts` — the directory-handle literal in `processSingleEntry`
6. `packages/file-explorer-ui/src/utils/process-directory-entry.ts` — `processDirectoryEntry`

Sites 1–4 were fixed together (root-identity preservation across traversal);
sites 5–6 were the same bug class, missed because neither ships in an app
today (`useFileTree`/`useFileExplorer` from `file-explorer-hooks` is not
imported by `apps/desktop` or `apps/web`; `processDirectoryEntry` had only
test callers) but both are public package exports. **Before adding a seventh
rebuild site, check this list — the class has recurred four times.**

**Behavior decision (pinned, desktop):** `WorkspaceRootMountTable.resolveForRead`
(`apps/desktop/src/ipc-domains/workspace-root-mounts.ts`) short-circuits to its
own `this.mounted.get(rootId)` before ever consulting path containment. With
nested mounted roots, a read whose `rootId` was inherited from an outer
traversal anchor therefore resolves against the OUTER mount, not the
innermost path-matched one `findForAbsolutePath` would otherwise
pick. This is the intended behavior, not a side effect: reads made during a
traversal started from root R are authorized and attributed under R's
capability. A self-identifying nested root still wins, because the caller
supplies its own `rootId` rather than relying on the parent-anchor fallback.
Pinned by `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts`
("an inherited rootId anchors a nested read to the traversal (outer) root").

**Do not conflate `DirectoryHandle.rootId` with `IFileNode.rootFolderId`** —
the latter is a folder-state bookkeeping key (defaults to `handle.path` when
no durable id is threaded in) and is a different value in the legacy/no-id
case. Threading one where the other belongs re-introduces exactly this bug
class under a different name.

When adding a seventh rebuild site or changing this invariant, update this
section and its paired tests.

