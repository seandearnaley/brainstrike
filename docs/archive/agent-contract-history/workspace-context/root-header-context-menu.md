# Root-header context menu — evidence

Supports `docs/agents/workspace-context.md` §
"WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED".
Read before changing the workspace-root context actions or their ownership split (BST-1393 spec §7).

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

- **Root-header context menu (BST-1393, spec §7) — SHIPPED, the v1 DEFERRED
  ruling above is CLOSED.** `packages/context-actions/src/types.ts` carries a
  `workspace-root` ContextTarget kind (`displayName` · `isMain` · `path | null`
  · `rootId`), adapted by `workspaceRootToTarget`
  (`packages/file-explorer-ui/src/context-actions/workspace-root-target.ts`),
  which normalizes a web FSA handle's name-as-path to `null` so path-shaped
  actions hide by DATA rather than by platform. Both the forest sidebar's
  `RootSectionInner` and the SINGLE-ROOT layout's own header row wrap ONLY
  their header in `ActionContextMenu` — never the tree pane, which owns its
  own — so the two menus stay siblings rather than nesting. A single-root
  workspace (the primary, one-folder scenario) has its own trigger row
  (`data-testid="single-root-header-row"`), not just the forest sections; the
  claim/reset/local-actions/focus-restoration protocol is shared by both
  through `packages/file-explorer-ui/src/shell/use-root-section-context-menu.ts`
  (`useRootSectionContextMenu` / `useSingleRootHeaderMenu`) rather than two
  independently-maintained copies.
  - Six items, three owners. GLOBAL registry: `workspace-root.copy-path`
    (`clipboard`) and `workspace-root.reveal` (`fs.reveal`). SURFACE-LOCAL in
    `file-explorer-ui` (`workspace-root-local-actions.ts`):
    `workspace-root.set-as-main` and a STAGED `workspace-root.disconnect`.
    Disconnect… is present only when the surface actually has a way to
    disconnect (`onDisconnect` is optional and OMITS the action when absent —
    mirrors the header's own X button, never a silently-inert visible item).
    Set as Main's dep returns an `ActionOutcome`: `setMainRoot` warn-and-no-ops
    for an id `activeRootIds` doesn't recognize (a legacy path-identity root),
    so the surface checks `activeRootIds.includes(target.rootId)` first and
    reports `{ ok: false }` rather than the click silently doing nothing.
    INJECTED by app-shell through `FileExplorerPanel`'s `rootActions` prop
    (the `selectionActions` precedent): `workspace-root.open-in-terminal` (the
    BST-1457 `terminal-target-store` seam — a mounted root IS its own cwd, so
    `cwd` and `rootId` name the same folder here) and
    `workspace-root.new-thread-here`.
  - **"Set as Main", not "Make primary" (BST-1393 ruling R1).** This surface
    changes the workspace-wide MAIN root (`setMainRoot`, `activeRootIds[0]`) —
    the role this same header already renders as its "Main" badge. The
    workspace bar's "Make primary" is a DIFFERENT operation with a different
    writer (the thread's `operatingRoot*` metadata triple) and is untouched.
    Do not merge the two vocabularies.
  - "New thread here" goes through `useCreateThreadInFolder`
    (`packages/app-shell/src/hooks/use-create-thread-in-folder.ts`), which is
    the threads panel's own folder-bound creation extracted so BOTH surfaces
    keep ONE writer of the `operatingRoot*` triple: one `createThread`, then
    ONE metadata write (the repository rejects a partial triple).
  - **Disconnect… dialog-focus ordering — LIVE-VERIFIED (BST-1393 L5 CDT,
    2026-08-27):** `Disconnect…` stages a modal (`DisconnectRootDialog`) from
    inside `ActionContextMenu`'s `onCloseAutoFocus`; Radix's exit animation
    means the menu's REAL unmount (and that focus-restoration callback) fires
    AFTER the dialog has mounted and autofocused, so `onCloseAutoFocus` skips
    its own restoration while the dialog is open. jsdom cannot observe the
    ordering (synchronous unmount); the live CDT run sampled
    `document.activeElement` immediately, at 300 ms and at 800 ms after the
    Disconnect… click and found focus INSIDE the dialog (a BUTTON) at every
    sample, with no flicker back to the header toggle — the guard holds
    against the running app, and the desktop e2e's Disconnect case now polls
    the same containment. Escape closes the dialog with the root still
    connected.

