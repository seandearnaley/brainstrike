# Coordinator ruling on Task 1's Step 1 (verbatim)

Coordinator ruling on the block — good escalation, the file is genuinely phantom (drafted against an imagined
mocked seam). Decision: **port Task 1's Step 1-2 into the real integration suite; do NOT create a mocked unit
file.** The repo's convention is that worktree-service behavior is tested against real git + PGlite, and
`apps/desktop/src/__tests__/assistant-server/worktree-service.shared.ts` already exports the fixture kit the brief
imagined: `createTestWorkspace()`, `buildTestService()`, `asLedgerDatabase()`, `git(cwd, args)`.

Concretely:
1. Steps 1-2 (RED): write the brief's two test cases in `worktree-service.integration.test.ts` using the shared
   helpers — a real repo whose MAIN worktree must surface `primary: true`, realpath'd `repoCommonDir` (assert it
   equals the realpath of `<repo>/.git` via the same normalization the suite already uses), `createdAt: null` for a
   scanned-not-managed entry; and a managed worktree row whose entry carries `createdAt` from the ledger and
   `primary: false`. Keep every assertion value from the brief; only the fixture mechanics change (real git instead
   of `makeService({inventory})`). The RED run command becomes the integration lane:
   `pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-service.integration.test.ts`
   (or the package's `test:integration` filtered to that file).
2. The picker-side primary-gate test (brief's use-worktree-mode.test.ts case) is unchanged — that file exists.
3. Steps 3-5 (type + service changes) unchanged; the brief's note about compiler-enumerated literal sites still
   applies except the fixture-factory site is the integration suite's builders (wherever WorktreeListEntry
   literals/factories live — let the compiler enumerate, per the brief).
4. A plan-doc correction commit has ALREADY been made on this branch (`79cebaca0`,
   `docs(BST-1392): correct Task 1 test lane to the integration suite`) — the plan document at
   `docs/superpowers/plans/2026-08-26-w5-worktree-map-and-agent-tools.md` now reflects this ruling and contains the
   ALREADY-WRITTEN exact test code for Steps 1-2 (search that file for
   "Task 1: `WorktreeListEntry` gains identity, age and the primary gate"). You do not need to invent the test
   code — copy it verbatim from the plan document's Task 1 section, which supersedes the task-1-brief.md's Step 1
   for the test-file target and RED run command only. Everything else in task-1-brief.md (Steps 3-8) is unchanged
   and still authoritative.
5. Then proceed: implement with this corrected framing. Gates run afterward by the calling process will include the
   desktop worktree-service INTEGRATION lane (not a unit lane) alongside everything originally specified.
