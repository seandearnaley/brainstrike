import type { SqliteReader } from '@brainstrike/state-store';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { checkedTruncateCheckpoint } from './checked-checkpoint.js';
import { sha256 } from './chunks.js';
import {
  authorize,
  decoder,
  IndexerError,
  type IndexerOptions,
  type StateMessageHit,
  type StateMessageIdentity,
  type StateMessagePlan,
  type StateMessageScope,
  type StateMessageUpsertResult,
  stateMessageHitSchema,
  stateMessagePlanSchema,
  stateMessagePrepareSchema,
  stateMessagePurgeSchema,
  stateMessageQuerySchema,
  stateMessageUpsertSchema,
  type VectorProfile,
  vectorProfileSchema,
} from './contracts.js';
import { readIndexIdentity } from './index-metadata.js';
import { vectorProfileHash } from './scope-authority.js';
import { validateStoredVectorBytes } from './scoped-vector-validation.js';
import type { StateMessageEvent, StateProjection } from './state-projection.js';

const rowSchema = Schema.Struct({
  dimensions: Schema.Int,
  emb: Schema.Uint8Array,
  messageId: Schema.String,
  pk: Schema.Int,
  segmentOrdinal: Schema.Int,
  seq: Schema.Int,
  sourceHash: Schema.String,
  threadId: Schema.String,
});
const columns =
  'pk,thread_id AS threadId,message_id AS messageId,seq,segment_ordinal AS segmentOrdinal,source_hash AS sourceHash,dimensions,emb';

export function profileHash(profile: VectorProfile): string {
  if (
    profile.distance !== 'cosine' ||
    ('provider' in profile &&
      (profile.provider === 'local' || profile.provider === 'transformers') &&
      !(profile.revision && profile.dtype && profile.tokenCap))
  ) {
    throw new IndexerError(
      'unsupported-profile',
      'Message vectors require cosine and a complete immutable profile.'
    );
  }
  return vectorProfileHash(profile);
}
export function vectorBytes(vector: readonly number[], dimensions: number): Buffer {
  if (vector.length !== dimensions) {
    throw new TypeError('Message vector dimensions disagree with the complete profile.');
  }
  const emb = Buffer.alloc(dimensions * 4);
  vector.forEach((value, index) => {
    emb.writeFloatLE(value, index * 4);
  });
  validateStoredVectorBytes({ dimensions, emb });
  return emb;
}

/** Derived leaf on the existing writer connection; no inference or transcript writer. */
export class StateMessageVectors {
  static initialize(db: Database.Database): void {
    db.exec(`
      CREATE TABLE state_message_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL CHECK(generation>=0),pending_cleanup INTEGER NOT NULL CHECK(pending_cleanup IN (0,1)));
      INSERT INTO state_message_generation VALUES(1,0,0);
      CREATE TABLE state_message_profiles(hash TEXT PRIMARY KEY,json TEXT NOT NULL,dimensions INTEGER NOT NULL CHECK(dimensions>0));
      CREATE TABLE state_message_vectors(
        pk INTEGER PRIMARY KEY,root_id TEXT NOT NULL,resource_id TEXT NOT NULL,thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),segment_ordinal INTEGER NOT NULL CHECK(segment_ordinal>=0),
        profile_hash TEXT NOT NULL REFERENCES state_message_profiles(hash),source_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,emb BLOB NOT NULL CHECK(length(emb)=dimensions*4),
        UNIQUE(thread_id,message_id,segment_ordinal,profile_hash));
      CREATE INDEX state_message_scope ON state_message_vectors(root_id,resource_id,thread_id,profile_hash);
    `);
  }

  constructor(
    private readonly db: Database.Database,
    private readonly truth: SqliteReader,
    private readonly projection: StateProjection,
    private readonly options: IndexerOptions
  ) {
    for (const grant of options.stateResources ?? []) {
      profileHash(grant.profile);
    }
    this.validateStorage();
  }

  private validateStorage(): void {
    for (const input of this.db
      .prepare('SELECT hash,json,dimensions FROM state_message_profiles')
      .iterate()) {
      const row = decoder(
        Schema.Struct({ dimensions: Schema.Int, hash: Schema.String, json: Schema.String })
      )(input);
      const profile = decoder(vectorProfileSchema)(JSON.parse(row.json));
      if (profileHash(profile) !== row.hash || profile.dimensions !== row.dimensions) {
        throw new IndexerError('rebuild-required', 'Stored message vector profile disagrees.');
      }
    }
    for (const input of this.db
      .prepare(
        'SELECT v.dimensions,v.emb,p.dimensions AS profileDimensions FROM state_message_vectors v LEFT JOIN state_message_profiles p ON p.hash=v.profile_hash'
      )
      .iterate()) {
      const row = decoder(
        Schema.Struct({
          dimensions: Schema.Int,
          emb: Schema.Uint8Array,
          profileDimensions: Schema.Int,
        })
      )(input);
      if (row.dimensions !== row.profileDimensions) {
        throw new IndexerError('rebuild-required', 'Stored message vector dimensions disagree.');
      }
      validateStoredVectorBytes({ dimensions: row.dimensions, emb: row.emb });
    }
  }

  grant(scope: Pick<StateMessageScope, 'rootId' | 'resourceId'>): void {
    authorize(new Set(this.options.rootIds), [scope.rootId]);
    if (
      !this.options.stateResources?.some(
        (grant) => grant.rootId === scope.rootId && grant.resourceId === scope.resourceId
      )
    ) {
      throw new IndexerError(
        'resource-not-authorized',
        'Memory resource is not acquired by this Root owner.'
      );
    }
  }
  selectedProfile(scope: StateMessageScope, profile: VectorProfile): void {
    this.grant(scope);
    const grant = this.options.stateResources?.find(
      (current) => current.resourceId === scope.resourceId && current.rootId === scope.rootId
    );
    if (!grant || profileHash(grant.profile) !== profileHash(profile)) {
      throw new IndexerError(
        'profile-not-authorized',
        'Message profile differs from its acquired Root/resource selection.'
      );
    }
  }
  members(scope: StateMessageScope): readonly string[] {
    this.grant(scope);
    const threads = this.truth.memoryThreads(scope.resourceId).map((binding) => binding.threadId);
    if (!threads.includes(scope.threadId)) {
      throw new IndexerError(
        'thread-not-authorized',
        'Memory thread is absent, retired, or belongs to another resource.'
      );
    }
    return threads;
  }
  private canonical(threadId: string): {
    messages: readonly StateMessageIdentity[];
    raws: ReadonlyMap<number, string>;
  } {
    if (!this.projection.messages) {
      throw new IndexerError(
        'message-projection-required',
        'The trusted producer has no canonical message projection.'
      );
    }
    const tail = this.truth.watermark(threadId);
    const rows: StateMessageEvent[] = [];
    const raws = new Map<number, string>();
    let next = 1;
    while (next <= tail) {
      const page = [...this.truth.read(threadId, next, tail)];
      if (page.length === 0) {
        throw new Error('Message truth ended before its committed watermark');
      }
      for (const row of page) {
        if (row.kind !== 'event' || row.seq !== next) {
          throw new Error('Message truth has a CRC or contiguous-sequence gap');
        }
        const projected = this.projection.decode(row.raw);
        if (projected.seq !== row.seq) {
          throw new Error('Message truth has a committed sequence identity gap');
        }
        const event = this.projection.event(row.raw);
        rows.push({ event, seq: row.seq, threadId });
        // Purged and prod-unreadable rows can never supply an embedding source.
        if (projected.text !== null) {
          raws.set(row.seq, row.raw);
        }
        next++;
      }
    }
    const messages = this.projection.messages(rows);
    const ids = new Set<string>();
    for (const message of messages) {
      if (ids.has(message.messageId) || !raws.has(message.seq)) {
        throw new Error('Canonical message projection has duplicate IDs or missing/purged truth');
      }
      ids.add(message.messageId);
    }
    return { messages, raws };
  }

  generation(): number {
    return decoder(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
      )
    )(
      this.db
        .prepare('SELECT generation FROM state_message_generation WHERE singleton=1')
        .pluck()
        .get()
    );
  }
  /** Lifecycle operations invalidate inference plans before erasing payloads. */
  invalidate(threadId: string, seq?: number): void {
    this.advance();
    this.db
      .prepare(
        `DELETE FROM state_message_vectors WHERE thread_id=?${seq === undefined ? '' : ' AND seq=?'}`
      )
      .run(threadId, ...(seq === undefined ? [] : [seq]));
  }
  beginOwnerGeneration(): void {
    this.advance(false);
  }
  advance(cleanup = true): void {
    const generation = this.generation();
    if (generation === Number.MAX_SAFE_INTEGER) {
      throw new IndexerError('rebuild-required', 'Message vector generation exhausted.');
    }
    this.db
      .prepare(
        'UPDATE state_message_generation SET generation=?,pending_cleanup=CASE WHEN ? THEN 1 ELSE pending_cleanup END WHERE singleton=1'
      )
      .run(generation + 1, cleanup ? 1 : 0);
  }
  assertReady(): void {
    if (
      this.db
        .prepare('SELECT pending_cleanup FROM state_message_generation WHERE singleton=1')
        .pluck()
        .get() !== 0
    ) {
      throw new IndexerError(
        'message-cleanup-pending',
        'Message vector cleanup failed; retry its owned lifecycle before admitting work.'
      );
    }
  }
  finishCleanup(): void {
    checkedTruncateCheckpoint(this.db);
    this.db
      .prepare('UPDATE state_message_generation SET pending_cleanup=0 WHERE singleton=1')
      .run();
    try {
      checkedTruncateCheckpoint(this.db);
    } catch (error) {
      this.db
        .prepare('UPDATE state_message_generation SET pending_cleanup=1 WHERE singleton=1')
        .run();
      throw error;
    }
  }
  prepare(input: unknown): StateMessagePlan {
    this.assertReady();
    const request = decoder(stateMessagePrepareSchema)(input);
    this.selectedProfile(request.scope, request.profile);
    return this.truth.snapshot(() => {
      this.members(request.scope);
      const canonical = this.canonical(request.scope.threadId);
      const ids = new Set<string>();
      const sources: string[] = [];
      for (const message of request.messages) {
        if (
          ids.has(message.messageId) ||
          !canonical.messages.some(
            (current) => current.messageId === message.messageId && current.seq === message.seq
          )
        ) {
          throw new IndexerError(
            'message-not-authorized',
            'Message is not an exact committed canonical member.'
          );
        }
        ids.add(message.messageId);
        const raw = canonical.raws.get(message.seq);
        if (raw === undefined) {
          throw new Error('Canonical message source is missing');
        }
        sources.push(raw);
      }
      return {
        ...request,
        generation: this.generation(),
        storeId: readIndexIdentity(this.db).storeId,
        truthHash: sha256(JSON.stringify(sources)),
      };
    });
  }
  upsert(input: unknown): StateMessageUpsertResult {
    const { plan, embeddings } = decoder(stateMessageUpsertSchema)(input);
    return this.truth.snapshot(() =>
      this.db.transaction(() => {
        const current = this.prepare({
          messages: plan.messages,
          profile: plan.profile,
          scope: plan.scope,
        });
        if (
          JSON.stringify(decoder(stateMessagePlanSchema)(plan)) !==
          JSON.stringify(decoder(stateMessagePlanSchema)(current))
        ) {
          throw new IndexerError(
            'stale-message-plan',
            'Message inference plan was retired or its committed truth changed.'
          );
        }
        const profile = profileHash(plan.profile);
        const batches = new Map(embeddings.map((item) => [item.messageId, item.vectors]));
        if (
          batches.size !== embeddings.length ||
          batches.size !== plan.messages.length ||
          plan.messages.some((message) => !batches.has(message.messageId))
        ) {
          throw new TypeError(
            'Message vector batch must cover each prepared message exactly once.'
          );
        }
        // Validate the complete batch before replacing any message's segments.
        const prepared = plan.messages.map((message) => ({
          message,
          vectors: (batches.get(message.messageId) ?? []).map((vector) =>
            vectorBytes(vector, plan.profile.dimensions)
          ),
        }));
        this.db
          .prepare('INSERT INTO state_message_profiles VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING')
          .run(profile, JSON.stringify(plan.profile), plan.profile.dimensions);
        const result: StateMessageUpsertResult[number][] = [];
        for (const { message, vectors } of prepared) {
          const raw = this.truth.read(plan.scope.threadId, message.seq, message.seq).next().value;
          if (raw?.kind !== 'event') {
            throw new Error('Message source disappeared before vector commit');
          }
          this.db
            .prepare(
              'DELETE FROM state_message_vectors WHERE thread_id=? AND message_id=? AND profile_hash=?'
            )
            .run(plan.scope.threadId, message.messageId, profile);
          vectors.forEach((emb, segmentOrdinal) => {
            this.db
              .prepare(
                'INSERT INTO state_message_vectors(root_id,resource_id,thread_id,message_id,seq,segment_ordinal,profile_hash,source_hash,dimensions,emb) VALUES(?,?,?,?,?,?,?,?,?,?)'
              )
              .run(
                plan.scope.rootId,
                plan.scope.resourceId,
                plan.scope.threadId,
                message.messageId,
                message.seq,
                segmentOrdinal,
                profile,
                sha256(raw.raw),
                plan.profile.dimensions,
                emb
              );
            result.push({ ...message, segmentOrdinal });
          });
        }
        return result;
      })()
    );
  }

  query(input: unknown): readonly StateMessageHit[] {
    this.assertReady();
    const request = decoder(stateMessageQuerySchema)(input);
    this.selectedProfile(request.scope, request.profile);
    const hash = profileHash(request.profile);
    const vector = vectorBytes(request.vector, request.profile.dimensions);
    return this.truth.snapshot(() =>
      this.db.transaction(() => {
        const members = this.members(request.scope);
        const threads = [...new Set(request.threadIds ?? members)];
        if (threads.some((thread) => !members.includes(thread))) {
          throw new IndexerError(
            'thread-not-authorized',
            'Query thread belongs to another Memory resource or is retired.'
          );
        }
        const canonical = new Map(threads.map((threadId) => [threadId, this.canonical(threadId)]));
        const rows = decoder(Schema.Array(rowSchema))(
          this.db
            .prepare(
              `SELECT ${columns} FROM state_message_vectors WHERE root_id=? AND resource_id=? AND profile_hash=? AND thread_id IN (SELECT value FROM json_each(?))`
            )
            .all(request.scope.rootId, request.scope.resourceId, hash, JSON.stringify(threads))
        );
        const authorized: number[] = [];
        for (const row of rows) {
          validateStoredVectorBytes({ dimensions: row.dimensions, emb: row.emb });
          if (row.dimensions !== request.profile.dimensions) {
            throw new IndexerError(
              'rebuild-required',
              'Stored message vector profile dimensions disagree.'
            );
          }
          const truth = canonical.get(row.threadId);
          const raw = truth?.raws.get(row.seq);
          if (
            raw !== undefined &&
            row.sourceHash === sha256(raw) &&
            truth?.messages.some(
              (message) => message.messageId === row.messageId && message.seq === row.seq
            )
          ) {
            authorized.push(row.pk);
          }
        }
        // Membership is established before distance evaluation and LIMIT, including missing truth.
        return decoder(Schema.Array(stateMessageHitSchema))(
          this.db
            .prepare(`
        SELECT message_id AS messageId,thread_id AS threadId,seq,segment_ordinal AS segmentOrdinal,
          max(-1,min(1,1-vec_distance_cosine(emb,?))) AS score FROM state_message_vectors
        WHERE pk IN (SELECT value FROM json_each(?))
        ORDER BY score DESC,thread_id,message_id,segment_ordinal LIMIT ?
      `)
            .all(vector, JSON.stringify(authorized), request.limit)
        );
      })()
    );
  }

  purge(input: unknown): boolean {
    const scope = decoder(stateMessagePurgeSchema)(input);
    this.grant(scope);
    const changed = this.db.transaction(() => {
      this.advance();
      return (
        this.db
          .prepare(
            `DELETE FROM state_message_vectors WHERE root_id=? AND resource_id=?${scope.threadId === undefined ? '' : ' AND thread_id=?'}`
          )
          .run(
            scope.rootId,
            scope.resourceId,
            ...(scope.threadId === undefined ? [] : [scope.threadId])
          ).changes > 0
      );
    })();
    this.finishCleanup();
    return changed;
  }
}
