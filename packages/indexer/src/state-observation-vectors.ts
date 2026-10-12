import { createHash } from 'node:crypto';
import type { SqliteReader } from '@brainstrike/state-store';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { sha256 } from './chunks.js';
import {
  decoder,
  IndexerError,
  type StateObservationGroup,
  type StateObservationHit,
  type StateObservationPlan,
  type StateObservationQuery,
  stateObservationHitSchema,
  stateObservationPlanSchema,
  stateObservationPrepareSchema,
  stateObservationPurgeSchema,
  stateObservationQuerySchema,
  stateObservationUpsertSchema,
} from './contracts.js';
import { readIndexIdentity } from './index-metadata.js';
import { validateStoredVectorBytes } from './scoped-vector-validation.js';
import { profileHash, type StateMessageVectors, vectorBytes } from './state-message-vectors.js';
import type { StateProjection } from './state-projection.js';

const rowSchema = Schema.Struct({
  dimensions: Schema.Int,
  emb: Schema.Uint8Array,
  groupId: Schema.String,
  id: Schema.String,
  observedAt: Schema.NullOr(Schema.String),
  pk: Schema.Int,
  range: Schema.String,
  resourceId: Schema.String,
  segmentOrdinal: Schema.Int,
  sourceHash: Schema.String,
  text: Schema.String,
  threadId: Schema.String,
});
type Row = typeof rowSchema.Type;
const columns =
  'pk,id,resource_id AS resourceId,thread_id AS threadId,group_id AS groupId,range,segment_ordinal AS segmentOrdinal,source_hash AS sourceHash,text,observed_at AS observedAt,dimensions,emb';
interface Source {
  group: StateObservationGroup;
  hash: string;
  recordIds: string[];
}
const key = (threadId: string, groupId: string): string => JSON.stringify([threadId, groupId]);

/** Verify the existing native ID algorithm, not a new durable identity.
 * https://github.com/mastra-ai/mastra/blob/@mastra/memory@1.32.1/packages/memory/src/index.ts
 */
function nativeId(resourceId: string, threadId: string, groupId: string, ordinal: number): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([resourceId, threadId, groupId, ordinal]))
    .digest();
  hash[6] = ((hash[6] ?? 0) & 15) | 128;
  hash[8] = ((hash[8] ?? 0) & 63) | 128;
  const hex = hash.toString('hex', 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Derived native OM payloads on the same SQLite writer and admission generation. */
export class StateObservationVectors {
  static initialize(db: Database.Database): void {
    db.exec(`CREATE TABLE state_observation_vectors(
      pk INTEGER PRIMARY KEY,id TEXT NOT NULL,root_id TEXT NOT NULL,resource_id TEXT NOT NULL,thread_id TEXT NOT NULL,
      group_id TEXT NOT NULL,range TEXT NOT NULL,segment_ordinal INTEGER NOT NULL CHECK(segment_ordinal>=0),
      profile_hash TEXT NOT NULL REFERENCES state_message_profiles(hash),source_hash TEXT NOT NULL,
      text TEXT NOT NULL,observed_at TEXT,dimensions INTEGER NOT NULL CHECK(dimensions>0),
      emb BLOB NOT NULL CHECK(length(emb)=dimensions*4),UNIQUE(id,profile_hash));
      CREATE INDEX state_observation_scope ON state_observation_vectors(root_id,resource_id,thread_id,profile_hash);`);
  }

  constructor(
    private readonly db: Database.Database,
    private readonly truth: SqliteReader,
    private readonly projection: StateProjection,
    private readonly lifecycle: StateMessageVectors
  ) {
    for (const input of db
      .prepare(
        `SELECT ${columns},(SELECT p.dimensions FROM state_message_profiles p WHERE p.hash=v.profile_hash) AS profileDimensions FROM state_observation_vectors v`
      )
      .iterate()) {
      const row = decoder(Schema.Struct({ ...rowSchema.fields, profileDimensions: Schema.Int }))(
        input
      );
      if (
        row.dimensions !== row.profileDimensions ||
        row.segmentOrdinal < 0 ||
        !Number.isSafeInteger(row.segmentOrdinal) ||
        row.id !== nativeId(row.resourceId, row.threadId, row.groupId, row.segmentOrdinal)
      ) {
        throw new IndexerError(
          'rebuild-required',
          'Stored observation vector identity/dimensions disagree.'
        );
      }
      validateStoredVectorBytes({ dimensions: row.dimensions, emb: row.emb });
      decoder(stateObservationHitSchema)({ id: row.id, metadata: this.metadata(row), score: 0 });
    }
  }

  private metadata(row: Row): StateObservationHit['metadata'] {
    return {
      // biome-ignore lint/style/useNamingConvention: Pinned public Memory metadata field.
      group_id: row.groupId,
      range: row.range,
      // biome-ignore lint/style/useNamingConvention: Pinned public Memory metadata field.
      resource_id: row.resourceId,
      text: row.text,
      // biome-ignore lint/style/useNamingConvention: Pinned public Memory metadata field.
      thread_id: row.threadId,
      ...(row.observedAt === null
        ? {}
        : {
            // biome-ignore lint/style/useNamingConvention: Pinned public Memory invocation metadata field.
            observed_at: row.observedAt,
          }),
    };
  }

  private addSource(
    result: Map<string, Source>,
    resourceId: string,
    recordId: string,
    group: StateObservationGroup
  ): void {
    const identity = key(group.threadId, group.groupId);
    const hash = sha256(
      JSON.stringify([resourceId, group.threadId, group.groupId, group.range, group.text])
    );
    const previous = result.get(identity);
    if (previous && previous.hash !== hash) {
      throw new IndexerError(
        'observation-not-authorized',
        'One native observation identity has conflicting committed source facts.'
      );
    }
    if (previous) {
      if (!previous.recordIds.includes(recordId)) {
        previous.recordIds.push(recordId);
      }
    } else {
      result.set(identity, { group, hash, recordIds: [recordId] });
    }
  }

  /**
   * The resource's committed groups. A group attributed to `retiredThread`,
   * the thread being deleted, is dropped with it; any other group whose thread
   * is not a member still refuses.
   */
  private canonical(resourceId: string, retiredThread?: string): Map<string, Source> {
    if (!(this.projection.observations && this.projection.observationChunks)) {
      throw new IndexerError(
        'observation-projection-required',
        'The trusted producer has no committed observation/native chunk projection.'
      );
    }
    const members = new Set(this.truth.memoryThreads(resourceId).map((row) => row.threadId));
    const result = new Map<string, Source>();
    for (const record of this.truth.memoryObservations(resourceId)) {
      for (const group of this.projection.observations(record)) {
        if (record.threadId === null && group.threadId === retiredThread) {
          continue;
        }
        if (
          !members.has(group.threadId) ||
          (record.threadId !== null && record.threadId !== group.threadId)
        ) {
          throw new IndexerError(
            'observation-not-authorized',
            'Committed observation attribution crosses its relational owner.'
          );
        }
        this.addSource(result, resourceId, record.id, group);
      }
    }
    for (const source of result.values()) {
      source.recordIds.sort();
    }
    return result;
  }

  prepare(input: unknown): StateObservationPlan {
    this.lifecycle.assertReady();
    const request = decoder(stateObservationPrepareSchema)(input);
    this.lifecycle.selectedProfile(request.scope, request.profile);
    return this.truth.snapshot(() => {
      this.lifecycle.members(request.scope);
      const { observation } = request;
      const source = this.canonical(request.scope.resourceId).get(
        key(observation.threadId, observation.groupId)
      );
      if (
        !source ||
        source.group.text !== observation.text ||
        source.group.range !== observation.range
      ) {
        throw new IndexerError(
          'observation-not-authorized',
          'Observation is not an exact committed native group.'
        );
      }
      return decoder(stateObservationPlanSchema)({
        ...request,
        chunks: this.projection.observationChunks?.(source.group.text),
        generation: this.lifecycle.generation(),
        recordIds: source.recordIds,
        storeId: readIndexIdentity(this.db).storeId,
        truthHash: source.hash,
      });
    });
  }

  upsert(input: unknown): readonly string[] {
    const { plan, segments } = decoder(stateObservationUpsertSchema)(input);
    return this.truth.snapshot(() =>
      this.db.transaction(() => {
        const current = this.prepare({
          observation: plan.observation,
          profile: plan.profile,
          scope: plan.scope,
        });
        if (JSON.stringify(decoder(stateObservationPlanSchema)(plan)) !== JSON.stringify(current)) {
          throw new IndexerError(
            'stale-observation-plan',
            'Observation plan was retired or its committed source/chunks changed.'
          );
        }
        if (
          segments.length !== plan.chunks.length ||
          segments.some(
            (segment, ordinal) =>
              segment.text !== plan.chunks[ordinal] ||
              segment.id !==
                nativeId(
                  plan.scope.resourceId,
                  plan.observation.threadId,
                  plan.observation.groupId,
                  ordinal
                )
          )
        ) {
          throw new IndexerError(
            'observation-not-authorized',
            'Observation segments disagree with prepared native chunks/identities.'
          );
        }
        const prepared = segments.map((segment) => ({
          ...segment,
          emb: vectorBytes(segment.vector, plan.profile.dimensions),
        }));
        const hash = profileHash(plan.profile);
        this.db
          .prepare('INSERT INTO state_message_profiles VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING')
          .run(hash, JSON.stringify(plan.profile), plan.profile.dimensions);
        this.db
          .prepare(
            'DELETE FROM state_observation_vectors WHERE root_id=? AND resource_id=? AND thread_id=? AND group_id=? AND profile_hash=?'
          )
          .run(
            plan.scope.rootId,
            plan.scope.resourceId,
            plan.observation.threadId,
            plan.observation.groupId,
            hash
          );
        prepared.forEach((segment, ordinal) => {
          this.db
            .prepare(
              'INSERT INTO state_observation_vectors(id,root_id,resource_id,thread_id,group_id,range,segment_ordinal,profile_hash,source_hash,text,observed_at,dimensions,emb) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
            )
            .run(
              segment.id,
              plan.scope.rootId,
              plan.scope.resourceId,
              plan.observation.threadId,
              plan.observation.groupId,
              plan.observation.range,
              ordinal,
              hash,
              plan.truthHash,
              segment.text,
              plan.observation.observedAt ?? null,
              plan.profile.dimensions,
              segment.emb
            );
        });
        return prepared.map((segment) => segment.id);
      })()
    );
  }

  private matchesSource(row: Row, source: Source | undefined): boolean {
    return (
      source !== undefined &&
      source.hash === row.sourceHash &&
      source.group.range === row.range &&
      row.id === nativeId(row.resourceId, row.threadId, row.groupId, row.segmentOrdinal) &&
      this.projection.observationChunks?.(source.group.text)[row.segmentOrdinal] === row.text
    );
  }

  private matchesDate(row: Row, request: StateObservationQuery): boolean {
    // Native invocation dates filter authorized members before distance evaluation or LIMIT.
    const date = row.observedAt === null ? undefined : new Date(row.observedAt).getTime();
    return !(
      (request.observedAfter !== undefined &&
        (date === undefined || date <= new Date(request.observedAfter).getTime())) ||
      (request.observedBefore !== undefined &&
        (date === undefined || date >= new Date(request.observedBefore).getTime()))
    );
  }

  query(input: unknown): readonly StateObservationHit[] {
    this.lifecycle.assertReady();
    const request = decoder(stateObservationQuerySchema)(input);
    this.lifecycle.selectedProfile(request.scope, request.profile);
    const hash = profileHash(request.profile);
    const vector = vectorBytes(request.vector, request.profile.dimensions);
    return this.truth.snapshot(() =>
      this.db.transaction(() => {
        const members = this.lifecycle.members(request.scope);
        const threads = [...new Set(request.threadIds ?? members)];
        if (threads.some((thread) => !members.includes(thread))) {
          throw new IndexerError(
            'thread-not-authorized',
            'Observation query thread belongs to another resource or is retired.'
          );
        }
        const canonical = this.canonical(request.scope.resourceId);
        const rows = decoder(Schema.Array(rowSchema))(
          this.db
            .prepare(
              `SELECT ${columns} FROM state_observation_vectors WHERE root_id=? AND resource_id=? AND profile_hash=? AND thread_id IN (SELECT value FROM json_each(?))`
            )
            .all(request.scope.rootId, request.scope.resourceId, hash, JSON.stringify(threads))
        );
        const authorized: number[] = [];
        for (const row of rows) {
          validateStoredVectorBytes({ dimensions: row.dimensions, emb: row.emb });
          if (row.dimensions !== request.profile.dimensions) {
            throw new IndexerError('rebuild-required', 'Stored observation dimensions disagree.');
          }
          decoder(stateObservationHitSchema)({
            id: row.id,
            metadata: this.metadata(row),
            score: 0,
          });
          if (
            !(
              this.matchesSource(row, canonical.get(key(row.threadId, row.groupId))) &&
              this.matchesDate(row, request)
            )
          ) {
            continue;
          }
          authorized.push(row.pk);
        }
        return this.db
          .prepare(
            `SELECT ${columns},max(-1,min(1,1-vec_distance_cosine(emb,?))) AS score FROM state_observation_vectors WHERE pk IN (SELECT value FROM json_each(?)) ORDER BY score DESC,thread_id,group_id,segment_ordinal LIMIT ?`
          )
          .all(vector, JSON.stringify(authorized), request.limit)
          .map((input) => {
            const row = decoder(Schema.Struct({ ...rowSchema.fields, score: Schema.Finite }))(
              input
            );
            return decoder(stateObservationHitSchema)({
              id: row.id,
              metadata: this.metadata(row),
              score: row.score,
            });
          });
      })()
    );
  }

  /** Also erase groups lost when native shared OM was cleared by another thread. */
  private prune(retiredThread?: string): void {
    const rows = decoder(
      Schema.Array(
        Schema.Struct({
          groupId: Schema.String,
          pk: Schema.Int,
          resourceId: Schema.String,
          sourceHash: Schema.String,
          threadId: Schema.String,
        })
      )
    )(
      this.db
        .prepare(
          'SELECT pk,resource_id AS resourceId,thread_id AS threadId,group_id AS groupId,source_hash AS sourceHash FROM state_observation_vectors'
        )
        .all()
    );
    const resources = new Map(
      [...new Set(rows.map((row) => row.resourceId))].map((resourceId) => [
        resourceId,
        this.canonical(resourceId, retiredThread),
      ])
    );
    for (const row of rows) {
      if (
        resources.get(row.resourceId)?.get(key(row.threadId, row.groupId))?.hash !== row.sourceHash
      ) {
        this.db.prepare('DELETE FROM state_observation_vectors WHERE pk=?').run(row.pk);
      }
    }
  }

  invalidate(threadId: string): void {
    this.db.prepare('DELETE FROM state_observation_vectors WHERE thread_id=?').run(threadId);
    this.truth.snapshot(() => this.prune(threadId));
  }

  purge(input: unknown): boolean {
    const request = decoder(stateObservationPurgeSchema)(input);
    this.lifecycle.grant(request);
    // Persist the fence before any fallible truth read or checkpoint. Failed cleanup remains visible on reopen.
    this.lifecycle.advance();
    const changed = this.db.transaction(() => {
      const deleted =
        this.db
          .prepare(
            `DELETE FROM state_observation_vectors WHERE root_id=? AND resource_id=?${request.threadId === undefined ? '' : ' AND thread_id=?'}`
          )
          .run(
            request.rootId,
            request.resourceId,
            ...(request.threadId === undefined ? [] : [request.threadId])
          ).changes > 0;
      this.truth.snapshot(() => this.prune());
      return deleted;
    })();
    this.lifecycle.finishCleanup();
    return changed;
  }
}
