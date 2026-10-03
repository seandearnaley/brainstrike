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
- Persist all canonical source metadata; preserve vector bytes when only that metadata changes. Derived schema4 must refuse prior schema versions with rebuild-required, never silently migrate or wipe.
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

### Canonical syntax metadata

- Accept the existing parser's typed symbols/references alongside a file commit; do not add a parse pass. Keep composite `(file_record_id, seq)` identities and name-based references, with same-file `from_symbol_seq` foreign keys.
- Replace graph metadata in the same file/chunk/vector transaction. Reject invalid batches atomically. Omitted syntax retains graph metadata only for unchanged content; changed content clears stale metadata and reports `not-provided`.

Evidence: `indexer/2026-10-02-independent-package.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`.

### Persistence and qualification

- Treat the database as derived state. Product cutover must register its owned path and call `destroy()` during factory reset before deleting roots; package `destroy()` joins pending writes and removes only its database/WAL/shared-memory files.
- Mark tests requiring actual native binaries/processes as `.integration.test.ts` and run them through the uncached integration task after building the public artifacts. Do not report these checks as full application or cross-platform acceptance.

Evidence: `indexer/2026-10-02-independent-package.md`.
Guard: `packages/indexer/__tests__/indexer.integration.test.ts`, `packages/indexer/turbo.json`.
