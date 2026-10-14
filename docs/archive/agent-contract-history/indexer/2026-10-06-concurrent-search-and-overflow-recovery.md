# Search and progress during native indexing

Committed native rows remain searchable during ingestion with truthful partial
coverage. Atomic incomplete coverage observations tolerate ordinary writer
progress while fencing real authority and scan identity changes. Only a trusted
source overflow can release its physically settled incomplete manifest receipt
for the already queued full-root recovery.

## Incident and correction

BST-1974 / PR #3542: the user reported hybrid-search errors during indexing and
apparently stuck counts around 1,668 files. The supplied October 6 logs retained
an actual FSEvents dropped-events error and a native full-scan search refusal.
The assistant collection-list tool also used obsolete PG counts for the native
managed collection.

Meaningful failing controls reproduced three boundaries: continuous native
commits invalidating incomplete coverage reads; full-scan admission rejecting
otherwise valid native semantic/hybrid rows; and an actual overflow during final
manifest verification leaving workspace admission owned, preventing the queued
rescan. The latter exercises the real parent/child protocol, publication and
admission rather than declaring watcher recovery from a fake receipt.

The correction preserves all authority/profile/provider/metric checks, requires
actual vectors, joins every hybrid arm, and reports partial source/vector
coverage independently of result truncation. Ordinary unselected collections
keep their existing catalog statistics. Incomplete atomic reads exclude only
per-commit progress from their comparison; complete proofs retain mutation
fences. A typed, exact-scope overflow receipt crosses the utility boundary after
physical settlement and releases only that scan. Unexplained manifest mismatch,
storage, cancellation, publication and cleanup errors remain failures. No
automatic provider fallback, timeout extension or blanket retry was added.

## Verification

Separate overlapping groups passed: assistant66, workspace-search205, scoped
coverage33, desktop runtime/transport98, canonical runtime90. Desktop main/test
types and the canonical56-task desktop build passed. Independent source reviews
covered assistant/coverage and overflow/transport changes. These are not added
together into a fabricated full-suite total.

The frozen app was exercised through Chrome DevTools using only
`/Users/seandearnaley/Documents/GitHub/brainstrike`, MiniLM/WebGPU Q4/Balanced and
an isolated Agent Debug profile. Both workspace and retained collection reached
8,000 files, 65,374 chunks/vectors and zero missing. Initial and follow-up scope
passes completed; the popup settled at Ready with no active indexing work.
Across252 observations,193 numeric popup observations never decreased or reset;
no Blocked popup, captured renderer error/warning or structured application error
occurred.

Five actual assistant hybrid executions succeeded during incomplete source
coverage; a sixth succeeded after Ready. Each used100 real vector candidates and
100 FTS candidates fused into10 results. Native listEmbeddingSpaces reported the
real committed rows and explicit incomplete state. Only external model tool
selection used the existing localhost scripted provider; assistant tools,
embeddings, native SQL, UI and filesystem work were real. This does not prove
paid provider availability or model reasoning.

Harness defects are retained: initial staged selection mishandled replayed tool
messages and reached the existing100-step bound; its replacement recognized
replays and auxiliary title requests without restarting the app/index. One
diagnostic coverage request omitted required rootIds and was rejected before
query execution; the corrected explicit-scope request passed. Development Python
archive and main-process-health warnings and local-shim billing/title warnings
remain visible. This is not a warning-free or latency qualification.

Electron exited0, the dev renderer terminated143 and its canonical wrapper
exited1. The owned profile/listeners/processes were removed; the user profile was
not reset. Source hashes matched the frozen input before delivery. No fresh full
M2, Windows/Linux or all-model campaign is claimed.

Durable evidence: `/Users/seandearnaley/Documents/brainstrike-m2-completion-20261005/concurrent-index-search/`
contains LIVE-RESULT.json, completed-scopes.json, hybrid-results.json, screenshots,
raw logs, source/artifact hashes, harness disclosures, cleanup and retained
RED/GREEN/review records.
