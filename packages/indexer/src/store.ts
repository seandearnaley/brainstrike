import path from 'node:path';
import type { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { checkedTruncateCheckpoint } from './checked-checkpoint.ts';
import { fileChunks, sha256 } from './chunks.ts';
import {
  authorize,
  type CommitResult,
  coverageRequestSchema,
  coverageSchema,
  decoder,
  type FilePlan,
  type FileSnapshot,
  type FileSyntax,
  hitSchema,
  type IndexerCoverage,
  IndexerError,
  type IndexerIdentity,
  type IndexerInfo,
  type IndexerManifestResult,
  type IndexerOptions,
  identitySchema,
  optionsSchema,
  planSchema,
  type SearchResult,
  searchSchema,
  snapshotSchema,
  type TextFileCommit,
  textCommitSchema,
} from './contracts.ts';
import type { IndexConnection, IndexReaderConnection } from './index-connection.ts';
import { verifyIndexManifest } from './index-manifest.ts';
import {
  freshIdentity,
  INDEX_SCHEMA_VERSION,
  readIndexIdentity,
  readIndexSchemaVersion,
} from './index-metadata.ts';
import { assertFreshOpen, decodeIndexerOptions } from './options.ts';
import { ScopeAuthority } from './scope-authority.ts';
import { ScopedIndex } from './scoped-store.ts';
import { StateEventStore } from './state-event-store.ts';
import type { StateProjection } from './state-projection.ts';
import type { CoarseVectorEngine } from './vector-engine.ts';

const numberId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const decodeFile = decoder(
  Schema.NullOr(Schema.Struct({ contentHash: Schema.String, snapshotHash: Schema.String }))
);
const decodeHit = decoder(hitSchema);
const hitColumns =
  'c.id AS chunkId, c.root_id AS rootId, c.file_record_id AS fileId, f.path AS relativePath, c.start_line AS startLine, c.end_line AS endLine, c.content AS content, c.content_hash AS contentHash, c.chunk_index AS chunkIndex, c.chunk_size AS chunkSize, c.chunk_type AS chunkType, c.start_offset AS startOffset, c.end_offset AS endOffset, c.token_count AS tokenCount';
const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;

function snapshotHash(snapshot: FileSnapshot): string {
  return sha256(
    JSON.stringify([
      snapshot.rootId,
      snapshot.fileId,
      snapshot.relativePath,
      'providedChunks' in snapshot ? snapshot.providedChunks : snapshot.chunkLines,
      sha256(snapshot.content),
    ])
  );
}
function existingFile(
  db: Database.Database,
  snapshot: Pick<FileSnapshot, 'rootId' | 'fileId'>
): ReturnType<typeof decodeFile> {
  return decodeFile(
    db
      .prepare(
        'SELECT content_hash AS contentHash, snapshot_hash AS snapshotHash FROM file_records WHERE root_id=? AND id=?'
      )
      .get(snapshot.rootId, snapshot.fileId) ?? null
  );
}
export class IndexWriter {
  private readonly state: StateEventStore | undefined;
  readonly db: Database.Database;
  readonly engine: CoarseVectorEngine;
  private readonly truth: StateTruthReader | undefined;
  readonly options: IndexerOptions;
  readonly allowed: ReadonlySet<string>;
  readonly info: IndexerInfo;
  readonly scoped: ScopedIndex;
  private readonly projection: StateProjection | undefined;

  /** `connection` is the index database its host opened (`desktop-index-connection.ts` on desktop). */
  constructor(input: unknown, connection: IndexConnection, projection?: StateProjection) {
    this.projection = projection;
    try {
      this.options = decodeIndexerOptions(input);
    } catch (error) {
      connection.db.close();
      throw error;
    }
    this.db = connection.db;
    this.engine = connection.engine;
    this.truth = connection.truth;
    const fresh = connection.fresh;
    try {
      StateEventStore.assertProjection(this.options.stateRoot, projection);
      this.allowed = new Set(this.options.rootIds);
      new ScopeAuthority(this.options);
      assertFreshOpen(this.options, fresh);
      const vecVersion = this.engine.attach(this.db);
      if (fresh) {
        this.initialize();
      } else {
        readIndexIdentity(this.db);
      }
      const integrity = decoder(Schema.Array(Schema.String))(
        this.db.prepare('PRAGMA integrity_check').pluck().all()
      );
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        throw new IndexerError(
          'rebuild-required',
          'SQLite integrity_check refused the existing derived index.'
        );
      }
      readIndexSchemaVersion(this.db);
      StateEventStore.validateLayout(this.db);
      StateEventStore.validateRoot(this.db, this.options.stateRoot, this.projection);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('secure_delete = ON');
      for (const table of ['file_chunks_fts', 'file_chunks_trigram']) {
        this.db.exec(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
      }
      this.scoped = new ScopedIndex(this.db, this.options, this.engine, {
        replace: (syntax, fileId, changed) => this.replaceSyntax(syntax, fileId, changed),
        validate: (syntax, fileId) => this.validateSyntax(syntax, fileId),
      });
      this.scoped.validateStorage();
      this.state = this.acquireState();
      this.info = {
        dbPath: this.options.dbPath,
        journalMode: decoder(Schema.String)(this.db.pragma('journal_mode', { simple: true })),
        pid: connection.owner.pid,
        ...this.identity,
        readerQueryOnly: 0,
        vecVersion,
        writerThreadId: connection.owner.writerThreadId,
      };
    } catch (error) {
      this.state?.close();
      this.db.close();
      throw error;
    }
  }
  get identity(): IndexerIdentity {
    return readIndexIdentity(this.db);
  }
  private acquireState(): StateEventStore | undefined {
    let acquiredState: StateEventStore | undefined;
    try {
      return this.db
        .transaction(() => {
          readIndexIdentity(this.db);
          StateEventStore.validateLayout(this.db);
          StateEventStore.validateRoot(this.db, this.options.stateRoot, this.projection);
          acquiredState = StateEventStore.acquire(
            this.db,
            this.options.stateRoot,
            this.truth,
            this.projection
          );
          this.scoped.beginOwnerEpoch();
          return acquiredState;
        })
        .immediate();
    } catch (error) {
      acquiredState?.close();
      throw error;
    }
  }
  private initialize(): void {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,store_id TEXT NOT NULL);
        CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT,name TEXT NOT NULL,path TEXT,embedding_set_id TEXT,source_path TEXT,scoped INTEGER NOT NULL DEFAULT 0 CHECK(scoped IN (0,1)),content_hash TEXT NOT NULL,snapshot_hash TEXT NOT NULL,UNIQUE(root_id,id),CHECK((root_id IS NULL AND path IS NULL AND embedding_set_id IS NOT NULL AND scoped=1) OR (root_id IS NOT NULL AND path IS NOT NULL)));
        CREATE TABLE file_chunks(pk INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,root_id TEXT,file_record_id TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER,CHECK((chunk_index IS NULL AND chunk_size IS NULL AND chunk_type IS NULL AND start_offset IS NULL AND end_offset IS NULL AND token_count IS NULL) OR (chunk_index IS NOT NULL AND chunk_size IS NOT NULL AND chunk_type IS NOT NULL AND start_offset IS NOT NULL AND end_offset IS NOT NULL AND token_count IS NOT NULL AND chunk_index>=0 AND chunk_size>0 AND chunk_type IN ('text','sentence','recursive') AND start_offset>=0 AND end_offset>start_offset AND token_count>0)),FOREIGN KEY(file_record_id) REFERENCES file_records(id) ON DELETE CASCADE);
        CREATE INDEX chunks_file ON file_chunks(root_id,file_record_id);
        CREATE INDEX chunks_file_record ON file_chunks(file_record_id);
        CREATE TABLE file_symbols(file_record_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,seq INTEGER NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('function','class','method','variable','interface','type','enum')),exported INTEGER NOT NULL CHECK(exported IN (0,1)),start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(file_record_id,seq)) WITHOUT ROWID;
        CREATE INDEX idx_file_symbols_name ON file_symbols(name);
        CREATE TABLE file_symbol_refs(file_record_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,seq INTEGER NOT NULL,from_symbol_seq INTEGER,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('call','import','extends','implements')),module TEXT,line INTEGER NOT NULL,PRIMARY KEY(file_record_id,seq),FOREIGN KEY(file_record_id,from_symbol_seq) REFERENCES file_symbols(file_record_id,seq) ON DELETE CASCADE) WITHOUT ROWID;
        CREATE INDEX idx_file_symbol_refs_name_kind ON file_symbol_refs(name,kind);
        CREATE VIRTUAL TABLE file_chunks_fts USING fts5(content,content='file_chunks',content_rowid='pk',tokenize='porter unicode61');
        CREATE VIRTUAL TABLE file_chunks_trigram USING fts5(content,content='file_chunks',content_rowid='pk',tokenize='trigram');
        CREATE TRIGGER chunks_insert AFTER INSERT ON file_chunks BEGIN
          INSERT INTO file_chunks_fts(rowid,content) VALUES(new.pk,new.content);
          INSERT INTO file_chunks_trigram(rowid,content) VALUES(new.pk,new.content);
        END;
        CREATE TRIGGER chunks_delete AFTER DELETE ON file_chunks BEGIN
          INSERT INTO file_chunks_fts(file_chunks_fts,rowid,content) VALUES('delete',old.pk,old.content);
          INSERT INTO file_chunks_trigram(file_chunks_trigram,rowid,content) VALUES('delete',old.pk,old.content);
        END;
        CREATE TRIGGER chunks_update AFTER UPDATE ON file_chunks BEGIN
          INSERT INTO file_chunks_fts(file_chunks_fts,rowid,content) VALUES('delete',old.pk,old.content);
          INSERT INTO file_chunks_trigram(file_chunks_trigram,rowid,content) VALUES('delete',old.pk,old.content);
          INSERT INTO file_chunks_fts(rowid,content) VALUES(new.pk,new.content);
          INSERT INTO file_chunks_trigram(rowid,content) VALUES(new.pk,new.content);
        END;
      `);
      ScopedIndex.initialize(this.db);
      StateEventStore.initialize(this.db, this.options.stateRoot, this.projection);
      const identity = freshIdentity(this.options);
      this.db
        .prepare('INSERT INTO index_metadata VALUES(1,?,?)')
        .run(INDEX_SCHEMA_VERSION, identity.storeId);
    })();
  }
  recordStateFailure(error: unknown): void {
    this.state?.recordFailure(error);
  }
  requireState(): StateEventStore {
    if (!this.state) {
      throw new IndexerError(
        'state-root-required',
        'State projection has no acquired authoritative truth root.'
      );
    }
    return this.state;
  }
  close(): void {
    try {
      this.state?.close();
    } finally {
      this.db.close();
    }
  }
  commitText(input: unknown): CommitResult {
    const request = decoder(textCommitSchema)(input);
    authorize(this.allowed, [request.plan.snapshot.rootId]);
    this.assertLegacyFile(request.plan.snapshot.fileId);
    if (request.plan.storeId !== this.identity.storeId) {
      throw new IndexerError(
        'stale-index-state',
        'File plan store differs from the current store; prepare again.'
      );
    }
    this.validatePlan(request.plan);
    if (request.syntax) {
      this.validateSyntax(request.syntax, request.plan.snapshot.fileId);
    }
    return this.db.transaction(() => this.apply(request))();
  }
  private validatePlan(plan: FilePlan): void {
    const chunks = fileChunks(plan.snapshot);
    const identity = (chunk: (typeof chunks)[number]): readonly unknown[] => [
      chunk.chunkId,
      chunk.contentHash,
      chunk.embeddingHash,
      chunk.startLine,
      chunk.endLine,
      chunk.content,
      chunk.chunkIndex,
      chunk.chunkSize,
      chunk.chunkType,
      chunk.startOffset,
      chunk.endOffset,
      chunk.tokenCount,
    ];
    if (
      plan.contentHash !== sha256(plan.snapshot.content) ||
      JSON.stringify(chunks.map(identity)) !== JSON.stringify(plan.chunks.map(identity))
    ) {
      throw new TypeError('File plan hashes/chunks do not match the canonical snapshot.');
    }
  }
  private apply({ plan, syntax }: TextFileCommit): CommitResult {
    const existing = existingFile(this.db, plan.snapshot);
    if ((existing?.snapshotHash ?? null) !== plan.previousSnapshotHash) {
      throw new IndexerError(
        'stale-file-plan',
        'The file changed after preparation; prepare it again.'
      );
    }
    if (existing?.snapshotHash === snapshotHash(plan.snapshot)) {
      return {
        reusedEmbeddings: 0,
        unchanged: true,
        writtenChunks: 0,
        ...this.replaceSyntax(syntax, plan.snapshot.fileId, false),
      };
    }
    const old = decoder(
      Schema.Array(
        Schema.Struct({ chunkId: Schema.String, contentHash: Schema.String, id: numberId })
      )
    )(
      this.db
        .prepare(
          'SELECT c.pk AS id,c.id AS chunkId,c.content_hash AS contentHash FROM file_chunks c WHERE c.root_id=? AND c.file_record_id=?'
        )
        .all(plan.snapshot.rootId, plan.snapshot.fileId)
    );
    const cached = new Map(old.map((chunk) => [chunk.chunkId, chunk]));
    const keep = new Set(plan.chunks.map((chunk) => chunk.chunkId));
    for (const chunk of old) {
      if (!keep.has(chunk.chunkId)) {
        this.db.prepare('DELETE FROM file_chunks WHERE pk=?').run(BigInt(chunk.id));
      }
    }
    this.db
      .prepare(
        'INSERT INTO file_records(id,root_id,name,path,content_hash,snapshot_hash) VALUES(?,?,?,?,?,?) ON CONFLICT(root_id,id) DO UPDATE SET name=excluded.name,path=excluded.path,content_hash=excluded.content_hash,snapshot_hash=excluded.snapshot_hash'
      )
      .run(
        plan.snapshot.fileId,
        plan.snapshot.rootId,
        path.posix.basename(plan.snapshot.relativePath),
        plan.snapshot.relativePath,
        plan.contentHash,
        snapshotHash(plan.snapshot)
      );
    let writtenChunks = 0;
    for (const chunk of plan.chunks) {
      writtenChunks += this.writeChunk(chunk, cached.get(chunk.chunkId), plan.snapshot);
    }
    return {
      reusedEmbeddings: 0,
      unchanged: false,
      writtenChunks,
      ...this.replaceSyntax(
        syntax,
        plan.snapshot.fileId,
        existing?.snapshotHash !== snapshotHash(plan.snapshot)
      ),
    };
  }
  /** Writes one chunk; an unchanged chunk keeps its row and only its line metadata moves. */
  private writeChunk(
    chunk: FilePlan['chunks'][number],
    previous: { id: number; chunkId: string; contentHash: string } | undefined,
    snapshot: FileSnapshot
  ): number {
    if (previous?.contentHash === chunk.contentHash) {
      this.db
        .prepare(
          'UPDATE file_chunks SET start_line=?,end_line=?,chunk_index=?,chunk_size=?,chunk_type=?,start_offset=?,end_offset=?,token_count=? WHERE pk=?'
        )
        .run(
          chunk.startLine,
          chunk.endLine,
          chunk.chunkIndex,
          chunk.chunkSize,
          chunk.chunkType,
          chunk.startOffset,
          chunk.endOffset,
          chunk.tokenCount,
          BigInt(previous.id)
        );
      return 0;
    }
    this.db
      .prepare(
        'INSERT INTO file_chunks(id,root_id,file_record_id,start_line,end_line,content,content_hash,chunk_index,chunk_size,chunk_type,start_offset,end_offset,token_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_line=excluded.start_line,end_line=excluded.end_line,content=excluded.content,content_hash=excluded.content_hash,chunk_index=excluded.chunk_index,chunk_size=excluded.chunk_size,chunk_type=excluded.chunk_type,start_offset=excluded.start_offset,end_offset=excluded.end_offset,token_count=excluded.token_count'
      )
      .run(
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
      );
    return 1;
  }
  private validateSyntax(syntax: FileSyntax, fileId: string): void {
    const symbols = new Set<number>();
    const refs = new Set<number>();
    for (const symbol of syntax.symbols) {
      if (
        symbol.fileRecordId !== fileId ||
        symbols.has(symbol.seq) ||
        symbol.endLine < symbol.startLine ||
        symbol.endOffset < symbol.startOffset
      ) {
        throw new TypeError(
          'Symbol metadata must have unique sequences and valid ranges for the committed file.'
        );
      }
      symbols.add(symbol.seq);
    }
    for (const ref of syntax.refs) {
      if (
        ref.fileRecordId !== fileId ||
        refs.has(ref.seq) ||
        (ref.fromSymbolSeq !== undefined && !symbols.has(ref.fromSymbolSeq))
      ) {
        throw new TypeError(
          'Reference metadata must point only into the same file and symbol batch.'
        );
      }
      refs.add(ref.seq);
    }
  }
  private replaceSyntax(
    syntax: FileSyntax | undefined,
    fileId: string,
    changed: boolean
  ): Pick<CommitResult, 'writtenSymbols' | 'writtenRefs' | 'syntaxStatus'> {
    if (!(syntax || changed)) {
      return { syntaxStatus: 'retained', writtenRefs: 0, writtenSymbols: 0 };
    }
    this.db.prepare('DELETE FROM file_symbol_refs WHERE file_record_id=?').run(fileId);
    this.db.prepare('DELETE FROM file_symbols WHERE file_record_id=?').run(fileId);
    if (!syntax) {
      return { syntaxStatus: 'not-provided', writtenRefs: 0, writtenSymbols: 0 };
    }
    const insertSymbol = this.db.prepare('INSERT INTO file_symbols VALUES(?,?,?,?,?,?,?,?,?)');
    const insertRef = this.db.prepare('INSERT INTO file_symbol_refs VALUES(?,?,?,?,?,?,?)');
    for (const symbol of syntax.symbols) {
      insertSymbol.run(
        fileId,
        symbol.seq,
        symbol.name,
        symbol.kind,
        Number(symbol.exported),
        symbol.startLine,
        symbol.endLine,
        symbol.startOffset,
        symbol.endOffset
      );
    }
    for (const ref of syntax.refs) {
      insertRef.run(
        fileId,
        ref.seq,
        ref.fromSymbolSeq ?? null,
        ref.name,
        ref.kind,
        ref.module ?? null,
        ref.line
      );
    }
    return {
      syntaxStatus: 'replaced',
      writtenRefs: syntax.refs.length,
      writtenSymbols: syntax.symbols.length,
    };
  }
  private assertLegacyFile(fileId: string): void {
    if (this.db.prepare('SELECT 1 FROM file_records WHERE id=? AND scoped=1').get(fileId)) {
      throw new IndexerError('scoped-file-required', 'Use the scoped API for this canonical file.');
    }
  }
  purge(input: unknown): boolean {
    const removed = this.remove(input);
    // Retry must finish physical cleanup even after the earlier transaction deleted every row.
    checkedTruncateCheckpoint(this.db);
    return removed;
  }
  remove(input: unknown): boolean {
    const identity = decoder(identitySchema)(input);
    authorize(this.allowed, [identity.rootId]);
    this.assertLegacyFile(identity.fileId);
    return (
      this.db
        .prepare('DELETE FROM file_records WHERE root_id=? AND id=?')
        .run(identity.rootId, identity.fileId).changes > 0
    );
  }
}

export class IndexReader {
  readonly scoped: ScopedIndex;
  readonly db: Database.Database;
  readonly engine: CoarseVectorEngine;
  readonly options: IndexerOptions;
  readonly allowed: ReadonlySet<string>;
  /** `connection` is a read connection to the index its host opened; the reader closes it on failure. */
  constructor(input: unknown, connection: IndexReaderConnection) {
    this.options = decoder(optionsSchema)(input);
    this.allowed = new Set(this.options.rootIds);
    this.db = connection.db;
    this.engine = connection.engine;
    try {
      readIndexIdentity(this.db);
      this.scoped = new ScopedIndex(this.db, this.options, this.engine);
    } catch (error) {
      if (connection.owned) {
        this.db.close();
      }
      throw error;
    }
  }
  get identity(): IndexerIdentity {
    return readIndexIdentity(this.db);
  }
  prepare(input: unknown): FilePlan {
    const snapshot = decoder(snapshotSchema)(input);
    authorize(this.allowed, [snapshot.rootId]);
    return this.db.transaction(() => {
      const existing = existingFile(this.db, snapshot);
      return decoder(planSchema)({
        chunks: fileChunks(snapshot),
        contentHash: sha256(snapshot.content),
        previousSnapshotHash: existing?.snapshotHash ?? null,
        ...this.identity,
        snapshot,
        unchanged: existing?.snapshotHash === snapshotHash(snapshot),
      });
    })();
  }
  verifyManifest(input: unknown): IndexerManifestResult {
    return verifyIndexManifest(this.db, this.allowed, input);
  }
  coverage(input: unknown): IndexerCoverage {
    const request = decoder(coverageRequestSchema)(input);
    authorize(this.allowed, request.rootIds);
    if (new Set(request.rootIds).size !== request.rootIds.length) {
      throw new TypeError('Coverage roots must be unique.');
    }
    return this.db.transaction(() => {
      const roots = request.rootIds.map((rootId) => ({
        rootId,
        ...decoder(Schema.Struct({ chunks: Schema.Int, indexedFiles: Schema.Int }))(
          this.db
            .prepare(
              'SELECT (SELECT count(*) FROM file_records WHERE root_id=@root) AS indexedFiles,(SELECT count(*) FROM file_chunks WHERE root_id=@root) AS chunks'
            )
            .get({ root: rootId })
        ),
      }));
      const totals = roots.reduce(
        (sum, root) => ({
          chunks: sum.chunks + root.chunks,
          indexedFiles: sum.indexedFiles + root.indexedFiles,
        }),
        { chunks: 0, indexedFiles: 0 }
      );
      return decoder(coverageSchema)({ ...this.identity, roots, totals });
    })();
  }
  search(input: unknown): SearchResult {
    return this.db.transaction(() => this.searchSnapshot(input))();
  }
  private searchSnapshot(input: unknown): SearchResult {
    const request = decoder(searchSchema)(input);
    authorize(this.allowed, request.rootIds);
    const identity = this.identity;
    const text = request.text;
    const expression =
      request.mode === 'trigram'
        ? quote(text)
        : (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map(quote).join(' OR ');
    if (
      request.rootIds.length === 0 ||
      (request.mode === 'trigram' && [...text].length < 3) ||
      (request.mode === 'bm25' && !expression)
    ) {
      return {
        candidateCount: 0,
        candidatesTruncated: false,
        hits: [],
        ...identity,
        scanLimited: false,
        truncated: false,
      };
    }
    return this.db.transaction(() => {
      const hits: SearchResult['hits'][number][] = [];
      let candidateCount = 0;
      let candidatesTruncated = false;
      for (const root of new Set(request.rootIds)) {
        const table = request.mode === 'bm25' ? 'file_chunks_fts' : 'file_chunks_trigram';
        const rows = this.db
          .prepare(
            `SELECT ${hitColumns},bm25(${table}) AS score FROM ${table} JOIN file_chunks c ON c.pk=${table}.rowid JOIN file_records f ON f.root_id=c.root_id AND f.id=c.file_record_id WHERE ${table} MATCH ? AND c.root_id=? ORDER BY score,c.id LIMIT ?`
          )
          .all(expression, root, request.limit + 1);
        candidatesTruncated ||= rows.length > request.limit;
        const selected = rows.slice(0, request.limit);
        candidateCount += selected.length;
        hits.push(...selected.map(decodeHit));
      }
      hits.sort((a, b) => a.score - b.score || a.chunkId.localeCompare(b.chunkId));
      return {
        candidateCount,
        candidatesTruncated,
        hits: hits.slice(0, request.limit),
        ...identity,
        scanLimited: false,
        truncated: candidatesTruncated || hits.length > request.limit,
      };
    })();
  }
}
