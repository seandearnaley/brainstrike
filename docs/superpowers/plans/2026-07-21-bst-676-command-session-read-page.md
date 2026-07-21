# BST-676: Bound command-session reads inside the manager

## Finding

The Desktop IPC layer requested the manager's entire retained command-session
tail, up to two Mi UTF-16 code units, and only then sliced a 32,768-unit page.
Polling a near-cap buffer could therefore repeatedly allocate and join output
the renderer could never receive.

## Contract

- The manager decodes at most the requested UTF-16 page from retained blocks.
- `nextCursor` advances by the returned page and `hasMore` reports remaining
  output; gap and live-tail semantics stay unchanged.
- A page boundary never splits a UTF-16 surrogate pair.
- Desktop IPC and the model inspection tool request the shared 32,768-unit cap.
- IPC fails loudly if the manager violates the cap; there is no second slicing
  fallback.

## Red/green proof

1. Fill a near-cap retained buffer and prove the first manager read initially
   decoded the full tail instead of one page.
2. Place a surrogate pair across the page boundary and prove the cursor backs
   up without dropping or duplicating either code unit.
3. Prove IPC requests the shared cap and rejects an oversized manager result.
4. Run focused manager/IPC/tool tests, then the repository gate once after the
   parent PR is merged and this branch is rebased onto main.
