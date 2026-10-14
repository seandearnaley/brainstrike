# Collections live query: one owner — evidence

Supports `docs/agents/database.md` § "COLLECTIONS LIVE QUERY: ONE OWNER".

The non-convergent write loop two mounted `useCollections` instances produce, how it presented (React error #185 behind a Playwright detach flake), and the sanctioned display-only pattern. Settled 2026-08 under BST-1212.

The record below is the original contract text, extracted unchanged.

`useCollections` (`packages/vector-management/src/collection-select/collection-select.tsx`)
is the SINGLE writer of the shared `vectorStatusUIStore.cachedCollections`
cache. It does not merely read that cache — it recomputes it through its own
instance-local `pendingMutationsRef` and writes the result back.

**At most one instance may be mounted at a time.** Two instances whose pending
mutations differ each recompute a different "next" cache from the other's
write and never converge: A writes X, B recomputes Y and writes it, A
recomputes X, forever. The loop terminates as React error #185 ("maximum
update depth"), which takes down the nearest error boundary — in the original
report, the whole file Explorer panel, and it presented first as a Playwright
"element was detached from the DOM" flake, not as a crash.

A second surface that only needs to DISPLAY collections must:
- read `cachedCollections` from the store,
- seed it once with `fetchCollectionsSnapshot(db)` if it may be the first
  surface up (that helper THROWS on an unusable handle and its rejection must
  be surfaced, never rendered as an empty list — an empty picker reads as "no
  collections exist" and invites a duplicate), and
- stay current through the `onEmbeddingSetUpdated` browser event
  (`removeCachedCollection` on `deleted`, `upsertCachedCollection` otherwise).
  Both store mutations are idempotent, so this is safe alongside the live
  owner. The rename dialog only DISPATCHES; it never touches the cache, so a
  surface that skips this listener shows stale names.

Reference implementation:
`packages/db-explorer/src/components/explorer-collection-picker.tsx`.
The sanctioned event-sync write path is
`packages/db-explorer/src/hooks/use-collection-cache-sync.ts`; mount it on the
dialog-hosting surface (`explorer-import-action.tsx`), never on the picker
itself, because the popover unmounts before the outcome is announced. Seeding
stays with each caller via `fetchCollectionsSnapshot`.
