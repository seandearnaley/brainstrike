import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { hostBasename } from '@brainstrike/utils/host-path';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { scopedFileChunks, sha256, vectorBlob, vectorProfileHash } from './chunks.ts';
import {
  type CommitResult,
  decoder,
  type FileSyntax,
  IndexerError,
  type IndexerOptions,
  type IndexFileBinding,
  type ScopedCoverage,
  type ScopedFilePlan,
  type ScopedFileSnapshot,
  type ScopedManifestResult,
  type ScopedSearchResult,
  scopedCommitSchema,
  scopedHitSchema,
  scopedManifestChunkSchema,
  scopedPlanSchema,
  scopedPrepareSchema,
  scopedRemoveBatchSchema,
  scopedRemoveSchema,
  scopedSearchSchema,
  scopedTextBatchSchema,
  type VectorProfile,
} from './contracts.ts';
import { readIndexIdentity, readScopeEpoch } from './index-metadata.ts';
import { ScopeAuthority, supportedVectorProfile } from './scope-authority.ts';
import { readScopedFileChunkBounds, readScopedFilePage } from './scoped-file-page.ts';
import { scopeCoverage, scopeCoverageBatch, verifyScopedManifest } from './scoped-proofs.ts';
import {
  coarseVectorBlob,
  validateScopedStorage,
  vectorTable,
} from './scoped-vector-validation.ts';
import type { CoarseVectorEngine } from './vector-engine.ts';

const integer = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const decodeVectors = decoder(
  Schema.Array(
    Schema.Struct({
      chunkPk: integer,
      dimensions: integer,
      pk: integer,
      profileHash: Schema.String,
    })
  )
);
const decodeStored = decoder(
  Schema.NullOr(
    Schema.Struct({
      contentHash: Schema.String,
      embeddingSetId: Schema.NullOr(Schema.String),
      rootId: Schema.NullOr(Schema.String),
      scoped: Schema.Literals([0, 1]),
      snapshotHash: Schema.String,
    })
  )
);
const columns =
  'c.id AS chunkId,c.content,c.content_hash AS contentHash,c.start_line AS startLine,c.end_line AS endLine,c.chunk_index AS chunkIndex,c.chunk_size AS chunkSize,c.chunk_type AS chunkType,c.start_offset AS startOffset,c.end_offset AS endOffset,c.token_count AS tokenCount,f.id AS fileId,f.root_id AS rootId,f.path AS relativePath,f.embedding_set_id AS embeddingSetId,f.source_path AS sourcePath';
const snapshotHash = (snapshot: ScopedFileSnapshot): string => sha256(JSON.stringify(snapshot));
type ScopedSearch = typeof scopedSearchSchema.Type;
const storedChunkSchema = Schema.Struct({
  ...scopedManifestChunkSchema.fields,
  content: Schema.String,
  fileId: Schema.String,
  pk: integer,
  rootId: Schema.NullOr(Schema.String),
});
type StoredChunk = typeof storedChunkSchema.Type;
interface SyntaxWriter {
  replace(
    syntax: FileSyntax | undefined,
    fileId: string,
    changed: boolean
  ): Pick<CommitResult, 'syntaxStatus' | 'writtenRefs' | 'writtenSymbols'>;
  validate(syntax: FileSyntax, fileId: string): void;
}
export class ScopedIndex {
  readonly authority: ScopeAuthority;
  readonly #chunkCap: number | undefined;
  /** better-sqlite3 does not cache statements; `db.close()` finalizes these. */
  readonly #statements = new Map<string, Database.Statement>();
  readonly db: Database.Database;
  readonly engine: CoarseVectorEngine;
  readonly syntax: SyntaxWriter | undefined;

  constructor(
    db: Database.Database,
    options: IndexerOptions,
    engine: CoarseVectorEngine,
    syntax?: SyntaxWriter
  ) {
    this.db = db;
    this.engine = engine;
    this.syntax = syntax;
    this.authority = new ScopeAuthority(options);
    this.#chunkCap = options.chunkCap;
  }
  /** The store's one prepared statement for `sql`, prepared on first use. */
  private statement(sql: string): Database.Statement {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
  static initialize(db: Database.Database): void {
    db.exec(`CREATE TABLE index_scope_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL);
      INSERT INTO index_scope_authority VALUES(1,'');
      CREATE INDEX files_collection ON file_records(embedding_set_id,id);
      CREATE TABLE vector_profiles(profile_hash TEXT PRIMARY KEY,profile_json TEXT NOT NULL,dimensions INTEGER NOT NULL CHECK(dimensions>0));
      CREATE TABLE scoped_vectors(pk INTEGER PRIMARY KEY,chunk_pk INTEGER NOT NULL REFERENCES file_chunks(pk) ON DELETE CASCADE,profile_hash TEXT NOT NULL REFERENCES vector_profiles(profile_hash),content_hash TEXT NOT NULL,dimensions INTEGER NOT NULL,emb BLOB NOT NULL CHECK(typeof(emb)='blob' AND vec_length(emb)=dimensions),UNIQUE(chunk_pk,profile_hash));`);
  }
  readFilePage(input: unknown): import('./contracts.ts').ScopedFilePage {
    return readScopedFilePage(this.db, this.authority, input);
  }
  readFileChunkBounds(input: unknown): import('./contracts.ts').ScopedFileChunkBounds {
    return readScopedFileChunkBounds(this.db, this.authority, input);
  }
  beginOwnerEpoch(): void {
    this.db
      .prepare('UPDATE index_scope_authority SET epoch=? WHERE singleton=1')
      .run(randomBytes(32).toString('hex'));
  }
  private epoch(): string {
    return readScopeEpoch(this.db);
  }
  replaceBindings(input: unknown): boolean {
    this.authority.replace(input);
    return true;
  }
  private stored(fileId: string): ReturnType<typeof decodeStored> {
    return decodeStored(
      this.statement(
        'SELECT snapshot_hash AS snapshotHash,content_hash AS contentHash,scoped,root_id AS rootId,embedding_set_id AS embeddingSetId FROM file_records WHERE id=?'
      ).get(fileId) ?? null
    );
  }
  private assertOwnership(snapshot: ScopedFileSnapshot): void {
    const existing = this.stored(snapshot.fileId);
    if (
      existing &&
      (existing.rootId !== snapshot.rootId ||
        (existing.scoped === 1 && existing.embeddingSetId !== snapshot.embeddingSetId))
    ) {
      throw new IndexerError(
        'file-ownership-changed',
        'Existing canonical membership differs; explicitly remove the derived file before republishing its new catalog binding.'
      );
    }
  }
  prepare(input: unknown): ScopedFilePlan {
    const request = decoder(scopedPrepareSchema)(input);
    const profile = request.profile ?? null;
    this.authority.snapshot(request.snapshot, profile);
    if (profile) {
      supportedVectorProfile(profile);
    }
    return this.db.transaction(() => {
      this.assertOwnership(request.snapshot);
      const profileHash = profile ? vectorProfileHash(profile) : null;
      const chunks = scopedFileChunks(request.snapshot, profileHash);
      const cached = new Map(
        decoder(
          Schema.Array(Schema.Struct({ chunkId: Schema.String, contentHash: Schema.String }))
        )(
          this.statement(
            'SELECT c.id AS chunkId,v.content_hash AS contentHash FROM scoped_vectors v JOIN file_chunks c ON c.pk=v.chunk_pk WHERE c.file_record_id=? AND v.profile_hash=?'
          ).all(request.snapshot.fileId, profileHash)
        ).map((row) => [row.chunkId, row.contentHash])
      );
      return decoder(scopedPlanSchema)({
        authorityEpoch: this.epoch(),
        authorityRevision: this.authority.revision,
        chunks,
        contentHash: sha256(request.snapshot.content),
        embeddingChunkIds: profile
          ? chunks
              .filter((chunk) => cached.get(chunk.chunkId) !== chunk.contentHash)
              .map((chunk) => chunk.chunkId)
          : [],
        previousSnapshotHash: this.stored(request.snapshot.fileId)?.snapshotHash ?? null,
        profile,
        profileHash,
        snapshot: request.snapshot,
        storeId: readIndexIdentity(this.db).storeId,
      });
    })();
  }
  /**
   * Prepare and commit a batch of TEXT files in one transaction, returning each file's plan in
   * request order. A failure on any file, or a store other than `storeId`, rolls back the batch.
   */
  commitTexts(input: unknown): readonly ScopedFilePlan[] {
    const request = decoder(scopedTextBatchSchema)(input);
    const syntaxWriter = this.syntaxWriter();
    for (const file of request.files) {
      if (file.syntax) {
        syntaxWriter.validate(file.syntax, file.snapshot.fileId);
      }
    }
    return this.db.transaction(() => {
      if (request.storeId !== readIndexIdentity(this.db).storeId) {
        throw new IndexerError('stale-file-plan', 'The index store changed after the scan began.');
      }
      const before = this.#chunkCap === undefined ? 0 : this.storedChunks();
      const plans = request.files.map((file) => {
        const plan = this.prepare({ snapshot: file.snapshot });
        this.apply(plan, new Map(), file.syntax, syntaxWriter);
        return plan;
      });
      this.assertWithinChunkCap(before);
      return plans;
    })();
  }
  commitVector(input: unknown): CommitResult {
    const request = decoder(scopedCommitSchema)(input);
    if (!request.plan.profile || vectorProfileHash(request.profile) !== request.plan.profileHash) {
      throw new IndexerError(
        'profile-not-authorized',
        'Commit profile differs from the prepared profile.'
      );
    }
    supportedVectorProfile(request.profile);
    return this.commit(request.plan, request.embeddings, request.syntax);
  }
  private commit(
    plan: ScopedFilePlan,
    embeddings: readonly { chunkId: string; vector: readonly number[] }[],
    syntax: FileSyntax | undefined
  ): CommitResult {
    this.authority.snapshot(plan.snapshot, plan.profile);
    if (
      plan.authorityEpoch !== this.epoch() ||
      plan.authorityRevision !== this.authority.revision ||
      plan.storeId !== readIndexIdentity(this.db).storeId
    ) {
      throw new IndexerError(
        'stale-file-plan',
        'Canonical binding authority changed after preparation.'
      );
    }
    const expected = this.prepare({
      snapshot: plan.snapshot,
      ...(plan.profile ? { profile: plan.profile } : {}),
    });
    if (JSON.stringify(plan) !== JSON.stringify(expected)) {
      throw new IndexerError(
        'stale-file-plan',
        'File content, chunks, profile or vector presence changed after preparation.'
      );
    }
    const supplied = new Map<string, Uint8Array>();
    for (const value of embeddings) {
      if (
        !plan.profile ||
        value.vector.length !== plan.profile.dimensions ||
        supplied.has(value.chunkId) ||
        !plan.embeddingChunkIds.includes(value.chunkId)
      ) {
        throw new TypeError(
          'Every missing vector must match its complete profile and chunk exactly once.'
        );
      }
      supplied.set(value.chunkId, vectorBlob(value.vector));
    }
    if (plan.profile && supplied.size !== plan.embeddingChunkIds.length) {
      throw new TypeError('Every missing vector must be supplied exactly once.');
    }
    const syntaxWriter = this.syntaxWriter();
    if (syntax) {
      syntaxWriter.validate(syntax, plan.snapshot.fileId);
    }
    return this.db.transaction(() => {
      const before = this.#chunkCap === undefined ? 0 : this.storedChunks();
      const result = this.apply(plan, supplied, syntax, syntaxWriter);
      this.assertWithinChunkCap(before);
      return result;
    })();
  }
  private syntaxWriter(): SyntaxWriter {
    if (!this.syntax) {
      throw new IndexerError('read-only', 'Scoped publication requires the owned writer.');
    }
    return this.syntax;
  }
  private storedChunks(): number {
    return Number(this.statement('SELECT count(*) FROM file_chunks').pluck().get());
  }
  /**
   * Inside the commit's transaction: a commit that grows the store past the
   * cap rolls back whole. One that keeps or shrinks it is admitted, so a store
   * over a cap lowered since it was filled can only converge down to it.
   */
  private assertWithinChunkCap(before: number): void {
    const cap = this.#chunkCap;
    if (cap === undefined) {
      return;
    }
    const stored = this.storedChunks();
    if (stored > cap && stored > before) {
      throw new IndexerError(
        'corpus-cap',
        `The file index holds at most ${cap.toLocaleString('en-US')} chunks; this commit would take it to ${stored.toLocaleString('en-US')}.`
      );
    }
  }
  private apply(
    plan: ScopedFilePlan,
    supplied: ReadonlyMap<string, Uint8Array>,
    syntax: FileSyntax | undefined,
    syntaxWriter: SyntaxWriter
  ): CommitResult {
    const existing = this.stored(plan.snapshot.fileId);
    if ((existing?.snapshotHash ?? null) !== plan.previousSnapshotHash) {
      throw new IndexerError('stale-file-plan', 'The file changed after preparation.');
    }
    const oldById = this.clearOldChunks(plan);
    const snapshot = plan.snapshot;
    this.statement(
      'INSERT INTO file_records(id,root_id,name,path,embedding_set_id,source_path,scoped,content_hash,snapshot_hash) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,embedding_set_id=excluded.embedding_set_id,source_path=excluded.source_path,scoped=1,content_hash=excluded.content_hash,snapshot_hash=excluded.snapshot_hash'
    ).run(
      snapshot.fileId,
      snapshot.rootId,
      snapshot.relativePath
        ? path.posix.basename(snapshot.relativePath)
        : snapshot.sourcePath
          ? hostBasename(snapshot.sourcePath)
          : '',
      snapshot.relativePath,
      snapshot.embeddingSetId,
      snapshot.sourcePath,
      plan.contentHash,
      snapshotHash(snapshot)
    );
    if (plan.profile) {
      this.registerProfile(plan.profile);
    }
    let writtenChunks = 0;
    let reusedEmbeddings = 0;
    for (const chunk of plan.chunks) {
      const result = this.writeChunk(
        plan,
        chunk,
        oldById.get(chunk.chunkId),
        supplied.get(chunk.chunkId)
      );
      writtenChunks += result.writtenChunks;
      reusedEmbeddings += result.reusedEmbeddings;
    }
    return {
      reusedEmbeddings,
      unchanged: existing?.snapshotHash === snapshotHash(snapshot),
      writtenChunks,
      ...syntaxWriter.replace(syntax, snapshot.fileId, existing?.contentHash !== plan.contentHash),
    };
  }
  private clearOldChunks(plan: ScopedFilePlan): Map<string, StoredChunk> {
    const old = decoder(Schema.Array(storedChunkSchema))(
      this.statement(
        'SELECT pk,id AS chunkId,root_id AS rootId,file_record_id AS fileId,start_line AS startLine,end_line AS endLine,content,content_hash AS contentHash,chunk_index AS chunkIndex,chunk_size AS chunkSize,chunk_type AS chunkType,start_offset AS startOffset,end_offset AS endOffset,token_count AS tokenCount FROM file_chunks WHERE file_record_id=?'
      ).all(plan.snapshot.fileId)
    );
    const byId = new Map(plan.chunks.map((chunk) => [chunk.chunkId, chunk]));
    this.deleteVectors(
      old.flatMap((chunk) =>
        byId.get(chunk.chunkId)?.contentHash === chunk.contentHash ? [] : [chunk.pk]
      )
    );
    const removed = old.filter((chunk) => !byId.has(chunk.chunkId));
    if (removed.length > 0) {
      const deleteChunk = this.statement('DELETE FROM file_chunks WHERE pk=?');
      for (const chunk of removed) {
        deleteChunk.run(chunk.pk);
      }
    }
    return new Map(old.map((chunk) => [chunk.chunkId, chunk]));
  }
  private writeChunk(
    plan: ScopedFilePlan,
    chunk: ScopedFilePlan['chunks'][number],
    previous: StoredChunk | undefined,
    emb: Uint8Array | undefined
  ): Pick<CommitResult, 'writtenChunks' | 'reusedEmbeddings'> {
    const snapshot = plan.snapshot;
    const equal =
      previous !== undefined &&
      previous.rootId === snapshot.rootId &&
      previous.fileId === snapshot.fileId &&
      (
        [
          'chunkId',
          'content',
          'contentHash',
          'startLine',
          'endLine',
          'chunkIndex',
          'chunkSize',
          'chunkType',
          'startOffset',
          'endOffset',
          'tokenCount',
        ] as const
      ).every((key) => previous[key] === chunk[key]);
    const pk = equal
      ? previous.pk
      : decoder(Schema.Struct({ pk: integer }))(
          this.statement(
            'INSERT INTO file_chunks(id,root_id,file_record_id,start_line,end_line,content,content_hash,chunk_index,chunk_size,chunk_type,start_offset,end_offset,token_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_line=excluded.start_line,end_line=excluded.end_line,content=excluded.content,content_hash=excluded.content_hash,chunk_index=excluded.chunk_index,chunk_size=excluded.chunk_size,chunk_type=excluded.chunk_type,start_offset=excluded.start_offset,end_offset=excluded.end_offset,token_count=excluded.token_count RETURNING pk'
          ).get(
            chunk.chunkId,
            snapshot.rootId,
            snapshot.fileId,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            chunk.contentHash,
            chunk.chunkIndex,
            chunk.chunkSize,
            chunk.chunkType,
            chunk.startOffset,
            chunk.endOffset,
            chunk.tokenCount
          )
        ).pk;
    const writtenChunks = !previous || previous.contentHash !== chunk.contentHash ? 1 : 0;
    let reusedEmbeddings = 0;
    if (plan.profile && plan.profileHash && emb) {
      const vectorPk = decoder(Schema.Struct({ pk: integer }))(
        this.statement(
          'INSERT INTO scoped_vectors(chunk_pk,profile_hash,content_hash,dimensions,emb) VALUES(?,?,?,?,?) RETURNING pk'
        ).get(pk, plan.profileHash, chunk.contentHash, plan.profile.dimensions, emb)
      ).pk;
      this.statement(
        `INSERT INTO ${vectorTable(plan.profile.dimensions)}(id,profile_hash,bin) VALUES(?,?,vec_quantize_binary(?))`
      ).run(BigInt(vectorPk), plan.profileHash, coarseVectorBlob(emb));
    } else if (plan.profile) {
      reusedEmbeddings += 1;
    }
    return { reusedEmbeddings, writtenChunks };
  }
  private registerProfile(profile: VectorProfile): void {
    const hash = vectorProfileHash(profile);
    this.statement(
      'INSERT INTO vector_profiles VALUES(?,?,?) ON CONFLICT(profile_hash) DO NOTHING'
    ).run(hash, JSON.stringify(profile), profile.dimensions);
    this.db.exec(
      this.engine.tableDefinition(vectorTable(profile.dimensions), {
        bits: Math.ceil(profile.dimensions / 8) * 8,
        ifNotExists: true,
        partition: 'profile_hash',
      })
    );
  }
  private deleteVectors(chunkPks: readonly number[]): void {
    if (chunkPks.length === 0) {
      return;
    }
    const select = this.statement(
      'SELECT pk,chunk_pk AS chunkPk,profile_hash AS profileHash,dimensions FROM scoped_vectors WHERE chunk_pk=?'
    );
    const deleteRows = this.statement('DELETE FROM scoped_vectors WHERE chunk_pk=?');
    for (const chunkPk of chunkPks) {
      for (const vector of decodeVectors(select.all(chunkPk))) {
        this.statement(`DELETE FROM ${vectorTable(vector.dimensions)} WHERE id=?`).run(
          BigInt(vector.pk)
        );
      }
      deleteRows.run(chunkPk);
    }
  }
  remove(input: unknown): boolean {
    const request = decoder(scopedRemoveSchema)(input);
    return this.removeAll([request.fileId], request.scope) > 0;
  }
  /** Remove a batch of one scope's files in one transaction; returns how many were stored. */
  removeBatch(input: unknown): number {
    const request = decoder(scopedRemoveBatchSchema)(input);
    return this.removeAll(request.fileIds, request.scope);
  }
  private removeAll(
    fileIds: readonly string[],
    scope: typeof scopedRemoveSchema.Type.scope
  ): number {
    this.authority.authorize([scope]);
    for (const fileId of fileIds) {
      this.authority.file(fileId, scope);
    }
    this.authority.revision += 1;
    return this.db.transaction(() => {
      let removed = 0;
      for (const fileId of fileIds) {
        const rows = decoder(Schema.Array(Schema.Struct({ pk: integer })))(
          this.statement('SELECT pk FROM file_chunks WHERE file_record_id=?').all(fileId)
        );
        this.deleteVectors(rows.map((row) => row.pk));
        removed += this.statement('DELETE FROM file_records WHERE id=?').run(fileId).changes;
      }
      return removed;
    })();
  }
  search(input: unknown): ScopedSearchResult {
    const request = decoder(scopedSearchSchema)(input);
    this.authority.authorize(request.scopes);
    if (
      request.mode === 'vector'
        ? !(request.profile && request.vector) || request.text !== undefined
        : request.text === undefined ||
          request.vector !== undefined ||
          request.profile !== undefined
    ) {
      throw new TypeError('Scoped search requires exactly its mode inputs.');
    }
    const profileHash = request.profile ? vectorProfileHash(request.profile) : null;
    if (request.profile) {
      supportedVectorProfile(request.profile);
      if (request.vector?.length !== request.profile.dimensions) {
        throw new TypeError('Query dimensions differ from its full profile.');
      }
    }
    const selected = this.selectedFiles(request);
    const selectedIds = new Set(selected.map((file) => file.fileId));
    for (const fileId of request.fileIds ?? []) {
      this.authority.file(fileId);
      if (!selectedIds.has(fileId)) {
        throw new IndexerError(
          'file-not-authorized',
          'Requested file is outside the selected scopes.'
        );
      }
    }
    return this.db.transaction(() => this.searchSnapshot(request, profileHash, selected))();
  }
  private searchSnapshot(
    request: ScopedSearch,
    profileHash: string | null,
    selected: readonly IndexFileBinding[]
  ): ScopedSearchResult {
    const empty: ScopedSearchResult = {
      candidateCount: 0,
      candidatesTruncated: false,
      hits: [],
      profile: request.profile ?? null,
      profileHash,
      scanLimited: false,
      storeId: readIndexIdentity(this.db).storeId,
      truncated: false,
    };
    if (!request.scopes.length || request.fileIds?.length === 0) {
      return empty;
    }
    this.validateSelectedBindings(selected);
    const { predicate, params } = this.scopePredicate(request, selected);
    return request.mode === 'vector'
      ? this.vectorSearch(request, empty, predicate, params, selected)
      : this.lexicalSearch(request, empty, predicate, params);
  }
  private scopePredicate(
    request: ScopedSearch,
    selected: readonly IndexFileBinding[]
  ): { predicate: string; params: string[] } {
    const params = [
      JSON.stringify(
        request.scopes.flatMap((scope) => (scope.kind === 'workspace' ? [scope.rootId] : []))
      ),
      JSON.stringify(
        request.scopes.flatMap((scope) =>
          scope.kind === 'collection' ? [scope.embeddingSetId] : []
        )
      ),
      JSON.stringify(selected.map((file) => file.fileId)),
    ];
    // Current PG bindings authorize scoped rows; the retained legacy route authorizes workspace rows.
    // JSON tables bind each complete ID list once, independently of SQLite's variable limit.
    let predicate =
      '(f.root_id IN (SELECT value FROM json_each(?)) OR f.embedding_set_id IN (SELECT value FROM json_each(?))) AND (f.scoped=0 OR f.id IN (SELECT value FROM json_each(?)))';
    if (request.fileIds) {
      predicate += ' AND f.id IN (SELECT value FROM json_each(?))';
      params.push(JSON.stringify(request.fileIds));
    }
    return { params, predicate };
  }
  private lexicalSearch(
    request: ScopedSearch,
    empty: ScopedSearchResult,
    predicate: string,
    params: string[]
  ): ScopedSearchResult {
    const text = request.text ?? '';
    const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const expression =
      request.mode === 'trigram'
        ? quote(text)
        : (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map(quote).join(' OR ');
    if (!expression || (request.mode === 'trigram' && [...text].length < 3)) {
      return empty;
    }
    const table = request.mode === 'bm25' ? 'file_chunks_fts' : 'file_chunks_trigram';
    const rows = this.db
      .prepare(
        `SELECT ${columns},bm25(${table}) AS score FROM ${table} JOIN file_chunks c ON c.pk=${table}.rowid JOIN file_records f ON f.id=c.file_record_id WHERE ${table} MATCH ? AND ${predicate} ORDER BY score,c.id LIMIT ?`
      )
      .all(expression, ...params, request.limit + 1);
    const hits = rows.slice(0, request.limit).map(decoder(scopedHitSchema));
    return {
      ...empty,
      candidateCount: hits.length,
      candidatesTruncated: rows.length > request.limit,
      hits,
      truncated: rows.length > request.limit,
    };
  }
  private vectorSearch(
    request: ScopedSearch,
    empty: ScopedSearchResult,
    predicate: string,
    params: string[],
    selected: readonly IndexFileBinding[]
  ): ScopedSearchResult {
    const profileHash = empty.profileHash;
    const profile = request.profile;
    if (!(profile && request.vector && profileHash)) {
      throw new TypeError('Vector request has no complete profile.');
    }
    const registered = this.db
      .prepare('SELECT 1 FROM vector_profiles WHERE profile_hash=?')
      .get(profileHash);
    if (!registered) {
      throw new IndexerError(
        'profile-not-configured',
        'The exact requested profile has not been published in this store.'
      );
    }
    for (const file of selected) {
      if (!file.profile || vectorProfileHash(file.profile) !== profileHash) {
        throw new IndexerError(
          'profile-not-authorized',
          'Selected canonical files have a different current vector profile.'
        );
      }
    }
    const q = vectorBlob(request.vector);
    const source = `SELECT v.pk FROM scoped_vectors v JOIN file_chunks c ON c.pk=v.chunk_pk JOIN file_records f ON f.id=c.file_record_id WHERE v.profile_hash=? AND ${predicate}`;
    const available = decoder(Schema.Int)(
      this.db
        .prepare(`SELECT count(*) FROM (${source})`)
        .pluck()
        .get(profileHash, ...params)
    );
    const nearest = this.engine.candidates(
      this.db,
      vectorTable(profile.dimensions),
      {
        among: { params: [profileHash, ...params], sql: source },
        k: 100,
        partition: profileHash,
        partitionColumn: 'profile_hash',
        vector: coarseVectorBlob(q),
      },
      ['id']
    );
    const candidates = decoder(Schema.Array(Schema.Struct({ id: integer })))(
      this.db.prepare(nearest.sql).all(...nearest.params)
    );
    const scoreSql =
      profile.distance === 'ip'
        ? '0'
        : profile.distance === 'l2'
          ? 'vec_distance_l2(v.emb,?)'
          : 'vec_distance_cosine(v.emb,?)';
    const ranked = candidates
      .map((candidate) => {
        const row = this.db
          .prepare(
            `SELECT ${columns},${scoreSql} AS score,v.emb AS embedding FROM scoped_vectors v JOIN file_chunks c ON c.pk=v.chunk_pk JOIN file_records f ON f.id=c.file_record_id WHERE v.pk=? AND v.profile_hash=?`
          )
          .get(...(profile.distance === 'ip' ? [] : [q]), candidate.id, profileHash);
        const { embedding, ...hit } = decoder(
          Schema.Struct({ ...scopedHitSchema.fields, embedding: Schema.Uint8Array })
        )(row);
        const score = profile.distance === 'ip' ? negativeInnerProduct(embedding, q) : hit.score;
        return { ...hit, score };
      })
      .sort((a, b) => a.score - b.score || a.chunkId.localeCompare(b.chunkId));
    return {
      ...empty,
      candidateCount: candidates.length,
      candidatesTruncated: available > 100,
      hits: ranked.slice(0, request.limit),
      truncated: available > 100 || ranked.length > request.limit,
    };
  }
  private selectedFiles(request: ScopedSearch): IndexFileBinding[] {
    return this.authority.selectedFiles(request.scopes, request.fileIds);
  }
  private validateSelectedBindings(selected: readonly IndexFileBinding[]): void {
    this.authority.validateStoredBindings(this.db, selected);
  }
  coverage(input: unknown): ScopedCoverage {
    return scopeCoverage(this.db, this.authority, input);
  }
  coverageBatch(input: unknown): readonly ScopedCoverage[] {
    return scopeCoverageBatch(this.db, this.authority, input);
  }
  verifyManifest(input: unknown): ScopedManifestResult {
    return verifyScopedManifest(this.db, this.authority, input);
  }
  validateStorage(): void {
    validateScopedStorage(this.db);
  }
}

/** pgvector's inner-product distance is the negative dot product (ascending). */
function negativeInnerProduct(stored: Uint8Array, query: Uint8Array): number {
  if (stored.byteLength !== query.byteLength) {
    throw new Error('Stored and query vector dimensions disagree.');
  }
  const left = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
  const right = new DataView(query.buffer, query.byteOffset, query.byteLength);
  let dot = 0;
  for (let offset = 0; offset < stored.byteLength; offset += 4) {
    dot += left.getFloat32(offset, true) * right.getFloat32(offset, true);
  }
  return -dot;
}
