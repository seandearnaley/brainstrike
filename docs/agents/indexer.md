# Derived desktop indexer

### Process ownership

- Keep `@brainstrike/indexer` Node-only and independent of product cutover. Use its Promise-based `IndexerPort`; inference stays in the hidden renderer host.
- Desktop main must explicitly launch Electron `utilityProcess` after app readiness; standalone Node uses Node IPC. Share the process core and writer worker without transport detection or child-process fallback. Keep immutable database/root acquisition authority on the lifecycle owner; read active persisted embedding identity through the owned port.
- Require caller-provided finite positive startup, request, close and exit deadlines. On terminal failure reject pending work, check termination acknowledgement, and join the transport exit event. Retain a failed cleanup owner and expose explicit retry; never relaunch over a live owner.
- Keep one writer worker and a separate read-only, query-only connection in the index process. Join writer/process completion on close; reject pending work on process failure.

Evidence: `indexer/2026-10-02-independent-package.md`, `indexer/2026-10-02-electron-utility.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`, `packages/indexer/__tests__/lifecycle.integration.test.ts`, `apps/desktop/src/__tests__/indexer-utility.integration.test.ts`.

### Isolated native coverage

- Desktop activation supplies the isolated coverage wrapper to public reads and canonical publication. Keep full-profile coverage off the canonical utility loop; standalone owner APIs retain their explicit existing behavior.
- Capture acknowledged bindings/scopes and the utility's actual revision, persisted epoch and store in the cheap authority RPC. Bound trusted authority messages to 32 MiB; generic SQL budgets remain separate.
- Use the existing killable query owner in coverage-only mode with a read-only/query-only native better-sqlite3 reader. Reuse full batch validation once per selected profile in one fresh owned transaction; retain stored membership, Float32, coarse and corruption checks. Never cache validation across reads or derive revision from a new authority object's default.
- Close and physically join the read host before releasing the caller's read lease; reset and shutdown join the same registered acquisitions/owners and retain failed cleanup for retry. Preserve native five-second read semantics and generic SQL deadlines.
- Translate authority drift to observation invalidation only after a current utility snapshot demonstrates the change. Preserve forged membership, corruption, schema, protocol and cleanup failures as fatal errors.

Evidence: `indexer/2026-10-04-isolated-native-coverage.md`.
Guard: `apps/desktop/src/__tests__/coverage-rpc-ordering.integration.test.ts`, `sqlite-query-host-manager.test.ts`, `packages/indexer/__tests__/coverage-file-lookup.integration.test.ts`, `packages/sqlite-query/src/__tests__/host-core.test.ts`, `client-cancellation.test.ts`.

### Profile and incremental identity

- Reuse the canonical metadata raw-row decoder for other SQLite drivers, inside the caller's owned read snapshot; it validates schema/store/profile/hash without constructing an engine.
- Keep a persisted store ID independent of explicit embedding state (`text-only` or `vector-configured`). New text acquisition requires no model/profile. Explicit `open-existing` validates stored identity inside the utility and refuses missing/corrupt/schema-invalid stores without creating or downgrading them.
- Configure a text store's first complete vector profile only through the writer's atomic `configureVectorProfile`; retain text/graph/store ID and roll back the entire transition on failure. Same profile is idempotent; different configured profile refuses rebuild-required. All vector APIs reject unconfigured stores; invalidate prepared plans across the transition.
- Validate the complete producer profile at commit and vector search: model ID, immutable revision, dtype, dimensions and token cap. Hash every field; the initial vector schema is 384 dimensions.
- Refuse profile/schema mismatches with `rebuild-required` and preserve the existing file. Never erase databases during startup.
- Canonical producers must prepare with explicit `providedChunks`, preserving the existing parser/chunker output and its source offsets, indices, token/type/size metadata. Validate hashes and source spans with the canonical matcher; reject invalid or mixed policy inputs without re-splitting, relocation or a second parse. Keep line-policy producer metadata explicitly null.
- Persist all canonical source metadata; preserve vector bytes when only that metadata changes. Derived schema8 must refuse prior schema versions with rebuild-required, never silently migrate or wipe.
- Prepare deterministic, byte-preserving line chunks from an authorized root-relative snapshot and explicit chunk-line policy. Reject stale snapshot plans; reuse a vector only when its stable chunk ID and content/profile hash agree.

Evidence: `indexer/2026-10-02-independent-package.md`.
Evidence: `indexer/2026-10-03-canonical-provided-chunks.md`.
Evidence: `indexer/2026-10-04-coverage-file-lookup.md`.
Guard: `packages/indexer/__tests__/metadata.test.ts`, `packages/indexer/__tests__/chunks.test.ts`, `packages/indexer/__tests__/indexer.integration.test.ts`, `packages/indexer/__tests__/provided-chunks.integration.test.ts`, `packages/chunking-worker/src/__tests__/source-range-validation.test.ts`.

### Explicit write policy

- Make text-only writes explicit with `commitTextFile({plan, syntax?})`; reject embedding payloads on this path. Accept explicit text-only stores and preserve a configured store's existing profile/vectors, without invoking inference or inventing a model default.
- Text replacement preserves vectors only for unchanged chunk/content/profile identity and deletes stale vectors for changed or removed chunks. Persist explicit per-chunk vector presence and verify it against real vec rows on reopen, including orphan rejection. Missing vectors remain absent; vector search only returns actual vector rows. Strict `commitFile` continues to require every missing vector exactly once, including unchanged files explicitly opted into vector backfill. Backfill retains unchanged canonical graph metadata.

Evidence: `indexer/2026-10-03-explicit-text-commits.md`.
Evidence: `indexer/2026-10-03-independent-text-identity.md`.
Guard: `packages/indexer/__tests__/text-store.integration.test.ts`, `packages/indexer/__tests__/text-commit.integration.test.ts`, `apps/desktop/src/__tests__/fixtures/indexer-utility-proof.ts`.

### Explicit vector payload purge

- Keep ordinary `removeFile` and scoped publication removal logical. Expose physical erasure of canonical Float32 and native binary vector payloads through the separate `PurgeIndexerPort.purgeFile` capability on the same authorized writer and existing canonical identities, including their retained bytes in the owned WAL.
- After the purge transaction, require a checked nonblocking TRUNCATE checkpoint before acknowledging. Report pinned-reader failure visibly and run the checkpoint again on idempotent retry even when rows are already gone. Preserve unrelated vectors; do not checkpoint ordinary publication or infer state-event vector linkage.
- Delete canonical file rows and their BM25/trigram FTS entries transactionally. Those deletions are logical: historical FTS tokens may remain in shadow tables because canonical FTS5 secure-delete is not enabled. Their physical erasure is outside this vector-payload claim; `purgeFile` does not promise full workspace-text erasure.

Evidence: `indexer/state-event-purge.md`.
Guard: `packages/indexer/__tests__/checked-checkpoint.test.ts`, `packages/indexer/__tests__/indexer.integration.test.ts`.

### Retrieval and root authority

- Pin the native boundary to sqlite-vec 0.1.9. Keep external-content FTS5 BM25 (`porter unicode61`) and trigram indexes synchronized transactionally with file chunks.
- Restrict requests to roots authorized when the host opened the index. Query each root's vec0 `root_id TEXT PARTITION KEY` before coarse top100 selection and rescore its auxiliary Float32 embeddings by exact cosine distance.
- Preserve empty-root results and reject unauthorized roots; never substitute unrestricted retrieval. Do not perform Node inference or silently fuse a different search mode.
- Report actual per-authorized-root file/chunk/vector/missing counts with the stable store ID and explicit stored embedding state. Verify declared vector presence against real rows before returning coverage. Complete vector coverage requires every requested root to have nonempty chunks and all their vectors; it does not establish complete source scans.
- Keep source-scan readiness a separate canonical producer receipt. Engine readiness and counts never imply a complete authorized corpus. Preserve candidate/scan/result truncation flags; lexical one-extra-row peeks and vector top100 availability checks must not alter selected candidate ranks.

Evidence: `indexer/2026-10-02-independent-package.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`.
Evidence: `indexer/2026-10-03-coverage-runtime-bridge.md`.
Guard: `packages/indexer/__tests__/coverage.integration.test.ts`.

### Canonical collection scope and vector profiles

- Keep the additive `ScopedIndexerPort` separate from retained workspace APIs. Main supplies exact PG-authorized file bindings and workspace/collection selectors; never expose binding replacement to renderer input. Retain canonical file IDs, scalar embedding-set membership and nullable workspace/path metadata, including when adopting an existing workspace file. Rootless files have no workspace-relative path. Legacy publication refuses adopted scoped files.
- Replace owner bindings before forwarding writes; invalidate prepared plans on every replacement/removal intent and writer restart. Match each snapshot/profile to the current binding and refuse changed ownership until explicit derived removal/republication. Search scopes union canonical file IDs before ranking; empty scopes or explicit empty file IDs match nothing.
- Keep the profile registry and Float32 source vectors keyed by complete provider/model/dimensions/distance plus defined local revision/dtype/token-cap. Preserve other profiles' vectors through selection changes and unchanged TEXT publication. Refuse unsupported distance/dimensions visibly; saved catalog choices remain authoritative.
- Query dimension-specific sqlite-vec 0.1.9 binary tables with full profile partition and authorized vector IDs before top100; rerank only those candidates using the collection's exact cosine, L2 or negative inner-product metric. Preserve original Float32 dimensions; zero padding applies only to the derived binary candidate index. Validate registry/vector/coarse-row integrity on reopen. Factory reset joins the same writer and destroys the same owned database files.
- Bind complete scope/authorization/file-filter lists through SQLite JSON tables with a fixed parameter count. Validate every selected binding and apply exact membership before lexical ranking or vector candidate selection; never truncate lists or combine independently ranked batches.
- Verify scoped source manifests against the full current trusted binding inventory and all native scope rows in one snapshot. Refuse partial declarations; compare exact file membership/source hashes and complete canonical chunk identities/hashes/metadata, including zero-chunk files and stale extra rows. Reuse the existing authority epoch/revision; main's full-scan receipt still owns readiness.
- Report scoped coverage only for the explicit current full profile and actual authorized file/chunk/source/coarse rows. TEXT carries null profile and counts no cached other-profile vectors. Empty scopes and missing canonical files cannot claim vector completeness; coverage alone never proves source completeness.
- Batch scoped coverage in one owned SQLite read snapshot, freshly validating each distinct canonical binding and complete profile once inside that transaction. Mark bindings only after their stored validation succeeds. Preserve request order, per-scope authorization/profile checks, independent scope counters and all storage checks; singleton coverage delegates to the batch implementation. Never retain validation across transactions.
- Index chunk lookup by canonical file ID for both workspace and collection coverage. Recompute counts inside the existing read snapshot and retain all authority, binding, profile and storage-integrity checks on every call.
- Scan stored little-endian Float32 values directly over each blob's actual byte span on every integrity read. Preserve dimension/length, finite and nonzero checks; do not copy/re-encode vectors or cache integrity across reads.
- Production scoped snapshots carry canonical provided chunks. Explicit line-policy fixtures retain the existing foundation input; there is no production parser fallback. Scoped profile storage qualification does not qualify model inference or retrieval quality.
- Skip a scoped chunk UPSERT only when its actual stored row exactly matches every canonical field and scoped flag in the current write transaction. Preserve legacy adoption, missing-profile vector insertion, authority fences and normal publication acknowledgements.

Evidence: `indexer/2026-10-03-collection-profile-storage.md`.
Guard: `packages/indexer/__tests__/collection-scopes.integration.test.ts`, `packages/indexer/__tests__/scoped-electron.integration.test.ts`, `packages/indexer/__tests__/large-scopes.integration.test.ts`.
Evidence: `indexer/2026-10-03-scoped-source-proofs.md`.
Guard: `packages/indexer/__tests__/scoped-proofs.integration.test.ts`, `packages/indexer/__tests__/large-scopes.integration.test.ts`.
Guard: `packages/indexer/__tests__/coverage-file-lookup.integration.test.ts`.
Evidence: `indexer/2026-10-04-coverage-batch-observation.md`.
Evidence: `indexer/2026-10-04-coverage-binding-validation.md`.
Guard: `packages/indexer/__tests__/scoped-coverage-batch.test.ts`, `apps/desktop/src/__tests__/native-scoped-search.test.ts`.
Evidence: `indexer/2026-10-04-stored-vector-byte-validation.md`.
Guard: `packages/indexer/__tests__/stored-vector-bytes.test.ts`, `packages/indexer/__tests__/scoped-proofs.integration.test.ts`.


### State projection and purge

- Acquire an explicit canonical truth root, persist its identity, and refuse a different root on reopen. Keep state-event rows and blob references separate from canonical file identities in the same derived database and writer worker.
- Read verified committed state events inside the serialized writer operation. Catch up to a captured watermark with a durable contiguous cursor; exact reindex rereads truth and never accepts caller-provided event bodies. Reject CRC/sequence gaps.
- Acquire state truth together with an explicit producer module and dev/prod mode. Import the canonical local module only in the writer; use the shared event upgrader without rewriting authoritative bytes. Persist module/mode identity and refuse a different projection on reopen. Missing or invalid schemas fail closed, never index raw JSON as a substitute.
- Project recognized text only. Preserve unknown prod events at their original sequence with explicit derived gap reasons; unknown dev events reject and remain observable through the foundation port's indexer health. Rebuild a state thread on the same serialized writer without deleting canonical file/profile data. Keep blob references based on verified truth, independent of text eligibility.
- Keep event FTS and reference rows transactional. Enable core and FTS secure deletion; complete a checked TRUNCATE checkpoint before purge or thread-drop acknowledges. A pinned reader refuses immediately and leaves the state-store purge intent for retry.
- Close the writer-owned truth reader on indexer shutdown. The state-store adapter resets through the same joined process destruction; do not add another derived database or chat writer.

Evidence: `indexer/state-event-purge.md`.
Guard: `packages/indexer/__tests__/state-purge.integration.test.ts`.
Evidence: `indexer/state-schema-parity.md`.
Guard: `packages/indexer/__tests__/state-projection.test.ts`, `state-schema.integration.test.ts`.

### Canonical syntax metadata

- Accept the existing parser's typed symbols/references alongside a file commit; do not add a parse pass. Keep composite `(file_record_id, seq)` identities and name-based references, with same-file `from_symbol_seq` foreign keys.
- Replace graph metadata in the same file/chunk/vector transaction. Reject invalid batches atomically. Omitted syntax retains graph metadata only for unchanged content; changed content clears stale metadata and reports `not-provided`.

Evidence: `indexer/2026-10-02-independent-package.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`.

### Canonical publication DTOs

- Share browser-safe producer DTOs through `@brainstrike/indexing-contract/indexer-producer`; keep process and database ownership outside that contract.
- Map existing canonical events through `@brainstrike/file-import/canonical-index-publication`. Preserve original source, chunk objects and same-parse graph identities; refuse foreign identities, skipped nonempty sources, incomplete source ranges and invalid graph references.
- Keep the payload independent of scope; workspace publication adds only supplied root/path authority. Rootless consumers must not invent a workspace. Keep the built public mapper loadable in plain Node without renderer globals or source aliases.
- Hash each consuming package's own source/tests and the external canonical recording in deterministic unit/coverage tasks. Declare default files explicitly alongside inherited inputs; build public artifacts before integration lanes that import them.

Evidence: `indexer/2026-10-03-publication-contract-prerequisite.md`.
Evidence: `indexer/2026-10-03-node-fixture-test-input.md`.
Guard: `packages/file-import/src/__tests__/canonical-index-publication.test.ts`, `packages/file-import/src/__tests__/canonical-public-node-entry.integration.test.ts`.

### Retained canonical ingestion

- Execute bounded registered-source TEXT scans through `CanonicalIngestionHost` and its explicit catalog/source/publication ports. Retain original source/hash/stat in the catalog before canonical publication; stamp completion only after joined publication, and remove native data before catalog invalidation.
- Hold scan admission until physical reads, parsing, publication, manifest completion and discovery retirement settle. Drain yielding iterator cleanup to terminal completion, discard cleanup yields, preserve primary and cleanup errors, and retain failed cleanup for explicit retry.
- Keep workspace/collection scope and actual canonical IDs explicit, with nullable root/path metadata for rootless collections. Keep operation signals local; TEXT must not resolve or invoke inference. Full readiness still requires the writer's complete canonical manifest receipt.

Evidence: `indexer/2026-10-03-retained-coordinator-delivery.md`.
Guard: `packages/canonical-ingestion/__tests__/host.test.ts`, `packages/canonical-ingestion/__tests__/public-node-entry.integration.test.ts`.

### Authoritative desktop catalog adapter

- Resolve catalog scope, profile and canonical identity through main-supplied current
  authority. Query actual PG source and collection membership; nullable retained
  root/path metadata must stay nullable and never confer a workspace grant.
- Prepare discovered original source in the existing managed-cache transaction
  policy, reusing the actual record ID or allocating a real UUID. Require the exact
  source hash and full trusted native-binding acknowledgement before parsing.
- Recheck authority, identity and source hash around awaited work and completion.
  Native removal must physically join before guarded canonical invalidation cancels
  matching jobs and deletes PG source. Cancellation retains ownership until admitted
  catalog work settles, and retained reads enforce their explicit byte bound.

Evidence: `indexer/2026-10-03-authoritative-catalog-delivery.md`.
Guard: `apps/desktop/src/__tests__/native-canonical-catalog.test.ts`,
`apps/desktop/src/__tests__/native-canonical-catalog.integration.test.ts`.

### Explicit canonical vector ingestion

- Bind canonical hosts to TEXT (the default) or explicit VECTOR. TEXT never resolves a profile or invokes inference; VECTOR requires the actual saved local profile, existing scoped writer plans and a physically joined inference port. Refuse unsupported profiles and unwired dependencies without publishing TEXT.
- Aggregate native plans' ordered missing chunks across files only within one authorized discovery batch/scope/profile/ticket, retaining the 1–64 transport bound and existing renderer token-budget/GPU limits. Preserve exact per-file routing and source-order commits; publish a file only after all its required vectors are validated. Recheck current full profile, preserve original source and nullable catalog identity, join inference/cancellation and native publication before PG completion, and retain failed joins/abort notices for explicit close retry.
- Require the full canonical scoped manifest plus current selected-profile coverage with matching store/scope/authority before finishing VECTOR scans. Counts and receipts alone are insufficient. The current public port cannot supply skipped-file canonical chunk inventory, so VECTOR rereads/parses source even on stat hits; covered chunks require no inference. TEXT keeps its stat shortcut.

Evidence: `indexer/2026-10-03-canonical-vector-pipeline.md`, `indexer/2026-10-04-cross-file-vector-batches.md`.
Guard: `packages/canonical-ingestion/__tests__/vector-host.test.ts`, `packages/canonical-ingestion/__tests__/vector-host.integration.test.ts`, `packages/canonical-ingestion/__tests__/workspace-runtime.test.ts`.

### Borrowed workspace source ingestion

- Run workspace discovery, bounded secure reads and the existing `WorkspaceIndexingCoordinator` in `CanonicalWorkspaceIngestionRuntime`; borrow narrow operations from the same main-owned pinned mount. Paths, root IDs and projections never acquire a new native root.
- Read discovered ignore files through that same lease under the scan byte bound, and reconcile newly ignored canonical files through the existing native-before-catalog removal path. Ignore scopes stop at the authorized mounted root; discovery never acquires parent-directory or global-config authority.
- Forward batches and health from the existing main Parcel producer. Promote native watch work to full affected-root metadata reconciliation, force changed file reads, and preserve unchanged native-covered stat skips; readiness still uses the complete writer manifest predicate.
- Join admitted listing/read/iterator/subscription work before releasing a borrow. Preserve failed unsubscribe ownership for explicit retry, including `ParcelWatchRetirementError.retire()` when late timed-out acquisition succeeds but cleanup fails. Rejected acquisition joins event work and reports startup errors without an unsubscribe retry owner. Borrow retirement never closes the shared mount.
- Borrow from the application's actual mounted-root registry with exact durable ID,
  mounted-object identity and generation fences before and after native operations.
  Root removal, replacement and registry disposal join borrows before closing mounts.

Evidence: `indexer/2026-10-03-borrowed-workspace-source.md`.
Guard: `packages/canonical-ingestion/__tests__/workspace-source.test.ts`, `packages/canonical-ingestion/__tests__/workspace-source-child.integration.test.ts`, `packages/file-system/src/__tests__/parcel-watch-retirement.test.ts`.
Evidence: `platform-contracts/2026-10-03-mounted-source-retirement.md`.
Guard: `apps/desktop/src/__tests__/ipc-domains/workspace-root-source-lease.test.ts`,
`apps/desktop/src/__tests__/ipc-domains/workspace-root-source-lease.integration.test.ts`.

### Canonical utility attachment

- Construct the public canonical workspace runtime or rootless host inside the same desktop indexer utility process. Reuse its existing parser/coordinator and engine writer; the indexer package remains product-independent.
- Main retains the actual catalog, publication, inventory, inference and pinned lease objects. Forward only bounded validated DTOs and explicit cancellation tokens through the desktop-private channel; owner/root/generation/path projections never acquire filesystem authority. Recheck the same actual lease object, root/generation/path and operation scope/file authority after awaited callbacks before accepting results or admitting downstream completion.
- Keep cancellation correlated until its remote operation physically settles. Normalize only an explicitly acknowledged owned cancellation; preserve independent failures and aggregate causes. Stop admission synchronously on close or deadline, join main-owned IO/watch retirement after remote exit, and retain failed cleanup for explicit `close()` retry before releasing the engine.
- Mark a correlated, validated non-cleanup request refused by its actual stopping owner as explicit owned cancellation. Preserve malformed, foreign-scope/capability, and admitted independent failures; only an already-aborted local operation may normalize that marker to its original reason.
- Retire only captured original capabilities when their live grant is revoked/replaced. Keep new-work fences strict; cleanup may finish only incomplete scan receipts. Attempt/join main cleanup even when child close rejects, retaining both failures and the owner for retry.
- Attach explicit VECTOR through the public profile, native prepare/commit/manifest/coverage and inference generate/cancel/join ports. Capture unique inference operation ownership before generation; join the original physical operation after cancellation or remote exit, preserve independent faults and failed retirement for retry, and reject unknown or reused operation IDs.
- Bound attachment acquisition, collection scan admission ACKs and short controls with the manager's caller-supplied deadlines. Reserve the exact scan and original runtime promise in the child before acknowledging admission; retain fast terminals until a matching join. Await an admitted full scan's authoritative receipt without a control-request deadline, and join its terminal before releasing the engine on close/retirement. Retain the original late-ACK join after a caller admission timeout; report independent late faults only after the active caller's bounded retirement join succeeds, before engine release, and retain cleanup for explicit retry. TEXT never resolves inference. Reject unsupported explicit modes before attachment; no VECTOR-to-TEXT downgrade.

Evidence: `indexer/2026-10-03-canonical-utility-attachment.md`, `indexer/2026-10-04-owned-admission-cancellation.md`.
Guard: `apps/desktop/src/__tests__/canonical-utility-channel.test.ts`, `apps/desktop/src/__tests__/canonical-utility-parent.test.ts`, `apps/desktop/src/__tests__/canonical-utility-manager.test.ts`, `apps/desktop/src/__tests__/canonical-utility-runtime.test.ts`, `apps/desktop/src/__tests__/canonical-utility-process.integration.test.ts`.

### Persistence and qualification

- Treat the database as derived state. Product cutover must register its owned path and call `destroy()` during factory reset before deleting roots; package `destroy()` joins pending writes and removes only its database/WAL/shared-memory files.
- Qualification retains the selected renderer intervals, long-task timestamps, time origins and named phase windows without filtering outliers. Same-corpus paused idle chat is an explicitly identified current reference, never historical loaded evidence; preserve the accepted frame/long-task/chat gates.
- Mark tests requiring actual native binaries/processes as `.integration.test.ts` and run them through the uncached integration task after building the public artifacts. Do not report these checks as full application or cross-platform acceptance.

Evidence: `indexer/2026-10-02-independent-package.md`, `indexer/2026-10-05-responsiveness-timeline.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`, `packages/indexer/turbo.json`, `apps/desktop/qualification/m2-native/renderer-timeline.test.mjs`, `apps/desktop/qualification/m2-native/native-benchmark.test.mjs`.

### Canonical scan manifests

- Compare the canonical scanner's complete eligible file manifest against native file IDs, root-relative paths and source hashes in one read snapshot. Authorize the requested root before reading its rows. Reject duplicate identities/paths, non-normalized paths and excess fields.
- Report missing, changed and unexpected files explicitly; equal row counts do not establish completeness. Empty manifests match only actually empty native roots. Manifest equality does not itself publish a full-scan receipt: the producer must also prove full scope, joined publication/removal and absence of aborts, errors or truncation.

Evidence: `indexer/2026-10-03-canonical-manifest.md`.
Guard: `packages/indexer/__tests__/manifest.integration.test.ts`.

### Main-owned production activation

- Native first-run settings use the same enabled model/provider catalog and verified runtime discovery as collection creation, and create collections through the canonical repository. Preserve each provider, model and exact dimensions; do not introduce an indexing-specific model allowlist. Never require a SQL-seeded collection, silently choose inference, mutate an existing collection's model, or reuse its execution plan after switching collections. Keep creation failures visible and preserve a newer user selection when creation settles late.
- Report missing native mode, collection and local execution choices (only for local/Transformers collections) as actionable setup requirements, not a missing root or a generic closed-admission error. The indexing status panel opens the Search & Indexing category directly.

Guard: `packages/settings-ui/src/__tests__/search-indexing-settings-section.test.tsx`, `packages/app-shell/src/background-indexing/__tests__/native-workspace-index-provider.test.tsx`, `packages/app-shell/src/__tests__/indexing-status-item.test.tsx`, `apps/desktop/e2e/workspace-index-bootstrap.desktop.test.ts`.

- Compose canonical workspace and retained collection ingestion in the sole main-owned indexer utility. Read actual saved collection/mode/full local execution choices and PG records, borrow the application's existing mounted-root leases, and preserve canonical file IDs and nullable rootless metadata. Missing or unsupported choices refuse activation visibly.
- Validate saved collection existence in PG for both modes. Load the complete retained inventory through the catalog's bounded batches, checking current authority and cancellation around each batch. Actual read acquisition reconciles changed PG inventory and invalidates affected receipts before returning native progress.
- Retire the desktop visible scanner/queue producer when the native capability exists. The visible provider restores actual root identity and observes scoped receipts/coverage; closing the visible window does not own source, parser, inference or writer lifetime. Keep the hosted web producer unchanged.
- Begin publication tickets before awaited native work. Any admitted write/removal invalidates all overlapping scope receipts; full completion joins admitted writes and verifies the full canonical manifest against the same unchanged authority/mutation revision. Watch degradation invalidates readiness and refuses reads until actual recovery reconciliation.
- Revalidate overlapping completed workspace receipts against their retained complete source manifest after collection publication; VECTOR also requires actual full selected-profile coverage at the same authority revision. Source invalidation discards that proof; a later mutation prevents held verification from restoring readiness.
- Return batch coverage with canonical readiness from one before/after fenced main observation. Retain each publication scope's scan generation and mutation revision in the internal authority fingerprint so invalidate/rescan cycles cannot restore an older proof. Benchmark completion consumes that batch status with both coverage results.
- Project historical distinct-file publication acknowledgements from the existing scan owner only after matching native commits resolve. Preserve owner/ticket/store/scope/profile identity and actual acknowledged authority/mutation stamps; preparation, admission, repeats, failures and aborts earn no progress. New scans clear their counters. These acknowledgements never imply current coverage or complete scans.
- Exclude publication progress and readiness observations from renderer query-execution identity. Keep held inference alive across those observations; actual store/scope/profile/query-plan/capability changes still retire it.
- Derive pending semantic availability from the current capability/collection/root scope during render. A completed availability result belongs only to its original scope; changing scope must never render stale enabled semantic controls while the next asynchronous check is pending.
- Qualification liveness pins each scope's first acknowledged owner/ticket and accepts only increasing acknowledged-file counts or fresh correlated coverage changes. Authority/mutation evolution alone earns no credit; changed owner/ticket fails visibly. Preserve the 200-second no-progress window and the full completion/performance predicates.
- Allow scoped read ownership while initial ingestion is pending, but report incomplete source receipts explicitly. Capture and recheck the full store/profile/authority/binding identity around every scoped search, coverage and killable grep read; reject foreign/stale hits. Main alone supplies explicit canonical grep file IDs, including actual nullable-root collection records.
- Own each scoped read through native result validation and physical grep disposal against the runtime's actual acknowledged binding inventory. Fence new reads before ordinary binding replacement or derived removal, drain admitted readers before mutating native authority, and retain failed cleanup admission until the original owner retires. Recheck live generation, grants, collection, full saved profile, query plan and store independently; pending PG discovery is the next native ACK.
- Keep saved Pause separate from Enabled. Cold-paused activation opens the actual authorized store/reader with incomplete source receipts and admits no canonical source, parser, watcher or document inference. Pause fences and joins source attachments, including held/failed acquisition, before acknowledging; retain the original read-authority borrow, writer/profile and unchanged complete proofs. Failed cleanup retains admission ownership for explicit retry. Resume uses the same saved canonical pipeline; paused catalog changes invalidate affected proofs and reconcile bindings without scheduling ingestion.
- Update the read-reuse binding identity at the successful native replacement ACK, before live-authority revalidation. If that revalidation rejects, retry must restore the exact requested inventory before reuse; failed replacement preserves the previous cache and cleanup ACK.
- Before same-scope binding replacement, join removal of IDs absent from the complete new catalog inventory under their original acknowledged writer/scope; invalidate their canonical plans and overlapping source proofs. Preserve surviving IDs and scope-switch retention. Failed or authority-drifted removal retains the old ACK and prevents cache reuse until explicit reconciliation succeeds.
- Fence invalidated file IDs for their current scan, including admitted TEXT/VECTOR commit acknowledgements and later writes. Clear that fence only when a new scan can begin after pending work joins; a returning ID must republish its actual native row.
- Track observed catalog inventory separately from complete publication proofs. Coalesce identical reads; queue newer inventory while a scan owns completion, gate affected readiness, and join before replacing bindings or invalidating the next inventory. Verify the latest inventory through the strict public host; preserve every scan/transport failure.
- Reserve collection admission before loading one complete inventory; reuse it for native bindings, source loading and every collection catalog ACK through physical scan and workspace reverify completion. Drain already-admitted workspace passes and binding ACKs first; fence later workspace publication/cache/removal before admission, and reject queued work on source retirement without releasing running or failed ownership early.
- Keep fixed RRF60 fusion over bounded native arms (100 per arm, final10), exact canonical metadata and truncation notices. Require complete actual receipts and selected-profile coverage for semantic execution. Query inference uses the main-resolved exact saved plan through the existing hidden renderer; TEXT never invokes inference and native unavailability never routes to PG search.
- Close admission synchronously, abort the owned graph, close admitted attachments before joining startup, then join late attachments, physical inference, borrowed roots and native readers before writer close/destroy/profile release. Retain independent cleanup failures and owners for explicit retry.
- Retire a generation's failure state only after its source/read/writer/profile ownership joins successfully, before replacement profile acquisition reopens runtime reads. Keep activation admission closed during replacement preparation; retain and propagate a failed replacement acquisition as its own fatal cause. Reconfigure, rebuild and explicit resume share this retirement ordering; failed cleanup cannot reach the reset point.
- Mark routine main-owner graph, identity and closed/no-active read-admission transitions with explicit typed authority evidence. Only public status and batch coverage translate that evidence to unavailable/invalidated data, across acquisition, capture and completion, after read and physical reader cleanup settle. Raw admission, search, grep and singleton coverage still reject; observations admit no work and earn no publication or liveness credit. Keep storage/profile/schema validation, unrelated same-message errors, transport and independent cleanup/aggregate failures fatal. Classify coverage store mismatch at the failed native observation before checking epoch/revision drift; later same-store writer drift cannot make a foreign reader retryable.
- Fence the canonical parent's pending request controllers before aborting the shared source signal. A queued context-aware workspace inventory operation must return explicit owned cancellation and physically join collection/watch work before writer or profile retirement.
- Fence and join pending reconfiguration before terminal retirement acknowledges. On managed-collection replacement, join removal of the outgoing collection's rooted native rows under the original acknowledged writer before replacement; preserve rootless and unrelated profile data, and retain failed removals for retry. Capture that actual writer before source retirement and read its final acknowledged binding authority after admitted work joins; refuse retired or replaced owners.
- Expose derived-only rebuild through the visible-ui `index-search:rebuild` capability and Workspace Index settings. Destroy/recreate only the owned derived SQLite files after all source/read owners settle; preserve PG application data, collections, chats and saved choices. Factory/developer resets use the same retirement owner before their separately authorized PG deletion.

- Mount the root-data deletion callback above the app's singleton `FileSystemProvider`; tree-local providers cannot supply an ancestor's captured removal callback. Preserve one shared filesystem instance and keep a failed deletion connected.
- Route desktop whole-root data deletion through the visible main capability. Reserve the original mounted object synchronously, capture its acknowledged native owner before stopping sources, then read the final ACK inventory after source/read/inference joins. Remove only its actual rooted bindings under the original workspace scope and join native cleanup before the canonical PG cascade; refuse foreign/replaced owners and retain failures for same-owner retry. Web retains its existing PG deletion path.

Evidence: `indexer/2026-10-03-production-activation.md`.
Evidence: `indexer/2026-10-03-production-activation-corrections.md`.
Guard: `apps/desktop/src/__tests__/native-index-activation.test.ts`, `native-index-runtime.test.ts`, `native-index-runtime-scopes.test.ts`, `native-canonical-publication.test.ts`, `native-scoped-search.test.ts`, `native-index-settings.test.ts`, `packages/workspace-search/src/core/__tests__/native-workspace-search.test.ts`, `packages/settings-ui/src/__tests__/search-indexing-settings-section.test.tsx`.
Guard: `apps/desktop/src/__tests__/native-index-collection-switch.integration.test.ts`.
Evidence: `indexer/2026-10-03-native-pause-read.md`.
Evidence: `indexer/2026-10-03-native-binding-deletion.md`.
Evidence: `indexer/2026-10-03-native-delete-ack-order.md`.
Evidence: `indexer/2026-10-03-native-catalog-observation.md`.
Evidence: `indexer/2026-10-03-native-scan-binding-admission.md`.
Evidence: `indexer/2026-10-03-scoped-read-lifetime.md`.
Evidence: `indexer/2026-10-04-correlated-source-retirement.md`.
Evidence: `indexer/2026-10-04-acknowledged-publication-progress.md`.
Guard: `apps/desktop/qualification/m2-native/benchmark-progress.test.mjs`, `apps/desktop/src/__tests__/native-canonical-publication.test.ts`, `native-scoped-search.test.ts`, `native-publication-delete-ack.integration.test.ts`.
Guard: `apps/desktop/src/__tests__/native-index-source-retirement.test.ts`.
Guard: `apps/desktop/src/__tests__/native-index-scan-admission.test.ts`.
Guard: `apps/desktop/src/__tests__/native-index-catalog-refresh.integration.test.ts`.
Guard: `apps/desktop/src/__tests__/native-canonical-publication.test.ts`, `native-publication-delete-ack.integration.test.ts`.
Guard: `apps/desktop/src/__tests__/native-index-binding-deletion.integration.test.ts`, `native-index-runtime-scopes.test.ts`, `native-canonical-publication.test.ts`.
Guard: `apps/desktop/src/__tests__/native-index-pause.test.ts`, `canonical-utility-parent.test.ts`, `canonical-utility-manager.test.ts`, `native-index-settings.test.ts`.
Evidence: `indexer/2026-10-03-root-data-deletion.md`.
Guard: `packages/app-shell/src/__tests__/root-layout-deletion-composition.test.tsx`.
Guard: `apps/desktop/src/__tests__/native-root-data-deletion.test.ts`, `native-root-data-deletion.integration.test.ts`, `ipc-domains/workspace-root-data-deletion.test.ts`, `packages/db/__tests__/managed-root-data-deletion.integration.test.ts`, `packages/app-shell/src/__tests__/delete-root-data.test.ts`.

Evidence: `indexer/2026-10-04-typed-authority-observations.md`.
Evidence: `indexer/2026-10-04-retired-activation-failure.md`.
