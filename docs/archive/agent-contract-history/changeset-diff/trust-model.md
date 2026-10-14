# Worktree trust and bidirectional validation — evidence

Supports `docs/agents/changeset-diff.md` § "TRUST RULE + BIDIRECTIONAL VALIDATION".
Read before changing containment, trust resolution, or the attack-case fixtures.

The lines below are the pre-distillation contract text, extracted verbatim.

Decision site, `buildRepository` in `git-inventory-service.ts`:

```ts
const containment = computeContainment(canonicalPath, resolvedRoots);
const { trust, trustReason } =
  containment === 'outside-roots'
    ? await resolveWorktreeTrust(fs, canonicalPath, group.commonDir)
    : { trust: 'validated', trustReason: null };
```

A worktree **inside** a workspace root is unconditionally `'validated'` —
the bidirectional check is never even called. This means "inside a
user-granted root", NOT "ownership verified": a fabricated
`.git/worktrees/<name>/gitdir` pointing at a path inside a root (e.g.
another repo's own worktree in the same workspace) reads `'validated'`
without ever being cross-checked. Only a worktree whose containment is
`'outside-roots'` gets the genuine bidirectional check
(`resolveWorktreeTrust`): its own `.git` is read back
(`resolveGitEntryAtWorktree`, discovery module) and must resolve to the
SAME `group.commonDir` as the granting repo — a one-way pointer is never
sufficient. Failure (unreadable, or resolves elsewhere) → `'unvalidated'`
with a non-null `trustReason`; success → `'validated'` with `trustReason:
null`. An unvalidated entry is **still reported**, never dropped — every
branch still pushes the descriptor.

Containment/trust are computed on the **realpath'd** worktree path
(`canonicalPath`), never the raw git-reported `summary.path` — this closes
a symlink-defeats-containment attack (a committed in-root symlink whose
real target is outside every root must not be misclassified as in-root and
auto-validated).

Guarding tests, `apps/desktop/src/__tests__/assistant-server/git-inventory.integration.test.ts`:
- in-root always validated — `'reports a linked worktree INSIDE the active
  roots with containment set'` (asserts `trust: 'validated'` for a real
  in-root worktree, bidirectional check never exercised).
- outside-roots, genuine → validated — `'reports a REAL linked worktree
  OUTSIDE every root as outside-roots but still validated'`.
- outside-roots, fabricated/unreadable target → unvalidated, no content
  leak — `'fabricated-gitdir attack: a hand-written worktree admin entry
  pointing outside every root is present but UNVALIDATED, with no content
  access beyond its own .git'`.
- outside-roots, fabricated pointer at a real DIFFERENT repo (common-dir
  mismatch) → unvalidated — `'fabricated-gitdir attack pointing at a
  DIFFERENT real repository: resolves but the common dir mismatches —
  unvalidated'`.
- symlink defeats containment — `'symlink-defeats-containment attack: a
  committed in-root symlink to an outside target is NOT auto-validated'`.
- prunable (deleted, not GC'd) worktree is a trust state, not an inventory
  error — `'treats a merely-prunable ... linked worktree as trust state,
  not an inventory error'` (asserts `snapshot.errors` is `[]`).

Fabricated admin fixtures publish their complete `worktrees` directory with an
atomic rename, including Git's `locked` marker. The helper asserts that its
repository has no existing worktree admin directory; these three attack cases
each own a fresh repository. Publishing only an entry after creating an empty
parent would expose that parent to Git's empty-directory pruning. They never expose an incomplete
entry to background Git maintenance. The symlink attack runs real
`git worktree prune --expire=now` before inventory and still asserts canonical
outside-root containment and unvalidated trust; locking does not grant trust.
