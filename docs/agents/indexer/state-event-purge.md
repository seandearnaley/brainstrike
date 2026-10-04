# State-event purge foundation

Supports the state projection and purge rules in `../indexer.md`.

## Scope

BST-1923 requires derived blob counts and physical FTS removal. The previous
state foundation used a truth-reading test double without FTS. This change adds
an unwired production adapter to the existing native indexer process. Synthetic
committed events exercise it; application chat, history ingestion/retrieval and
legacy migration are outside this foundation.

Canonical file rows cannot represent run events without fabricated file/root
identities. Dedicated event rows, reference rows and FTS remain in the same
derived SQLite file and writer. Schema 6 refuses prior schemas with the existing
explicit rebuild policy and preserves their files. Persisted canonical state-root
identity prevents reopening the projection against a different truth source.

The writer rereads exact events rather than receiving cached event bodies.
Catch-up uses a separate durable contiguous cursor, because a purge can reindex
sequence 2 before sequence 1 was ever indexed. Using MAX(projected sequence)
would skip an earlier shared-blob reference and allow premature collection.
Thread-drop retains its returned hashes across a failed physical checkpoint.

FTS secure deletion and SQLite core secure deletion are distinct mechanisms;
both are required for physical removal. A checked TRUNCATE checkpoint uses a
nonblocking busy policy and restores the connection's prior timeout. A pinned
reader is reported directly, allowing the durable purge intent to remain open.
[SQLite FTS5 secure-delete](https://www.sqlite.org/fts5.html#the_secure_delete_configuration_option).

## Qualification

The first allocated local slot used pnpm 11.15.0 and its pinned Node 26.8.2 on
Mac arm64. `pnpm node --version` also performed the missing local dependency
installation; it reused all 1900 packages and rebuilt secure-fs-native. Its
existing nonfatal lefthook-install warnings remained visible. The first indexer
dependency build passed ten tasks and failed the indexer on a readonly-array
return annotation. Correcting that annotation allowed the scoped package build.

Tests were written before production edits. Three temporary production-source
mutations each reproduced a causal RED, with the original source restored between
controls: skipped reindex left one searchable event; disabled FTS secure deletion
left the secret in index.sqlite despite no MATCH/vocabulary hit; omitted
second-thread catch-up deleted a still-referenced blob. Builds succeeded for
each control. The complete restored suite then passed all seven cases in one
file in 2.38 seconds. Source comparison confirmed the restored original exactly.

Commands: `pnpm exec turbo run build --filter=@brainstrike/indexer... --concurrency=2`,
then scoped `pnpm --filter @brainstrike/indexer build` for the repair/controls,
and `pnpm --filter @brainstrike/indexer exec vitest run --config vitest.integration.config.mts __tests__/state-purge.integration.test.ts`
(the controls selected their affected case with `-t`). Logs are
`/tmp/bst1923-state-purge-{build,build-repair,red-reindex,red-fts,red-refcount,green}.log`,
with separate control build logs. No normal commit hooks or broad regression
ran in this initial slot. These
tests establish the unwired foundation, not application chat migration or Node
query-sandbox memory-accounting qualification.

The bounded independent static review of the 20-file draft was CLEAN. In the
final allocated slot, required Ultracite formatting passed after readonly,
optional-chain and constructor-complexity repairs. The acquisition conditional
was extracted into `StateEventStore.acquire` without changing its behavior.
Affected production/test type checks passed all 18 tasks; strict Effect checks
reported zero diagnostics for all 31 indexer and 18 SQLite-query files. The
metadata unit case and the collection-store schema/refusal case passed. The
two mechanically updated SQLite-query fixture suites used Electron 44.4.5 in
Node mode and passed all 32 cases after one additional vector-profile fixture
was changed from schema 5 to 6. The first run's explicit schema refusal and the
repaired run are retained in separate logs. Rejection assertions were preserved.
Final logs use `/tmp/bst1923-state-purge-final-*.log`; normal commit-hook results
are reported with the committed head. Linux and Windows qualification and exact
original M0 suite parity remain open.

CI is disabled due to cost; validation must run locally.

## Remaining A2 qualification: source checkpoint

The recovered original M0-A2 `test/i1-purge.test.ts` checks unique vector bytes
before purge and at purge resolution, then repeats the absence check after
completion. Its paused-pass case stops an asynchronous same-event-loop indexer
after reading truth and resumes that pass around purge. These are historical
acceptance sources, not current native results.

The current derived writer serializes its synchronous truth read, projection
transaction and response. It has no public acknowledgement between read and
commit. The strengthened `state-purge.integration.test.ts` therefore starts
with three committed, unprojected events and admits real public catch-up in two
orders: before purge, and from the existing `purgeAfterTruth` seam before reindex.
Both cases join catch-up and purge, check the purge boundary, then perform a
later catch-up and check again. They preserve both neighbors and inspect truth
payloads, projected payloads, FTS/vocabulary, blob references and all physical
owned files. Existing interrupted-cleanup and pinned-reader cases retain their
persisted-intent checks. This qualifies the current serialized protocol; it
does not claim observation of the original internal stale-read pause.

The canonical deletion case in `indexer.integration.test.ts` uses the existing
recorded hidden-renderer MiniLM fixture and its complete producer profile. It
positively locates both stored Float32 and native binary bytes before removal,
then scans the entire owned directory at the public `removeFile` acknowledgement,
including DB freelist pages, WAL and journals, without an intervening write,
checkpoint, close or reopen. It checks an unrelated vector remains byte-identical
and searchable. That neighbor uses the existing synthetic query solely as a
storage-retention control; it is not another recorded inference result.

This maps the original A2 physical-vector obligation onto the shared native
canonical vector storage/deletion mechanism. State-event vectors are not wired
in this foundation, so this does not establish event-to-vector linkage or complete
original-suite parity. No production deletion fix is included before the native
qualification exposes an actual retained-byte failure.

At the initial source checkpoint, execution was **unrun** because another owner held
the native slot. Schema-8 fixture configuration and current-version event shapes
are reused unchanged from PR #3512, merged at
`b8323d3d5132dfdddd73e0b2a07afc0ed11b014f`. The qualification branch is now
aligned with that actual integration base; its prepared test bytes are unchanged. The allocated run uses the established qualified runtime
and package integration config, selects all purge cases plus the recorded-vector
persistence and physical canonical-removal cases, and retains any initial RED
without adding speculative checkpoints or vacuuming every write.

### First allocated native attempt

On the aligned schema-8 base, the focused public build passed all eleven tasks
(ten cache hits and a fresh indexer build). Types first rejected two dictionary
property accesses in the new neighbor assertions. Changing only those accesses
to bracket notation cleared the complete production/test type programs and
strict Effect diagnostics for all 39 indexer files.

The native purge run passed seven of eight cases: physical purge, interrupted
intent replay, same-thread and second-thread reference retention, catch-up
admitted after truth purge, pinned-reader replay and thread deletion/reset. The
before-purge catch-up case failed with `IndexerError: no such table: run_events`.
Its fixture had already read committed sequences 1, 2 and 3 from truth and
verified that projection/cursor rows were absent. The precise cause remains
unresolved; the test must not be made green by silently priming the derived
reader or weakening the ordering.

The separate recorded-vector persistence case passed. Physical canonical
removal failed at its first byte-absence assertion: the complete recorded
Float32 pattern remained only in `index.sqlite-wal` at the public ACK. The
before-delete Float32/binary presence controls, actual recorded-float equality
and distinct-neighbor controls had passed. Binary absence and post-delete
neighbor assertions were unrun because the first assertion threw. The normal
fixture cleanup removed the temporary database; the exact failure output,
file classification and source are retained in `/tmp/bst1923-a2-*-native.log`
and the source freeze. No production remedy, benchmark or native rerun was
attempted.

The smallest WAL remedy to evaluate is a checked, nonblocking TRUNCATE boundary
after explicit canonical removal, using the existing owned-writer checkpoint
semantics and preserving retry when rows have already been deleted. Its added
cost is synchronization/truncation of the owned WAL at deletion, including any
unrelated committed frames; pinned readers must refuse visibly. It does not
require checkpoints on ordinary publication or a blanket VACUUM. The binary
shadow-storage and post-delete retention checks still need their actual result
after this causal correction is approved.

### Explicit vector-purge candidate: pre-native source checkpoint

The allocated RED above exercised ordinary `removeFile`, whose public contract
was logical deletion. The accepted correction adds a separate `PurgeIndexerPort`
capability with `purgeFile`, leaving both ordinary and scoped publication-removal
behavior and cost unchanged. The operation enters the existing writer queue,
uses the same canonical/root authorization and adopted-file refusal, commits
logical removal, then requires the extracted existing checked TRUNCATE primitive.
A retry runs that primitive even if the prior transaction already removed every
row. State-event purge and thread-drop reuse the identical extracted checkpoint.

The recorded-vector qualification now targets this explicit promised boundary
in direct and pinned-reader/retry cases. It requires both Float32 and native
binary absence plus byte-identical unrelated-vector retention and searchability.
The pinned case verifies visible checkpoint refusal, committed logical deletion,
then release and retry with no remaining rows; a later idempotent retry must also
complete physical cleanup. These native cases are pending an execution slot.
The earlier WAL-only RED does not establish native binary shadow behavior.

The before-purge ordering failure remains preserved. Source inspection confirms
that its fixture waits for StateStore migration/append acknowledgements and reads
all three committed rows before admission. Append and purge do not drop or rename
`run_events`; the derived truth connection opens lazily, and truth purge can
checkpoint concurrently with that first read. The retained RPC failure does not
identify the exact native failure boundary. A cold-reader race is a diagnostic
possibility, not a proved cause. No reader priming, arbitrary delay, ordering
weakening or speculative production reader change is included.

The before-purge fixture had another concrete lifetime defect: `Promise.all`
rejected as soon as either admitted operation failed, allowing `finally` to close
the store/indexer while the other operation was still running. It now joins both
with `allSettled` and reports every independent failure before cleanup. This
corrects that demonstrated failure-path ownership issue without changing the
unprojected-work assertions or admission order. Whether it explains the original
missing-table failure remains unverified until the existing native case runs.

Pure qualification passed all six checkpoint cases. Replacing only incomplete
checkpoint refusal with silent success made all four refusal cases fail; exact
source restoration returned all six to GREEN. Formatting and whitespace checks
passed. Production/test source types and strict Effect diagnostics passed
(41 files) with a temporary source-bound test config. The canonical built-entry
test type command still reads the previous `dist/index.d.ts`, which lacks the
new explicit capability; public build/declaration verification is held for the
next allocated slot rather than bypassed or reported green. No native run,
installation, application launch or benchmark was started in this source slot.

### Allocated candidate qualification and scope correction

The candidate frozen as
`0a3f310213351d5481d23f941e25cfac9290cf92e9fd1814bc455eef4e0a96cd`
was then built and exercised with Node 26.8.2 / pnpm 11.15.0. The public dependency
build passed all eleven tasks (ten cached); the canonical production/test type
programs and strict Effect check passed with 41 files and zero diagnostics. This
cleared the earlier stale-declaration limitation.

All three selected vector cases passed: recorded hidden-renderer persistence,
direct explicit canonical purge, and pinned-reader refusal followed by release
and idempotent retry. Both complete recorded Float32 and native binary patterns
were absent at each successful purge acknowledgement, including the owned WAL;
the unrelated vector remained byte-identical and searchable. The pinned case
observed committed logical removal before checkpoint refusal, then successfully
retried with no remaining rows. These results qualify the canonical vector
payload boundary, not state-event vector linkage or complete original M0 parity.

Independent review identified an overbroad workspace-file erasure description.
Canonical BM25 and trigram FTS5 initialization has delete triggers but does not
enable FTS5 `secure-delete`. SQLite documents that ordinary FTS5 deletion can
retain old token entries until a later merge, and that core `secure_delete` alone
does not scrub all virtual-table shadow storage. The contract and API wording
therefore promise physical canonical Float32/native binary payload and WAL
erasure only. Canonical file rows and FTS entries are deleted logically;
historical FTS token physical erasure is outside this claim. State-event FTS
already enables its separate secure-delete option. No FTS configuration,
checkpoint/retry logic, authorization guard or ordinary removal cost changed in
this wording correction.
[SQLite FTS5 secure-delete](https://www.sqlite.org/fts5.html#the_secure_delete_configuration_option),
[SQLite core secure-delete](https://www.sqlite.org/pragma.html#pragma_secure_delete).

The other seven state protections passed in one focused run: physical
truth/derived-FTS/blob removal, failed-intent replay, same-thread and second-thread
references, meaningful catch-up admitted after truth purge, pinned-reader retry,
and thread deletion/reset. Their test bodies remained byte-identical to the
initial native checkpoint.

The before-purge case ran once with a temporary post-failure observation in the
truth reader and remained RED. Its original `watermark` query failed at
`Database.prepare` with `SQLITE_ERROR: no such table: run_events`. The connection
was readonly and its database name/list matched the fixture's expected canonical
`state.db` path. The observation reported WAL mode, SQLite 3.53.4, user/schema
versions 0, no `run_events`/`purge_intent` tables, a 4096-byte main file and a
zero-byte WAL. Before admission the fixture had already awaited migration and
three committed append acknowledgements, read sequences 1–3 through the truth
writer, and verified an empty derived projection/cursor.

The observation preserved the original query and error, ran only after failure,
and added no priming, waits or retries. Its source was restored byte-exactly and
the original public build restored afterward. Joining both admitted operations
with `allSettled` corrected early fixture cleanup, but did not resolve this
failure. The snapshot is post-failure and does not establish the writer's
simultaneous inode/schema view or whether the reader held a stale WAL/schema
view during checkpoint. Source confirms migration commits precede readiness,
and append/purge never drop or rename `run_events`. The exact cause of the
uninitialized reader view remains open; neither an initialization checkpoint nor
a reader-lifetime change is justified as a proven correction by this evidence.
The before-purge test remains failing and A2 qualification remains incomplete.

Local evidence is retained in `/tmp/bst1923-a2-remedy-native-build.log`,
`/tmp/bst1923-a2-remedy-native-types.log`,
`/tmp/bst1923-a2-remedy-vector-native.log`,
`/tmp/bst1923-a2-remedy-state-protections.log` and
`/tmp/bst1923-a2-before-purge-diagnostic-native.log`; the temporary diagnostic
patch and restoration manifest are under
`/tmp/bst1923-a2-before-purge-diagnostic/`. The final release record
`/tmp/bst1923-a2-remedy-native-release.json` records all 24 observed process IDs
exited, no remaining worktree owners/listeners, diagnostic source/public build
restored, and the heavy slot released. The wording-only follow-up runs no tests,
builds, compilers, native diagnostics or installation while another owner holds
that slot.

### Source-only raw-observation correction

A fresh independent review identified a concrete fixture defect in `byteFiles`:
the test process used raw `readFileSync` on live truth DB/WAL/SHM files while
StateStore's SQLite writer owned connections in another thread of that same
process. SQLite documents that closing a raw descriptor can release that
process's SQLite locks, including locks held by another thread. A worker thread
does not isolate that hazard. This explains why the scanner is invalid; it does
not yet prove the cause of the observed blank-schema failure.
[SQLite POSIX close locking hazard](https://www.sqlite.org/howtocorrupt.html#posix_close_bug).

The test helper now launches a fresh Node process with `execFile`. Only that
child enumerates and reads file bytes and matches the needle; it returns matching
filenames as validated JSON. The needle travels through stdin, and no file bytes
are returned or logged. The parent waits for the child termination callback,
propagates process/input/parse failures and imposes explicit timeout/output bounds.
All existing byte-presence and byte-absence assertions await the observation;
the original matching and directory coverage are unchanged. Canonical vector
tests and all production code remain untouched.

The original broken scanner and a variant moving only the unprojected fixture's
pre-admission positive observation into the fresh process are preserved in the
source freeze for a decisive allocated experiment. That experiment must first
reproduce the original before-purge RED, then exercise the isolated pre-admission
variant with the same cold truth reader, three committed/unprojected rows and
catch-up-before-purge order. If the corrected case still fails, retain the failure
and stop. Only a successful causal experiment proceeds to all affected purge
cases with the fully isolated helper, including neighbor/no-resurrection,
references and pinned-reader retry. No priming, read retry, wait, production
checkpoint or executable qualification is included in this source checkpoint.

The attached checkout disappeared after the prior freeze. Recovery inspected
the retained branch/ref and worktree metadata, then recreated the same isolated
checkout at the original `b8323d3d5132dfdddd73e0b2a07afc0ed11b014f` head and applied
the frozen patch. All twelve approved `98214eb1` file hashes matched before the
fixture edits. No shared branch, dependency installation or unrelated worktree
was changed.

### Allocated scanner experiment: RED then GREEN

The independently reviewed source freeze
`1a71528d102c584e22671a941784e547f0d186ec9c3cb85b44bf4e410421920f`
was qualified in the next allocated local slot. A frozen install reused all 1900
packages with no package downloads and the public dependency build passed all
eleven tasks. The runtime remained Node 26.8.2 / pnpm 11.15.0 on Mac arm64, with
better-sqlite3 13.0.3, SQLite 3.53.4 and sqlite-vec 0.1.9; the lockfile remained
byte-identical to the integration base.

This run used a fresh original-scanner control, not reused historical RED output.
Restoring its exact preserved test source reproduced `IndexerError: no such
table: run_events` in the before-purge case. The variant moving only the
unprojected fixture's positive pre-admission byte observation into a fresh process
then passed that same case. Both variants retained the cold truth reader, three
committed rows, empty derived projection/cursor, assertions and admission order.
This controlled result supports the invalid same-process raw close as the cause
of the fixture failure without changing production readers or persistence.

The fully isolated reviewed helper was restored with all thirteen frozen file
hashes matching. All eight state purge cases then passed together, including the
before/after truth ordering, no resurrection and retained neighbors, same-/second-
thread references, physical truth/FTS/blob absence, failed-intent replay, pinned
reader retry and deletion/reset. Production/test types and strict Effect
diagnostics passed for all 42 files with zero errors, warnings or messages.

Formatting found two line wraps in the new helper/test. Applying only those wraps
made the final formatting check pass; their exact delta has no executable change,
so the native cases and type checks were not repeated. Whitespace checks passed.
The prior three vector cases remain existing qualified evidence, explicitly
reused rather than newly executed: their production/test bytes, frozen dependency
graph and runtime versions are unchanged. These results still do not establish
state-event vector linkage, cross-platform qualification or complete original M0
suite equivalence.

Evidence is retained in `/tmp/bst1923-a2-scanner-install.log`,
`/tmp/bst1923-a2-scanner-public-build.log`,
`/tmp/bst1923-a2-scanner-original-red.log`,
`/tmp/bst1923-a2-scanner-pre-admission-experiment.log`,
`/tmp/bst1923-a2-scanner-final-state-green.log`,
`/tmp/bst1923-a2-scanner-final-types.log` and
`/tmp/bst1923-a2-scanner-final-biome-green.log`. Runtime/native provenance is in
`/tmp/bst1923-a2-scanner-runtime-proof-final.log`; two earlier disposable
provenance-probe attempts hit package metadata export restrictions, with their
failures retained separately. They changed no production or test source.
Normal hooks and publication remain a separately coordinated step; no hosted CI
or review was triggered.

### Integration delivery composition

Delivery composes the qualified `9368cfbd` candidate onto
`e19cd3020316125c69b2b9823d4ee0fdd2790b76`, which includes the A1 qualification
and scoped coverage-batch changes. The three-way composition was clean: no
manual conflict resolution or purge/scanner behavior changes. In the overlapping
indexer API/process/transport files and contract, it retains the upstream
coverage-batch method, route and documentation alongside the reviewed purge
capability. Every other qualified file remained byte-identical before this
delivery evidence append.

The composed public dependency build passed all eleven tasks (ten cached).
Production/test types and strict Effect checks passed for all 43 files with zero
errors, warnings or messages. All eight state purge cases and all three recorded
vector persistence/direct-purge/pinned-retry cases were freshly executed and
passed on this composed source. The earlier original-scanner RED and isolated
pre-admission GREEN remain the retained causal controls; they were not repeated.
No A1 measurements, performance tests or hosted CI/review were rerun.

Validation and normal hook jobs use `pnpm_config_verify_deps_before_run=error`;
the installed pnpm 11.15.0 code applies that environment setting to the effective
run guard. Direct validation commands also set `--config.verifyDepsBeforeRun=error`.
No automatic workspace installation is allowed in this delivery lane. Logs are
`/tmp/bst1923-a2-delivery-composed-{build,types,state,vector}.log`; the exact
composition proof is `/tmp/bst1923-a2-composition-proof.json`. Commit, hook and PR
head/tree receipts are retained with the final delivery manifest. BST-1923 stays
In Progress until reviewed delivery merges and acceptance is complete; application
chat wiring remains outside this foundation.

CI is disabled due to cost; validation must run locally.
