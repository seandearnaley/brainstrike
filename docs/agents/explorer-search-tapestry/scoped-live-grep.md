# Exact-file live grep candidate scope

Supports `explorer-search-tapestry.md` § "WORKSPACE WALK: IGNORE FILES ARE THE PRIMARY SIGNAL, THE POLICY IS THE FLOOR".

Exact `filePaths` scopes resolve only the requested files before the authoritative
JavaScript matcher. The excluded-path steering probe uses that same scope.
Root-wide ripgrep remains a candidate-only superset prefilter.

## BST-1893 — September 29, 2026

The thread audit's section 3 recorded approximately four-second prefilter timeouts
on already-scoped requests. Inspection at upstream main
`3189ae3998396712e71c4bbea91ee6cc79c1454b` found the exact allowlist applied after
the root ripgrep process or bounded JavaScript tree walk. The ripgrep resolution
cap protected selected candidates, but neither engine avoided unrelated scanning.

The RED fixture creates 50,001 real unrelated file entries as hard links across
100 subdirectories, with a
selected file in a later directory. Sorting real Dirent names stabilizes traversal.
The unchanged implementation missed the selected file at the root visit cap;
the corrected fixture failed the selected-path assertion. Test duration included
fixture cleanup and is not a search-call latency measurement.
Fixture setup and cleanup belong to integration hooks; no timeout was raised.
The timed RED call took 391.35ms and listed 102 directories while missing the
selected file. The matching GREEN call took 1.96ms and listed zero directories.
These local observations are diagnostic evidence, not timing thresholds.

The direct candidate path reports `js-files`, does no root enumeration or ripgrep
discovery, and uses the existing authoritative content matcher. It applies the
balanced file and ancestor-directory policy, never traverses symlinked parents,
allows only contained regular-file symlink targets, rejects lexical or canonical
`.git` paths, and checks hard ignores on both requested and canonical paths.
The optional excluded-path probe preserves its existing per-root candidate count
bound and caller cancellation. It reads the checked canonical target without
re-resolving a requested symlink after the hard-ignore verdict. Unreadable roots
stay independent.

Empty, missing and directory scopes produce no candidates. A selected file that
cannot be read or exceeds the bounded read size fails the live pass visibly through
the existing tool wrapper; it cannot claim a complete clean live miss. The global
candidate cap counts eligible requested files and retains the existing cap note.

The hybrid tool still preserves the index pass's own `scanLimited` flag, including
regex queries without an extractable indexed literal. A complete scoped live pass
does not claim that stale indexed coverage is complete.

Guards: `apps/desktop/src/__tests__/assistant-server/live-grep-scoped.integration.test.ts`
and the exact-file parser/projection case in `grep-search-hybrid.integration.test.ts`.
