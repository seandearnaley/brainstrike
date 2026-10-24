import { TOMBSTONE_BODY, withSeq } from '@brainstrike/state-store/run-log-format';
import type { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { checkedTruncateCheckpoint } from './checked-checkpoint.js';
import { float32Bytes, sha256 } from './chunks.js';
import {
  authorize,
  decoder,
  IndexerError,
  type IndexerOptions,
  type StateMessageHit,
  type StateMessagePlan,
  type StateMessagePrepare,
  type StateMessageScope,
  type StateMessageSource,
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
const sourceSchema = Schema.Struct({ hash: Schema.String, pk: Schema.Int, seq: Schema.Int });
/** A message's source rows, ascending, each with its committed bytes. */
type SourceRows = readonly (readonly [seq: number, raw: string])[];

interface CanonicalMessages {
  readonly messages: readonly StateMessageSource[];
  /** Every committed row of the thread, by seq. */
  readonly raws: ReadonlyMap<number, string>;
}

/**
 * A thread's canonical messages, projected from its whole committed truth. A
 * message's own row carries text (never purged or unreadable), and its sources
 * are committed rows of the thread.
 */
function canonicalMessages(
  truth: StateTruthReader,
  projection: StateProjection,
  threadId: string
): CanonicalMessages {
  if (!projection.messages) {
    throw new IndexerError(
      'message-projection-required',
      'The trusted producer has no canonical message projection.'
    );
  }
  const tail = truth.watermark(threadId);
  const rows: StateMessageEvent[] = [];
  const raws = new Map<number, string>();
  const texts = new Set<number>();
  let next = 1;
  while (next <= tail) {
    const page = [...truth.read(threadId, next, tail)];
    if (page.length === 0) {
      throw new Error('Message truth ended before its committed watermark');
    }
    for (const row of page) {
      if (row.kind !== 'event' || row.seq !== next) {
        throw new Error('Message truth has a CRC or contiguous-sequence gap');
      }
      const projected = projection.decode(row.raw);
      if (projected.seq !== row.seq) {
        throw new Error('Message truth has a committed sequence identity gap');
      }
      rows.push({ event: projection.event(row.raw), seq: row.seq, threadId });
      raws.set(row.seq, row.raw);
      // Purged and prod-unreadable rows can never supply an embedding source.
      if (projected.text !== null) {
        texts.add(row.seq);
      }
      next++;
    }
  }
  const messages = projection.messages(rows);
  checkMessages(messages, raws, texts);
  return { messages, raws };
}

function checkMessages(
  messages: readonly StateMessageSource[],
  raws: ReadonlyMap<number, string>,
  texts: ReadonlySet<number>
): void {
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.messageId) || !texts.has(message.seq)) {
      throw new Error('Canonical message projection has duplicate IDs or missing/purged truth');
    }
    if (!message.sources.includes(message.seq) || message.sources.some((seq) => !raws.has(seq))) {
      throw new Error('Canonical message sources must be committed rows that include its own');
    }
    ids.add(message.messageId);
  }
}

function sourceRows(canonical: CanonicalMessages, message: StateMessageSource): SourceRows {
  return [...new Set(message.sources)]
    .sort((a, b) => a - b)
    .map((seq) => {
      const raw = canonical.raws.get(seq);
      if (raw === undefined) {
        throw new Error('Canonical message source is missing');
      }
      return [seq, raw] as const;
    });
}

/**
 * The workspace index's one profile rule (`vectorProfileHash`: local dtype
 * required, revision and token cap optional, every field hashed). Memory ranks
 * by cosine, so that is the only additional requirement.
 */
export function profileHash(profile: VectorProfile): string {
  if (profile.distance !== 'cosine') {
    throw new IndexerError('unsupported-profile', 'Message vectors require a cosine profile.');
  }
  return vectorProfileHash(profile);
}
export function vectorBytes(vector: readonly number[], dimensions: number): Uint8Array {
  if (vector.length !== dimensions) {
    throw new TypeError('Message vector dimensions disagree with the complete profile.');
  }
  const emb = float32Bytes(vector);
  validateStoredVectorBytes({ dimensions, emb });
  return emb;
}

/** Derived leaf on the existing writer connection; no inference or transcript writer. */
export class StateMessageVectors {
  static readonly definitions = [
    {
      name: 'state_message_generation',
      sql: 'CREATE TABLE state_message_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL CHECK(generation>=0),pending_cleanup INTEGER NOT NULL CHECK(pending_cleanup IN (0,1)))',
    },
    {
      name: 'state_message_profiles',
      sql: 'CREATE TABLE state_message_profiles(hash TEXT PRIMARY KEY,json TEXT NOT NULL,dimensions INTEGER NOT NULL CHECK(dimensions>0))',
    },
    {
      name: 'state_message_vectors',
      sql: `CREATE TABLE state_message_vectors(
        pk INTEGER PRIMARY KEY,root_id TEXT NOT NULL,resource_id TEXT NOT NULL,thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),segment_ordinal INTEGER NOT NULL CHECK(segment_ordinal>=0),
        profile_hash TEXT NOT NULL REFERENCES state_message_profiles(hash),source_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,emb BLOB NOT NULL CHECK(length(emb)=dimensions*4),
        UNIQUE(thread_id,message_id,segment_ordinal,profile_hash))`,
    },
    {
      name: 'state_message_scope',
      sql: 'CREATE INDEX state_message_scope ON state_message_vectors(root_id,resource_id,thread_id,profile_hash)',
    },
  ] as const;
  /**
   * Schema 15: the committed rows each vector's message identity was read
   * from, with their hashes when it was written (`StateMessageSource`).
   */
  static readonly sourcesDefinition =
    'CREATE TABLE state_message_sources(vector_pk INTEGER NOT NULL REFERENCES state_message_vectors(pk) ON DELETE CASCADE,seq INTEGER NOT NULL CHECK(seq>0),hash TEXT NOT NULL,PRIMARY KEY(vector_pk,seq)) WITHOUT ROWID';
  static initialize(db: Database.Database): void {
    for (const { sql } of StateMessageVectors.definitions) {
      db.exec(sql);
    }
    db.exec('INSERT INTO state_message_generation VALUES(1,0,0)');
  }

  constructor(
    private readonly db: Database.Database,
    private readonly truth: StateTruthReader,
    private readonly projection: StateProjection,
    private readonly options: IndexerOptions
  ) {
    StateMessageVectors.validateStorage(db);
  }

  static validateStorage(db: Database.Database): void {
    const generation = decoder(
      Schema.Array(
        Schema.Struct({
          generation: Schema.Int.check(
            Schema.isGreaterThanOrEqualTo(0),
            Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
          ),
          pendingCleanup: Schema.Literals([0, 1]),
          singleton: Schema.Literal(1),
        })
      )
    )(
      db
        .prepare(
          'SELECT singleton,generation,pending_cleanup AS pendingCleanup FROM state_message_generation'
        )
        .all()
    );
    if (generation.length !== 1) {
      throw new IndexerError('rebuild-required', 'Stored message generation is invalid.');
    }
    for (const input of db
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
    for (const input of db
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
    // A vector's own row is always among its sources, so none is authorized by an empty set.
    if (
      db
        .prepare(
          'SELECT count(*) FROM state_message_vectors v WHERE NOT EXISTS (SELECT 1 FROM state_message_sources s WHERE s.vector_pk=v.pk AND s.seq=v.seq AND s.hash=v.source_hash)'
        )
        .pluck()
        .get() !== 0
    ) {
      throw new IndexerError('rebuild-required', 'Stored message vector has no recorded source.');
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
  /** An acquired Root/resource with a complete request profile; vectors partition by its hash. */
  selectedProfile(scope: StateMessageScope, profile: VectorProfile): void {
    this.grant(scope);
    profileHash(profile);
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
  /** Each requested message must be an exact committed canonical member of its thread. */
  private admit(request: StateMessagePrepare): {
    readonly plan: StateMessagePlan;
    readonly sources: ReadonlyMap<string, SourceRows>;
  } {
    this.members(request.scope);
    const canonical = canonicalMessages(this.truth, this.projection, request.scope.threadId);
    const sources = new Map<string, SourceRows>();
    for (const message of request.messages) {
      const current = canonical.messages.find(
        (candidate) => candidate.messageId === message.messageId && candidate.seq === message.seq
      );
      if (sources.has(message.messageId) || !current) {
        throw new IndexerError(
          'message-not-authorized',
          'Message is not an exact committed canonical member.'
        );
      }
      sources.set(message.messageId, sourceRows(canonical, current));
    }
    return {
      plan: {
        ...request,
        generation: this.generation(),
        storeId: readIndexIdentity(this.db).storeId,
        truthHash: sha256(JSON.stringify([...sources.values()])),
      },
      sources,
    };
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
    return this.truth.snapshot(() => this.admit(request).plan);
  }
  upsert(input: unknown): StateMessageUpsertResult {
    const { plan, embeddings } = decoder(stateMessageUpsertSchema)(input);
    this.assertReady();
    this.selectedProfile(plan.scope, plan.profile);
    return this.truth.snapshot(() =>
      this.db.transaction(() => {
        const current = this.admit({
          messages: plan.messages,
          profile: plan.profile,
          scope: plan.scope,
        });
        if (
          JSON.stringify(decoder(stateMessagePlanSchema)(plan)) !==
          JSON.stringify(decoder(stateMessagePlanSchema)(current.plan))
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
        const insertSource = this.db.prepare('INSERT INTO state_message_sources VALUES(?,?,?)');
        const result: StateMessageUpsertResult[number][] = [];
        for (const { message, vectors } of prepared) {
          const sources = (current.sources.get(message.messageId) ?? []).map(
            ([seq, raw]) => [seq, sha256(raw)] as const
          );
          const own = sources.find(([seq]) => seq === message.seq);
          if (!own) {
            throw new Error('Message source disappeared before vector commit');
          }
          this.db
            .prepare(
              'DELETE FROM state_message_vectors WHERE thread_id=? AND message_id=? AND profile_hash=?'
            )
            .run(plan.scope.threadId, message.messageId, profile);
          vectors.forEach((emb, segmentOrdinal) => {
            const pk = decoder(Schema.Int)(
              this.db
                .prepare(
                  'INSERT INTO state_message_vectors(root_id,resource_id,thread_id,message_id,seq,segment_ordinal,profile_hash,source_hash,dimensions,emb) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING pk'
                )
                .pluck()
                .get(
                  plan.scope.rootId,
                  plan.scope.resourceId,
                  plan.scope.threadId,
                  message.messageId,
                  message.seq,
                  segmentOrdinal,
                  profile,
                  own[1],
                  plan.profile.dimensions,
                  emb
                )
            );
            for (const [seq, hash] of sources) {
              insertSource.run(pk, seq, hash);
            }
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
        const rows = decoder(Schema.Array(rowSchema))(
          this.db
            .prepare(
              `SELECT ${columns} FROM state_message_vectors WHERE root_id=? AND resource_id=? AND profile_hash=? AND thread_id IN (SELECT value FROM json_each(?))`
            )
            .all(request.scope.rootId, request.scope.resourceId, hash, JSON.stringify(threads))
        );
        const recorded = new Map<number, { readonly hash: string; readonly seq: number }[]>();
        for (const source of decoder(Schema.Array(sourceSchema))(
          this.db
            .prepare(
              'SELECT vector_pk AS pk,seq,hash FROM state_message_sources WHERE vector_pk IN (SELECT value FROM json_each(?))'
            )
            .all(JSON.stringify(rows.map((row) => row.pk)))
        )) {
          recorded.set(source.pk, [...(recorded.get(source.pk) ?? []), source]);
        }
        // A candidate is re-proven by the committed bytes of only the rows its identity
        // was read from: while they are unchanged, appends cannot retract it. Projecting
        // the threads' whole truth made each recall's cost their history, in the one writer.
        const committed = new Map<string, boolean>();
        const holds = (threadId: string, source: { hash: string; seq: number }): boolean => {
          const key = JSON.stringify([threadId, source.seq, source.hash]);
          const known = committed.get(key);
          if (known !== undefined) {
            return known;
          }
          const row = this.truth.read(threadId, source.seq, source.seq).next().value;
          if (row?.kind !== 'event' || row.seq !== source.seq) {
            throw new Error('Message truth has a CRC or contiguous-sequence gap');
          }
          const unchanged = sha256(row.raw) === source.hash;
          // A purge leaves only its tombstone: the message and its dependents are retracted.
          if (!(unchanged || row.raw === withSeq(source.seq, TOMBSTONE_BODY))) {
            if (this.projection.decode(row.raw).seq !== source.seq) {
              throw new Error('Message truth has a committed sequence identity gap');
            }
            throw new Error('Message truth changed under its recorded source');
          }
          committed.set(key, unchanged);
          return unchanged;
        };
        const authorized: number[] = [];
        for (const row of rows) {
          validateStoredVectorBytes({ dimensions: row.dimensions, emb: row.emb });
          if (row.dimensions !== request.profile.dimensions) {
            throw new IndexerError(
              'rebuild-required',
              'Stored message vector profile dimensions disagree.'
            );
          }
          const sources = [{ hash: row.sourceHash, seq: row.seq }, ...(recorded.get(row.pk) ?? [])];
          if (sources.every((source) => holds(row.threadId, source))) {
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
