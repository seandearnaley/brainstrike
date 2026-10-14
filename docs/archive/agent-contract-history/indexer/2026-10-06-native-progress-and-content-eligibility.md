# Native progress and source eligibility

Native status uses the acknowledged SQLite coverage snapshot. Routine observation
invalidation retains that snapshot only for the same collection, root, store and
embedding profile. Missing user choices are setup state; actual failures remain
visible. Unsupported filesystem content is an explicit per-file exclusion, not a
reason to abort unrelated indexing.

## Incident and correction

Sean reproduced flashing errors and counts reverting to zero while indexing the
Brainstrike repository with local MiniLM, WebGPU Q4 and Balanced policy. A live
Chrome DevTools run on the preceding M2 head reproduced both symptoms and a fatal
null-byte-content error. The native progress surface was also consuming obsolete
PGlite statistics. Old nested `.muse/worktrees` copies escaped the existing shared
copied-worktree exclusion policy.

The correction keeps one native statistics owner, preserves acknowledged counts
through normal invalidation, scopes retained state to its actual identity, and
uses explicit setup/preparing phases. Native UI does not invent queue or worker
lifecycle values that its API does not provide. Web observers retain their
existing behavior. Typed content exclusions preserve file/path/reason receipts;
I/O, parser, authorization, cancellation and retained-collection validation errors
remain failures. The shared policy now excludes nested Muse worktrees alongside
the existing Claude and Brainstrike copies, while a directly opened worktree
continues to index normally.

The corrected full-repository receipt explicitly excluded
`docs/superpowers/plans/2026-08-22-w2-thread-list.md` for null-byte content. The
unsupported file was recorded rather than converted to an empty document.

## Verification boundary

Meaningful RED/GREEN controls cover setup classification, malformed settings,
atomic observation invalidation, identity changes, fatal-error persistence,
unsupported content, exact managed identity removal and copied-worktree policy.
Canonical ingestion: 101 tests. Shared policy: 22 tests. Parcel watcher: 39 tests.
UI/provider/coordinator focused coverage and desktop boundary tests also passed;
overlapping reruns are not added to a synthetic suite total. Desktop main, test
and E2E TypeScript programs and Effect diagnostics passed. Independent source
reviews cover the producer, UI and desktop changes.

Live exact-repository verification is recorded in the existing M2 PR #3542 and
BST-1974. Durable local evidence is in
`/Users/seandearnaley/Documents/brainstrike-m2-completion-20261005/indexing-live-debug/`.
Historical RED is retained separately from corrected execution. This change does
not claim fresh full-milestone, Windows/Linux, or every-model qualification.

## Actual repository run

On October 6 the canonical Agent Debug app, observed through Chrome DevTools,
indexed the only mounted root `/Users/seandearnaley/Documents/GitHub/brainstrike`
with the user's MiniLM/WebGPU Q4/Balanced settings. Final independent workspace
and collection coverage each contained 7,994 files, 65,338 chunks and vectors,
and zero missing vectors, with both scans complete. Across 311 observations,
displayed positive counts never decreased and no Blocked state appeared.
Captured scan renderer warnings/errors and main error logs were zero. The
catalog reconciliation pass completed; the UI settled at Ready.

A visible renderer reload retained identical coverage, identities and Ready
state. The strict zero-console assertion failed on Electron's standard development
CSP warning; the functional equality assertions passed. It was not suppressed or
rerun. Development Python-archive/module-type and main-process-health warnings
remain disclosed in the raw logs; this is not a warning-free or performance claim.
The app was quit normally, its canonical temporary profile was removed, and no
profile-scoped Electron process survived. No user profile was reset or replaced.
