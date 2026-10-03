import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { openConnection } from '@brainstrike/sqlite-native';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { embeddingProfileHash, fileChunks, sha256, vectorBlob } from './chunks.js';
import {
  authorize,
  type CommitResult,
  commitSchema,
  decoder,
  type FileCommit,
  type FilePlan,
  type FileSnapshot,
  type FileSyntax,
  hitSchema,
  IndexerError,
  type IndexerInfo,
  type IndexerOptions,
  identitySchema,
  optionsSchema,
  planSchema,
  profileSchema,
  type SearchResult,
  searchSchema,
  snapshotSchema,
} from './contracts.js';

const SCHEMA_VERSION = 2;
const numberId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const decodeFile = decoder(
  Schema.NullOr(Schema.Struct({ contentHash: Schema.String, snapshotHash: Schema.String }))
);
const decodeChunks = decoder(
  Schema.Array(Schema.Struct({ chunkId: Schema.String, embeddingHash: Schema.String }))
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
function loadProfile(db: Database.Database, options: IndexerOptions): void {
  const metadata = decoder(
    Schema.Struct({
      profileHash: Schema.String,
      profileJson: Schema.String,
      schemaVersion: Schema.Int,
    })
  )(
    db
      .prepare(
        'SELECT schema_version AS schemaVersion,profile_json AS profileJson,profile_hash AS profileHash FROM index_metadata WHERE singleton=1'
      )
      .get()
  );
  const profile = decoder(profileSchema)(JSON.parse(metadata.profileJson));
  if (
    metadata.schemaVersion !== SCHEMA_VERSION ||
    metadata.profileHash !== embeddingProfileHash(profile) ||
    metadata.profileHash !== embeddingProfileHash(options.profile)
  ) {
    throw new IndexerError(
      'rebuild-required',
      'The derived index schema or embedding profile changed; explicitly rebuild in a new index file.'
    );
  }
}
function assertVec(db: Database.Database): string {
  const version = decoder(Schema.String)(db.prepare('SELECT vec_version()').pluck().get());
  if (version !== 'v0.1.9') {
    throw new IndexerError(
      'rebuild-required',
      `Indexer requires sqlite-vec v0.1.9, received ${version}.`
    );
  }
  return version;
}
function decodeBlob(blob: Uint8Array): Buffer {
  if (blob.byteLength !== 384 * 4) {
    throw new IndexerError(
      'rebuild-required',
      'Stored embedding length differs from its pinned profile.'
    );
  }
  const buffer = Buffer.from(blob);
  vectorBlob(Array.from({ length: 384 }, (_, index) => buffer.readFloatLE(index * 4)));
  return buffer;
}

function resolveEmbedding(
  previous: { embeddingHash: string; emb: Uint8Array } | undefined,
  supplied: Buffer | undefined,
  hash: string
): Buffer {
  const reusable = previous?.embeddingHash === hash;
  if (supplied && reusable) {
    throw new TypeError('An unchanged embedding was unexpectedly supplied.');
  }
  const emb = supplied ?? (reusable && previous ? decodeBlob(previous.emb) : undefined);
  if (!emb) {
    throw new TypeError('Embedding content/profile identity changed without a replacement vector.');
  }
  return emb;
}

export class IndexWriter {
  readonly db: Database.Database;
  readonly options: IndexerOptions;
  readonly allowed: ReadonlySet<string>;
  readonly profileHash: string;
  readonly info: IndexerInfo;
  constructor(input: unknown) {
    this.options = decoder(optionsSchema)(input);
    this.allowed = new Set(this.options.rootIds);
    this.profileHash = embeddingProfileHash(this.options.profile);
    const fresh = !existsSync(this.options.dbPath);
    if (fresh && this.options.profile.dimensions !== 384) {
      throw new IndexerError(
        'unsupported-profile',
        'This index schema supports qualified 384-dimension MiniLM profiles only.'
      );
    }
    mkdirSync(path.dirname(this.options.dbPath), { recursive: true });
    this.db = openConnection(this.options.dbPath);
    try {
      const vecVersion = assertVec(this.db);
      if (fresh) {
        this.initialize();
      } else {
        try {
          loadProfile(this.db, this.options);
        } catch (error) {
          if (error instanceof IndexerError) {
            throw error;
          }
          throw new IndexerError(
            'rebuild-required',
            `Existing index metadata is invalid: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      if (this.options.profile.dimensions !== 384) {
        throw new IndexerError(
          'rebuild-required',
          'This index schema supports the qualified 384-dimension MiniLM profiles only.'
        );
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
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');
      for (const table of ['file_chunks_fts', 'file_chunks_trigram']) {
        this.db.exec(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
      }
      const counts = decoder(Schema.Struct({ chunks: Schema.Int, vectors: Schema.Int }))(
        this.db
          .prepare(
            'SELECT (SELECT count(*) FROM file_chunks) AS chunks,(SELECT count(*) FROM vec_chunks) AS vectors'
          )
          .get()
      );
      if (counts.chunks !== counts.vectors) {
        throw new IndexerError('rebuild-required', 'Derived chunk/vector counts disagree.');
      }
      this.info = {
        dbPath: this.options.dbPath,
        journalMode: decoder(Schema.String)(this.db.pragma('journal_mode', { simple: true })),
        pid: process.pid,
        profileHash: this.profileHash,
        readerQueryOnly: 0,
        vecVersion,
        writerThreadId: threadId,
      };
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private initialize(): void {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,profile_json TEXT NOT NULL,profile_hash TEXT NOT NULL);
        CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,content_hash TEXT NOT NULL,snapshot_hash TEXT NOT NULL,UNIQUE(root_id,id));
        CREATE TABLE file_chunks(pk INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,root_id TEXT NOT NULL,file_record_id TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,embedding_hash TEXT NOT NULL,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER,CHECK((chunk_index IS NULL AND chunk_size IS NULL AND chunk_type IS NULL AND start_offset IS NULL AND end_offset IS NULL AND token_count IS NULL) OR (chunk_index IS NOT NULL AND chunk_size IS NOT NULL AND chunk_type IS NOT NULL AND start_offset IS NOT NULL AND end_offset IS NOT NULL AND token_count IS NOT NULL AND chunk_index>=0 AND chunk_size>0 AND chunk_type IN ('text','sentence','recursive') AND start_offset>=0 AND end_offset>start_offset AND token_count>0)),FOREIGN KEY(root_id,file_record_id) REFERENCES file_records(root_id,id) ON DELETE CASCADE);
        CREATE INDEX chunks_file ON file_chunks(root_id,file_record_id);
        CREATE TABLE file_symbols(file_record_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,seq INTEGER NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('function','class','method','variable','interface','type','enum')),exported INTEGER NOT NULL CHECK(exported IN (0,1)),start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(file_record_id,seq)) WITHOUT ROWID;
        CREATE INDEX idx_file_symbols_name ON file_symbols(name);
        CREATE TABLE file_symbol_refs(file_record_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,seq INTEGER NOT NULL,from_symbol_seq INTEGER,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('call','import','extends','implements')),module TEXT,line INTEGER NOT NULL,PRIMARY KEY(file_record_id,seq),FOREIGN KEY(file_record_id,from_symbol_seq) REFERENCES file_symbols(file_record_id,seq) ON DELETE CASCADE) WITHOUT ROWID;
        CREATE INDEX idx_file_symbol_refs_name_kind ON file_symbol_refs(name,kind);
        CREATE VIRTUAL TABLE file_chunks_fts USING fts5(content,content='file_chunks',content_rowid='pk',tokenize='porter unicode61');
        CREATE VIRTUAL TABLE file_chunks_trigram USING fts5(content,content='file_chunks',content_rowid='pk',tokenize='trigram');
        CREATE VIRTUAL TABLE vec_chunks USING vec0(id INTEGER PRIMARY KEY,root_id TEXT PARTITION KEY,bin BIT[384],+emb BLOB);
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
      this.db
        .prepare('INSERT INTO index_metadata VALUES(1,?,?,?)')
        .run(SCHEMA_VERSION, JSON.stringify(this.options.profile), this.profileHash);
    })();
  }
  commit(input: unknown): CommitResult {
    const request = decoder(commitSchema)(input);
    authorize(this.allowed, [request.plan.snapshot.rootId]);
    if (
      request.plan.profileHash !== this.profileHash ||
      embeddingProfileHash(request.profile) !== this.profileHash
    ) {
      throw new IndexerError('rebuild-required', 'Embedding plan profile differs from this index.');
    }
    this.validatePlan(request);
    if (request.syntax) {
      this.validateSyntax(request.syntax, request.plan.snapshot.fileId);
    }
    return this.db.transaction(() => this.apply(request))();
  }
  private validatePlan({ plan, embeddings }: FileCommit): void {
    const chunks = fileChunks(plan.snapshot, this.options.profile);
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
    if (
      plan.embeddingChunkIds.some((chunkId) => !chunks.some((chunk) => chunk.chunkId === chunkId))
    ) {
      throw new TypeError('Embedding plan contains an unknown chunk identity.');
    }
    const supplied = new Set<string>();
    for (const embedding of embeddings) {
      if (supplied.has(embedding.chunkId) || !plan.embeddingChunkIds.includes(embedding.chunkId)) {
        throw new TypeError('Duplicate or unexpected embedding chunk identity.');
      }
      supplied.add(embedding.chunkId);
      vectorBlob(embedding.vector);
    }
    if (
      supplied.size !== plan.embeddingChunkIds.length ||
      new Set(plan.embeddingChunkIds).size !== plan.embeddingChunkIds.length
    ) {
      throw new TypeError('Every requested embedding must be supplied exactly once.');
    }
  }
  private apply({ plan, embeddings, syntax }: FileCommit): CommitResult {
    const existing = existingFile(this.db, plan.snapshot);
    if ((existing?.snapshotHash ?? null) !== plan.previousSnapshotHash) {
      throw new IndexerError(
        'stale-file-plan',
        'The file changed after embedding preparation; prepare it again.'
      );
    }
    if (existing?.snapshotHash === snapshotHash(plan.snapshot)) {
      return {
        reusedEmbeddings: plan.chunks.length,
        unchanged: true,
        writtenChunks: 0,
        ...this.replaceSyntax(syntax, plan.snapshot.fileId, false),
      };
    }
    const old = decoder(
      Schema.Array(
        Schema.Struct({
          chunkId: Schema.String,
          emb: Schema.Uint8Array,
          embeddingHash: Schema.String,
          id: numberId,
        })
      )
    )(
      this.db
        .prepare(
          'SELECT c.pk AS id,c.id AS chunkId,c.embedding_hash AS embeddingHash,v.emb FROM file_chunks c JOIN vec_chunks v ON v.id=c.pk WHERE c.root_id=? AND c.file_record_id=?'
        )
        .all(plan.snapshot.rootId, plan.snapshot.fileId)
    );
    const cached = new Map(old.map((chunk) => [chunk.chunkId, chunk]));
    const provided = new Map(
      embeddings.map((embedding) => [embedding.chunkId, vectorBlob(embedding.vector)])
    );
    const keep = new Set(plan.chunks.map((chunk) => chunk.chunkId));
    for (const chunk of old) {
      if (!keep.has(chunk.chunkId)) {
        this.db.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(chunk.id));
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
    let reusedEmbeddings = 0;
    for (const chunk of plan.chunks) {
      const previous = cached.get(chunk.chunkId);
      const supplied = provided.get(chunk.chunkId);
      const reusable = previous?.embeddingHash === chunk.embeddingHash;
      const emb = resolveEmbedding(previous, supplied, chunk.embeddingHash);
      if (!supplied) {
        reusedEmbeddings += 1;
      }
      if (previous && reusable) {
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
        continue;
      }
      if (previous) {
        this.db.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(previous.id));
      }
      const id = decoder(Schema.Struct({ id: numberId }))(
        this.db
          .prepare(
            'INSERT INTO file_chunks(id,root_id,file_record_id,start_line,end_line,content,content_hash,embedding_hash,chunk_index,chunk_size,chunk_type,start_offset,end_offset,token_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_line=excluded.start_line,end_line=excluded.end_line,content=excluded.content,content_hash=excluded.content_hash,embedding_hash=excluded.embedding_hash,chunk_index=excluded.chunk_index,chunk_size=excluded.chunk_size,chunk_type=excluded.chunk_type,start_offset=excluded.start_offset,end_offset=excluded.end_offset,token_count=excluded.token_count RETURNING pk AS id'
          )
          .get(
            chunk.chunkId,
            plan.snapshot.rootId,
            plan.snapshot.fileId,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            chunk.contentHash,
            chunk.embeddingHash,
            chunk.chunkIndex,
            chunk.chunkSize,
            chunk.chunkType,
            chunk.startOffset,
            chunk.endOffset,
            chunk.tokenCount
          )
      ).id;
      this.db
        .prepare('INSERT INTO vec_chunks(id,root_id,bin,emb) VALUES(?,?,vec_quantize_binary(?),?)')
        .run(BigInt(id), plan.snapshot.rootId, emb, emb);
      writtenChunks += 1;
    }
    return {
      reusedEmbeddings,
      unchanged: false,
      writtenChunks,
      ...this.replaceSyntax(syntax, plan.snapshot.fileId, true),
    };
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
  remove(input: unknown): boolean {
    const identity = decoder(identitySchema)(input);
    authorize(this.allowed, [identity.rootId]);
    return this.db.transaction(() => {
      const chunks = decoder(Schema.Array(Schema.Struct({ id: numberId })))(
        this.db
          .prepare('SELECT pk AS id FROM file_chunks WHERE root_id=? AND file_record_id=?')
          .all(identity.rootId, identity.fileId)
      );
      for (const chunk of chunks) {
        this.db.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(chunk.id));
      }
      return (
        this.db
          .prepare('DELETE FROM file_records WHERE root_id=? AND id=?')
          .run(identity.rootId, identity.fileId).changes > 0
      );
    })();
  }
}

export class IndexReader {
  readonly db: Database.Database;
  readonly profileHash: string;
  readonly options: IndexerOptions;
  readonly allowed: ReadonlySet<string>;
  constructor(input: unknown) {
    this.options = decoder(optionsSchema)(input);
    this.profileHash = embeddingProfileHash(this.options.profile);
    this.allowed = new Set(this.options.rootIds);
    this.db = openConnection(this.options.dbPath, { fileMustExist: true, readonly: true });
    try {
      loadProfile(this.db, this.options);
      this.db.pragma('query_only = ON');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  prepare(input: unknown): FilePlan {
    const snapshot = decoder(snapshotSchema)(input);
    authorize(this.allowed, [snapshot.rootId]);
    const chunks = fileChunks(snapshot, this.options.profile);
    return this.db.transaction(() => {
      const existing = existingFile(this.db, snapshot);
      const cached = new Map(
        decodeChunks(
          this.db
            .prepare(
              'SELECT id AS chunkId,embedding_hash AS embeddingHash FROM file_chunks WHERE root_id=? AND file_record_id=?'
            )
            .all(snapshot.rootId, snapshot.fileId)
        ).map((chunk) => [chunk.chunkId, chunk.embeddingHash])
      );
      return decoder(planSchema)({
        chunks,
        contentHash: sha256(snapshot.content),
        embeddingChunkIds: chunks
          .filter((chunk) => cached.get(chunk.chunkId) !== chunk.embeddingHash)
          .map((chunk) => chunk.chunkId),
        previousSnapshotHash: existing?.snapshotHash ?? null,
        profileHash: this.profileHash,
        snapshot,
        unchanged: existing?.snapshotHash === snapshotHash(snapshot),
      });
    })();
  }
  search(input: unknown): SearchResult {
    const request = decoder(searchSchema)(input);
    authorize(this.allowed, request.rootIds);
    if (
      request.mode === 'vector'
        ? !(request.vector && request.profile) || request.text !== undefined
        : request.text === undefined ||
          request.vector !== undefined ||
          request.profile !== undefined
    ) {
      throw new TypeError('Search must carry only the input required by its mode.');
    }
    if (request.profile && embeddingProfileHash(request.profile) !== this.profileHash) {
      throw new IndexerError(
        'rebuild-required',
        'Query embedding profile differs from this index.'
      );
    }
    const q = request.vector ? vectorBlob(request.vector) : undefined;
    const text = request.text ?? '';
    const expression =
      request.mode === 'trigram'
        ? quote(text)
        : (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map(quote).join(' OR ');
    if (
      request.rootIds.length === 0 ||
      (request.mode === 'trigram' && [...text].length < 3) ||
      (request.mode === 'bm25' && !expression)
    ) {
      return { candidateCount: 0, hits: [], profileHash: this.profileHash };
    }
    return this.db.transaction(() => {
      const hits: SearchResult['hits'][number][] = [];
      let candidateCount = 0;
      for (const root of new Set(request.rootIds)) {
        if (request.mode === 'vector') {
          const candidates = decoder(
            Schema.Array(Schema.Struct({ id: numberId, score: Schema.Finite }))
          )(
            this.db
              .prepare(
                'SELECT id,vec_distance_cosine(emb,@q) AS score FROM (SELECT id,emb FROM vec_chunks WHERE bin MATCH vec_quantize_binary(@q) AND k=100 AND root_id=@root) ORDER BY score,id'
              )
              .all({ q, root })
          );
          candidateCount += candidates.length;
          for (const candidate of candidates) {
            const row = this.db
              .prepare(
                `SELECT ${hitColumns},? AS score FROM file_chunks c JOIN file_records f ON f.root_id=c.root_id AND f.id=c.file_record_id WHERE c.pk=? AND c.root_id=?`
              )
              .get(candidate.score, BigInt(candidate.id), root);
            hits.push(decodeHit(row));
          }
        } else {
          const table = request.mode === 'bm25' ? 'file_chunks_fts' : 'file_chunks_trigram';
          const rows = this.db
            .prepare(
              `SELECT ${hitColumns},bm25(${table}) AS score FROM ${table} JOIN file_chunks c ON c.pk=${table}.rowid JOIN file_records f ON f.root_id=c.root_id AND f.id=c.file_record_id WHERE ${table} MATCH ? AND c.root_id=? ORDER BY score,c.id LIMIT ?`
            )
            .all(expression, root, request.limit);
          candidateCount += rows.length;
          hits.push(...rows.map(decodeHit));
        }
      }
      hits.sort((a, b) => a.score - b.score || a.chunkId.localeCompare(b.chunkId));
      return { candidateCount, hits: hits.slice(0, request.limit), profileHash: this.profileHash };
    })();
  }
}
