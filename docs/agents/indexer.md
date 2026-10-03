# Derived desktop indexer

### Process ownership

- Keep `@brainstrike/indexer` Node-only and independent of product cutover. Use its Promise-based `IndexerPort`; inference stays in the hidden renderer host.
- Desktop main must explicitly launch Electron `utilityProcess` after app readiness; standalone Node uses Node IPC. Share the process core and writer worker without transport detection or child-process fallback. Keep immutable database/root acquisition authority on the lifecycle owner; read active persisted embedding identity through the owned port.
- Require caller-provided finite positive startup, request, close and exit deadlines. On terminal failure reject pending work, check termination acknowledgement, and join the transport exit event. Retain a failed cleanup owner and expose explicit retry; never relaunch over a live owner.
- Keep one writer worker and a separate read-only, query-only connection in the index process. Join writer/process completion on close; reject pending work on process failure.

Evidence: `indexer/2026-10-02-independent-package.md`, `indexer/2026-10-02-electron-utility.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`, `packages/indexer/__tests__/lifecycle.integration.test.ts`, `apps/desktop/src/__tests__/indexer-utility.integration.test.ts`.

### Profile and incremental identity

- Reuse the canonical metadata raw-row decoder for other SQLite drivers, inside the caller's owned read snapshot; it validates schema/store/profile/hash without constructing an engine.
- Keep a persisted store ID independent of explicit embedding state (`text-only` or `vector-configured`). New text acquisition requires no model/profile. Explicit `open-existing` validates stored identity inside the utility and refuses missing/corrupt/schema-invalid stores without creating or downgrading them.
- Configure a text store's first complete vector profile only through the writer's atomic `configureVectorProfile`; retain text/graph/store ID and roll back the entire transition on failure. Same profile is idempotent; different configured profile refuses rebuild-required. All vector APIs reject unconfigured stores; invalidate prepared plans across the transition.
- Validate the complete producer profile at commit and vector search: model ID, immutable revision, dtype, dimensions and token cap. Hash every field; the initial vector schema is 384 dimensions.
- Refuse profile/schema mismatches with `rebuild-required` and preserve the existing file. Never erase databases during startup.
- Canonical producers must prepare with explicit `providedChunks`, preserving the existing parser/chunker output and its source offsets, indices, token/type/size metadata. Validate hashes and source spans with the canonical matcher; reject invalid or mixed policy inputs without re-splitting, relocation or a second parse. Keep line-policy producer metadata explicitly null.
- Persist all canonical source metadata; preserve vector bytes when only that metadata changes. Derived schema5 must refuse prior schema versions with rebuild-required, never silently migrate or wipe.
- Prepare deterministic, byte-preserving line chunks from an authorized root-relative snapshot and explicit chunk-line policy. Reject stale snapshot plans; reuse a vector only when its stable chunk ID and content/profile hash agree.

Evidence: `indexer/2026-10-02-independent-package.md`.
Evidence: `indexer/2026-10-03-canonical-provided-chunks.md`.
Guard: `packages/indexer/__tests__/metadata.test.ts`, `packages/indexer/__tests__/chunks.test.ts`, `packages/indexer/__tests__/indexer.integration.test.ts`, `packages/indexer/__tests__/provided-chunks.integration.test.ts`, `packages/chunking-worker/src/__tests__/source-range-validation.test.ts`.

### Explicit write policy

- Make text-only writes explicit with `commitTextFile({plan, syntax?})`; reject embedding payloads on this path. Accept explicit text-only stores and preserve a configured store's existing profile/vectors, without invoking inference or inventing a model default.
- Text replacement preserves vectors only for unchanged chunk/content/profile identity and deletes stale vectors for changed or removed chunks. Persist explicit per-chunk vector presence and verify it against real vec rows on reopen, including orphan rejection. Missing vectors remain absent; vector search only returns actual vector rows. Strict `commitFile` continues to require every missing vector exactly once, including unchanged files explicitly opted into vector backfill. Backfill retains unchanged canonical graph metadata.

Evidence: `indexer/2026-10-03-explicit-text-commits.md`.
Evidence: `indexer/2026-10-03-independent-text-identity.md`.
Guard: `packages/indexer/__tests__/text-store.integration.test.ts`, `packages/indexer/__tests__/text-commit.integration.test.ts`, `apps/desktop/src/__tests__/fixtures/indexer-utility-proof.ts`.

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
- Query dimension-specific sqlite-vec 0.1.9 binary tables with full profile partition and authorized vector IDs before top100; rerank only those candidates by exact cosine. Validate registry/vector/coarse-row integrity on reopen. Factory reset joins the same writer and destroys the same owned database files.
- Bind complete scope/authorization/file-filter lists through SQLite JSON tables with a fixed parameter count. Validate every selected binding and apply exact membership before lexical ranking or vector candidate selection; never truncate lists or combine independently ranked batches.
- Verify scoped source manifests against the full current trusted binding inventory and all native scope rows in one snapshot. Refuse partial declarations; compare exact file membership/source hashes and complete canonical chunk identities/hashes/metadata, including zero-chunk files and stale extra rows. Reuse the existing authority epoch/revision; main's full-scan receipt still owns readiness.
- Report scoped coverage only for the explicit current full profile and actual authorized file/chunk/source/coarse rows. TEXT carries null profile and counts no cached other-profile vectors. Empty scopes and missing canonical files cannot claim vector completeness; coverage alone never proves source completeness.
- Production scoped snapshots carry canonical provided chunks. Explicit line-policy fixtures retain the existing foundation input; there is no production parser fallback. Scoped profile storage qualification does not qualify model inference or retrieval quality.

Evidence: `indexer/2026-10-03-collection-profile-storage.md`.
Guard: `packages/indexer/__tests__/collection-scopes.integration.test.ts`, `packages/indexer/__tests__/scoped-electron.integration.test.ts`, `packages/indexer/__tests__/large-scopes.integration.test.ts`.
Evidence: `indexer/2026-10-03-scoped-source-proofs.md`.
Guard: `packages/indexer/__tests__/scoped-proofs.integration.test.ts`, `packages/indexer/__tests__/large-scopes.integration.test.ts`.


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
The adapter is a library seam; actual main/grant/profile/utility wiring and app
qualification remain separate composition work.

### Explicit canonical vector ingestion

- Bind canonical hosts to TEXT (the default) or explicit VECTOR. TEXT never resolves a profile or invokes inference; VECTOR requires the actual saved local profile, existing scoped writer plans and a physically joined inference port. Refuse unsupported profiles and unwired dependencies without publishing TEXT.
- Generate only the native plan's ordered missing canonical chunks in batches of 1–64. Recheck current full profile, preserve original source and nullable catalog identity, join inference/cancellation and native publication before PG completion, and retain failed joins/abort notices for explicit close retry.
- Require the full canonical scoped manifest plus current selected-profile coverage with matching store/scope/authority before finishing VECTOR scans. Counts and receipts alone are insufficient. The current public port cannot supply skipped-file canonical chunk inventory, so VECTOR rereads/parses source even on stat hits; covered chunks require no inference. TEXT keeps its stat shortcut.

Evidence: `indexer/2026-10-03-canonical-vector-pipeline.md`.
Guard: `packages/canonical-ingestion/__tests__/vector-host.test.ts`, `packages/canonical-ingestion/__tests__/vector-host.integration.test.ts`, `packages/canonical-ingestion/__tests__/workspace-runtime.test.ts`.

### Borrowed workspace source ingestion

- Run workspace discovery, bounded secure reads and the existing `WorkspaceIndexingCoordinator` in `CanonicalWorkspaceIngestionRuntime`; borrow narrow operations from the same main-owned pinned mount. Paths, root IDs and projections never acquire a new native root.
- Forward batches and health from the existing main Parcel producer. Promote native watch work to full affected-root metadata reconciliation, force changed file reads, and preserve unchanged native-covered stat skips; readiness still uses the complete writer manifest predicate.
- Join admitted listing/read/iterator/subscription work before releasing a borrow. Preserve failed unsubscribe ownership for explicit retry, including `ParcelWatchRetirementError.retire()` when late timed-out acquisition succeeds but cleanup fails. Rejected acquisition joins event work and reports startup errors without an unsubscribe retry owner. Borrow retirement never closes the shared mount.

Evidence: `indexer/2026-10-03-borrowed-workspace-source.md`.
Guard: `packages/canonical-ingestion/__tests__/workspace-source.test.ts`, `packages/canonical-ingestion/__tests__/workspace-source-child.integration.test.ts`, `packages/file-system/src/__tests__/parcel-watch-retirement.test.ts`.

### Persistence and qualification

- Treat the database as derived state. Product cutover must register its owned path and call `destroy()` during factory reset before deleting roots; package `destroy()` joins pending writes and removes only its database/WAL/shared-memory files.
- Mark tests requiring actual native binaries/processes as `.integration.test.ts` and run them through the uncached integration task after building the public artifacts. Do not report these checks as full application or cross-platform acceptance.

Evidence: `indexer/2026-10-02-independent-package.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`, `packages/indexer/turbo.json`.

### Canonical scan manifests

- Compare the canonical scanner's complete eligible file manifest against native file IDs, root-relative paths and source hashes in one read snapshot. Authorize the requested root before reading its rows. Reject duplicate identities/paths, non-normalized paths and excess fields.
- Report missing, changed and unexpected files explicitly; equal row counts do not establish completeness. Empty manifests match only actually empty native roots. Manifest equality does not itself publish a full-scan receipt: the producer must also prove full scope, joined publication/removal and absence of aborts, errors or truncation.

Evidence: `indexer/2026-10-03-canonical-manifest.md`.
Guard: `packages/indexer/__tests__/manifest.integration.test.ts`.

### Visible producer transport and scan ownership (composition pending)

- Expose writes only through the visible-ui authorized producer manifest and the canonical IPC result envelope. Main supplies mandatory live root/file binding and complete-profile authorization; renderer requests never choose database paths, process budgets or SQL. Keep the four search channels read-only and the hidden preload unchanged.
- Forward canonical events through the browser-safe publication mapper into one provided-snapshot text commit. Keep vector preparation/commit separate and require a complete explicit profile plus the native returned plan. Do not manufacture plans or invoke inference to publish text.
- Bind full-scan completion to the active store/root/scan/generation ticket. Require the exact ticket for every write/removal during that scan; refuse overlapping starts and late/missing tickets. Close write admission while finishing and join all owned publication/removal promises before verifying the native manifest.
- Publish scan readiness only for an error-free, untruncated, unaborted full scan with matching native identities. Partial scans, failed writes and mismatched manifests explicitly remain incomplete. Consume completion tickets once; ordinary out-of-scan writes invalidate readiness. Restart requires a new full scan.

These requirements remain pending product composition. The visible producer/receipt
adapter and its dedicated evidence and guards have not landed in integration.
