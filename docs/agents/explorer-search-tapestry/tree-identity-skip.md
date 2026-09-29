# Identical re-enumeration skip — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "EXPLORER TREE LIVE REFRESH".
Read before changing `BFSEngine.setTree` identity, `TREE_IDENTITY_FIELDS`, the
worker snapshot post, or the manual-refresh dispatch contract.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '1185,1215p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

- **An identical re-enumeration is a no-op in the worker (BST-1336).** Every
  `refreshTree` ends in `port.init(...)`, and one FSEvents overflow fires that
  once per mounted `FileTreeProvider` on the root, so a real desktop log showed
  a single overflow producing a legitimate 118→54 replacement immediately
  followed by a 54→54 one — twice over, once per provider.
  `BFSEngine.setTree` (`packages/file-tree-worker/src/bfs-engine.ts`) now
  returns whether it replaced anything and skips the path-index and
  expansion-set rebuild when the incoming tree is identical;
  `file-tree.worker.ts` then skips the `tree initialized` log and the
  `treeSnapshot` post that make downstream consumers rebuild and re-render.
  **Node count is never the test** — `54 → 54` can be 54 different files.
  Identity is the init folder id (an empty-tree root reset carries no node to
  identify it) plus an order-sensitive deep compare of EVERY `WorkerFileNode`
  field; `TREE_IDENTITY_FIELDS` is a TOTAL record over the node type, so a new
  field fails the build instead of silently escaping the check, and absent
  `children` vs `[]` stay distinct states. The skip additionally requires that
  `expandedPaths` already equals `collectExpandedPaths(tree)` — `collapseAll`
  clears the expansion sets WITHOUT touching the tree, so after a collapse the
  replacement legitimately re-derives them and skipping would strand the
  collapsed state that the next `complete` payload reports. Anything short of
  that certainty replaces; the engine never guesses. The duplicate-provider ×2
  is a separate defect and is NOT addressed here.
- **Manual refresh contract.** `file-explorer-panel.tsx` `handleRefresh`
  awaits `refreshFileExplorer()` (the OUTER provider) and dispatches the full
  event only on SUCCESS — a cancelled or failed refresh must not trigger
  downstream full syncs (pinned by the panel tests). The outer, non-nested
  provider is the panel's direct refresh authority and sets
  `skipManualFullEvents` (nested detection via the inherited forest index
  registry), so it ignores the event it just caused; every nested forest
  RootSection provider reacts — that is what makes the toolbar Refresh reach
  every forest root, including the focused root's VISIBLE section.
