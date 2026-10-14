# Read-before-write staleness guard — evidence

Supports `docs/agents/workspace-context.md` §
"READ-BEFORE-WRITE STALENESS GUARD".
Read before widening, narrowing, or re-scoping the lost-update compare layer. Records the accepted residual risks and the identity/ordering hardening.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

Correction verified against the code on 2026-09-21, after this record was
written: the `read-before-write staleness guard` describe block has moved out of
`assistant-tools-write.integration.test.ts` into its own file,
`apps/desktop/src/__tests__/assistant-server/assistant-tools-write-staleness.integration.test.ts`.
The compare points now live in
`apps/desktop/src/assistant-server/file-mutation-tools.ts` rather than
`assistant-tools.ts`, still inside the per-file lock.

## Record

The compare layer of core 1.51's workspace `requireReadBeforeWrite` contract
(report R8), adopted **compare-only** — a settled scoping decision, do not
widen to core's stricter "refuse any overwrite without a prior read" layer
without revisiting the test surface that legitimately writes unread files.

- **Tracker:** `packages/agent/src/tools/file-read-state.ts` — pure in-memory
  map of `scope|canonicalAbsolutePath → last observed mtimeMs`, where scope is
  `runtimeData.memory.threadId` (sentinel `__no-thread__` without one). One
  thread's observations never vouch for another's. Ephemeral main-process run
  state (like the sibling `file-write-lock` map), NOT persistence — not a
  factory-reset surface. Bounded by LRU-on-write eviction
  (`FILE_READ_STATE_MAX_ENTRIES = 4096`), never unbounded.
- **Observations recorded:** content-bearing reads (`readWorkspaceFile`), the
  assistant's own successful `write`/`stringReplace` (post-write stat INSIDE
  the same lock — consecutive same-thread writes never self-trip), and a
  rename's destination. `delete`/rename-source FORGET their record so a later
  re-creation is new, not compared against a ghost. `findWorkspaceSymbol`
  deliberately does NOT record (snippets ≠ knowing the file).
- **Compare points (all INSIDE the per-file `withFileLock` critical section):**
  `write` stats the target before mutating; `stringReplace` compares against
  its own fresh under-lock read's mtime; `rename` compares the source's lstat.
  Mismatch → typed actionable refusal ("changed on disk since you last read
  it… re-read and retry") — same refuse-rather-than-guess posture as the
  string-replace ambiguity error. The model's recovery is always: re-read
  (records the fresh mtime), retry.
- **Exemptions:** files this scope never observed (compare-only contract);
  brand-new files (nothing recorded); an observed file that VANISHED from disk
  (recreating it loses nothing — the stale record is dropped and the write
  proceeds).
- **Identity + ordering rules (review-hardened):** the read tool's read+record
  runs INSIDE the same per-file lock as the writes, so a racing read can never
  clobber a fresh own-write observation back to a stale value. Reads record
  under the realpath'd TARGET, so rename compares a symlink source via the
  target's key + stat (a dangling link has nothing to compare); a symlink
  rename moves only the link, so the target's observation stays valid and no
  destination record is made.
- **Accepted residual risks:** mtimeMs equality can miss a sub-timestamp-
  granularity external edit on coarse-mtime filesystems (FAT/some network
  mounts — APFS/ext4/NTFS are fine); and a checkpoint REVERT writes outside
  these tools, so a thread's next edit to a reverted file may hit one refusal
  (arguably correct — its view IS stale) and recovers with the standard
  re-read. Both are deliberate: no polling, no fs watchers, one bounded
  refusal worst-case.
- **Paired tests:** `packages/agent/src/__tests__/file-read-state.spec.ts`
  (state semantics) + the `read-before-write staleness guard` describe block in
  `apps/desktop/src/__tests__/assistant-server/assistant-tools-write.integration.test.ts`
  (real-fs refuse/recover behavior, `utimes`-forced external edits).


