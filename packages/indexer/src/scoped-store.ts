import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { scopedFileChunks, sha256, vectorBlob } from './chunks.js';
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
  scopedRemoveSchema,
  scopedSearchSchema,
  scopedTextCommitSchema,
  type VectorProfile,
} from './contracts.js';
import { readIndexIdentity, readScopeEpoch } from './index-metadata.js';
import { ScopeAuthority, supportedVectorProfile, vectorProfileHash } from './scope-authority.js';
import { scopeCoverage, verifyScopedManifest } from './scoped-proofs.js';
import { validateScopedStorage, vectorTable } from './scoped-vector-validation.js';

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
  embeddingHash: Schema.NullOr(Schema.String),
  fileId: Schema.String,
  hasVector: Schema.Literals([0, 1]),
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
  constructor(
    readonly db: Database.Database,
    options: IndexerOptions,
    readonly syntax?: SyntaxWriter
  ) {
    this.authority = new ScopeAuthority(options);
  }
  static initialize(db: Database.Database): void {
    db.exec(`CREATE TABLE index_scope_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL);
      INSERT INTO index_scope_authority VALUES(1,'');
      CREATE INDEX files_collection ON file_records(embedding_set_id,id);
      CREATE TABLE vector_profiles(profile_hash TEXT PRIMARY KEY,profile_json TEXT NOT NULL,dimensions INTEGER NOT NULL CHECK(dimensions>0));
      CREATE TABLE scoped_vectors(pk INTEGER PRIMARY KEY,chunk_pk INTEGER NOT NULL REFERENCES file_chunks(pk) ON DELETE CASCADE,profile_hash TEXT NOT NULL REFERENCES vector_profiles(profile_hash),content_hash TEXT NOT NULL,dimensions INTEGER NOT NULL,emb BLOB NOT NULL CHECK(typeof(emb)='blob' AND vec_length(emb)=dimensions),UNIQUE(chunk_pk,profile_hash));`);
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
      this.db
        .prepare(
          'SELECT snapshot_hash AS snapshotHash,content_hash AS contentHash,scoped,root_id AS rootId,embedding_set_id AS embeddingSetId FROM file_records WHERE id=?'
        )
        .get(fileId) ?? null
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
          this.db
            .prepare(
              'SELECT c.id AS chunkId,v.content_hash AS contentHash FROM scoped_vectors v JOIN file_chunks c ON c.pk=v.chunk_pk WHERE c.file_record_id=? AND v.profile_hash=?'
            )
            .all(request.snapshot.fileId, profileHash)
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
  commitText(input: unknown): CommitResult {
    const request = decoder(scopedTextCommitSchema)(input);
    if (request.plan.profile !== null) {
      throw new TypeError('Scoped TEXT commit requires a TEXT plan.');
    }
    return this.commit(request.plan, [], request.syntax);
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
    const supplied = new Map<string, Buffer>();
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
    if (!this.syntax) {
      throw new IndexerError('read-only', 'Scoped publication requires the owned writer.');
    }
    if (syntax) {
      this.syntax.validate(syntax, plan.snapshot.fileId);
    }
    const syntaxWriter = this.syntax;
    return this.db.transaction(() => this.apply(plan, supplied, syntax, syntaxWriter))();
  }
  private apply(
    plan: ScopedFilePlan,
    supplied: ReadonlyMap<string, Buffer>,
    syntax: FileSyntax | undefined,
    syntaxWriter: SyntaxWriter
  ): CommitResult {
    const existing = this.stored(plan.snapshot.fileId);
    if ((existing?.snapshotHash ?? null) !== plan.previousSnapshotHash) {
      throw new IndexerError('stale-file-plan', 'The file changed after preparation.');
    }
    const oldById = this.clearOldChunks(plan);
    const snapshot = plan.snapshot;
    this.db
      .prepare(
        'INSERT INTO file_records(id,root_id,name,path,embedding_set_id,source_path,scoped,content_hash,snapshot_hash) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,embedding_set_id=excluded.embedding_set_id,source_path=excluded.source_path,scoped=1,content_hash=excluded.content_hash,snapshot_hash=excluded.snapshot_hash'
      )
      .run(
        snapshot.fileId,
        snapshot.rootId,
        snapshot.relativePath
          ? path.posix.basename(snapshot.relativePath)
          : snapshot.sourcePath
            ? path.basename(snapshot.sourcePath)
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
        supplied.get(chunk.chunkId),
        existing?.scoped === 0
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
      this.db
        .prepare(
          'SELECT pk,id AS chunkId,root_id AS rootId,file_record_id AS fileId,start_line AS startLine,end_line AS endLine,content,content_hash AS contentHash,embedding_hash AS embeddingHash,has_vector AS hasVector,chunk_index AS chunkIndex,chunk_size AS chunkSize,chunk_type AS chunkType,start_offset AS startOffset,end_offset AS endOffset,token_count AS tokenCount FROM file_chunks WHERE file_record_id=?'
        )
        .all(plan.snapshot.fileId)
    );
    const byId = new Map(plan.chunks.map((chunk) => [chunk.chunkId, chunk]));
    const keep = new Set(byId.keys());
    for (const chunk of old) {
      const next = byId.get(chunk.chunkId);
      if (!next || next.contentHash !== chunk.contentHash) {
        this.deleteVectors(chunk.pk);
      }
      if (!keep.has(chunk.chunkId)) {
        this.db.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(chunk.pk));
        this.db.prepare('DELETE FROM file_chunks WHERE pk=?').run(chunk.pk);
      }
    }
    return new Map(old.map((chunk) => [chunk.chunkId, chunk]));
  }
  private writeChunk(
    plan: ScopedFilePlan,
    chunk: ScopedFilePlan['chunks'][number],
    previous: StoredChunk | undefined,
    emb: Buffer | undefined,
    legacy: boolean
  ): Pick<CommitResult, 'writtenChunks' | 'reusedEmbeddings'> {
    const snapshot = plan.snapshot;
    if (previous && legacy) {
      this.db.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(previous.pk));
    }
    const equal =
      previous !== undefined &&
      !legacy &&
      previous.rootId === snapshot.rootId &&
      previous.fileId === snapshot.fileId &&
      previous.embeddingHash === null &&
      previous.hasVector === 0 &&
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
          this.db
            .prepare(
              'INSERT INTO file_chunks(id,root_id,file_record_id,start_line,end_line,content,content_hash,embedding_hash,chunk_index,chunk_size,chunk_type,start_offset,end_offset,token_count,has_vector) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET start_line=excluded.start_line,end_line=excluded.end_line,content=excluded.content,content_hash=excluded.content_hash,embedding_hash=NULL,has_vector=0,chunk_index=excluded.chunk_index,chunk_size=excluded.chunk_size,chunk_type=excluded.chunk_type,start_offset=excluded.start_offset,end_offset=excluded.end_offset,token_count=excluded.token_count RETURNING pk'
            )
            .get(
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
        this.db
          .prepare(
            'INSERT INTO scoped_vectors(chunk_pk,profile_hash,content_hash,dimensions,emb) VALUES(?,?,?,?,?) RETURNING pk'
          )
          .get(pk, plan.profileHash, chunk.contentHash, plan.profile.dimensions, emb)
      ).pk;
      this.db
        .prepare(
          `INSERT INTO ${vectorTable(plan.profile.dimensions)}(id,profile_hash,bin) VALUES(?,?,vec_quantize_binary(?))`
        )
        .run(BigInt(vectorPk), plan.profileHash, emb);
    } else if (plan.profile) {
      reusedEmbeddings += 1;
    }
    return { reusedEmbeddings, writtenChunks };
  }
  private registerProfile(profile: VectorProfile): void {
    const hash = vectorProfileHash(profile);
    this.db
      .prepare('INSERT INTO vector_profiles VALUES(?,?,?) ON CONFLICT(profile_hash) DO NOTHING')
      .run(hash, JSON.stringify(profile), profile.dimensions);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTable(profile.dimensions)} USING vec0(id INTEGER PRIMARY KEY,profile_hash TEXT PARTITION KEY,bin BIT[${profile.dimensions}]);`
    );
  }
  private deleteVectors(chunkPk: number): void {
    const vectors = decodeVectors(
      this.db
        .prepare(
          'SELECT pk,chunk_pk AS chunkPk,profile_hash AS profileHash,dimensions FROM scoped_vectors WHERE chunk_pk=?'
        )
        .all(chunkPk)
    );
    for (const vector of vectors) {
      this.db
        .prepare(`DELETE FROM ${vectorTable(vector.dimensions)} WHERE id=?`)
        .run(BigInt(vector.pk));
    }
    this.db.prepare('DELETE FROM scoped_vectors WHERE chunk_pk=?').run(chunkPk);
  }
  remove(input: unknown): boolean {
    const request = decoder(scopedRemoveSchema)(input);
    this.authority.authorize([request.scope]);
    this.authority.file(request.fileId, request.scope);
    this.authority.revision += 1;
    return this.db.transaction(() => {
      const rows = decoder(Schema.Array(Schema.Struct({ pk: integer })))(
        this.db.prepare('SELECT pk FROM file_chunks WHERE file_record_id=?').all(request.fileId)
      );
      for (const row of rows) {
        this.deleteVectors(row.pk);
        this.db.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(row.pk));
      }
      const removed =
        this.db.prepare('DELETE FROM file_records WHERE id=?').run(request.fileId).changes > 0;
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
    const candidates = decoder(Schema.Array(Schema.Struct({ id: integer })))(
      this.db
        .prepare(
          `SELECT id FROM ${vectorTable(profile.dimensions)} WHERE bin MATCH vec_quantize_binary(?) AND k=100 AND profile_hash=? AND id IN (${source})`
        )
        .all(q, profileHash, profileHash, ...params)
    );
    const ranked = candidates
      .map((candidate) =>
        decoder(scopedHitSchema)(
          this.db
            .prepare(
              `SELECT ${columns},vec_distance_cosine(v.emb,?) AS score FROM scoped_vectors v JOIN file_chunks c ON c.pk=v.chunk_pk JOIN file_records f ON f.id=c.file_record_id WHERE v.pk=? AND v.profile_hash=?`
            )
            .get(q, candidate.id, profileHash)
        )
      )
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
  verifyManifest(input: unknown): ScopedManifestResult {
    return verifyScopedManifest(this.db, this.authority, input);
  }
  validateStorage(): void {
    validateScopedStorage(this.db);
  }
}
