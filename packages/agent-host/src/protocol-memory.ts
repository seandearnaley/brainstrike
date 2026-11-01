import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/** Epoch milliseconds, as the host stores times. */
const StoredTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Why observational memory waits for an observer it can run. */
export const HOST_OBSERVER_AWAITING_REASONS = [
  'keys-unknown',
  'model-not-eligible',
  'no-backend',
  'no-chat-provider',
] as const;
export type HostObserverAwaitingReason = (typeof HOST_OBSERVER_AWAITING_REASONS)[number];
const ObservationTokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ObservationThreshold = Schema.Int.check(Schema.isGreaterThan(0));
/**
 * The record's observation and reflection cycle (BST-2201), as Mastra stores
 * it: the live observing, reflecting and buffering flags, when it last
 * observed and buffered (epoch ms, null before the first), its reflection
 * generation and origin, and its `config.reflection.observationTokens`.
 */
const HostObservationLifecycleSchema = Schema.Struct({
  generationCount: ObservationTokens,
  isBufferingObservation: Schema.Boolean,
  isBufferingReflection: Schema.Boolean,
  isObserving: Schema.Boolean,
  isReflecting: Schema.Boolean,
  lastBufferedAtTime: Schema.NullOr(StoredTime),
  lastObservedAt: Schema.NullOr(StoredTime),
  originType: Schema.Literals(['initial', 'reflection']),
  reflectionTokenThreshold: ObservationThreshold,
});
/**
 * Observational memory as a run admission configures it. `active` carries the
 * thread's committed observation record, or null before the first observation.
 */
export const HostObservationalMemoryStateSchema = Schema.Union(
  [
    Schema.Struct({ state: Schema.Literal('off') }),
    Schema.Struct({
      reason: Schema.Literals(HOST_OBSERVER_AWAITING_REASONS),
      state: Schema.Literal('awaiting-observer'),
    }),
    Schema.Struct({
      record: Schema.NullOr(
        Schema.Struct({
          bufferedObservationTokens: ObservationTokens,
          lifecycle: Schema.optional(HostObservationLifecycleSchema),
          messageTokenThreshold: ObservationThreshold,
          observationTokenCount: ObservationTokens,
          pendingMessageTokens: ObservationTokens,
          totalTokensObserved: ObservationTokens,
        })
      ),
      state: Schema.Literal('active'),
    }),
  ],
  { mode: 'oneOf' }
);
export type HostObservationalMemoryState = (typeof HostObservationalMemoryStateSchema)['Type'];
/**
 * The models a run's memory uses (BST-2201): the observer's catalog
 * `provider::model` once observational memory resolved one. Absent means none.
 */
export const HostMemoryModelsSchema = Schema.Struct({
  observer: Schema.optional(Id),
});
export type HostMemoryModels = (typeof HostMemoryModelsSchema)['Type'];
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * One observation or reflection cycle (BST-2224), from Mastra's documented
 * lifecycle hooks: what started it (Mastra's `ObserveTrigger`), how it ended
 * (`cancelled` when the run's Stop ended it), how long it ran (absent when its
 * start was not seen), the model usage the cycle reports, and a failure's typed
 * code and the reference its cause is logged under. Spend is billed from
 * `memory.usage` alone.
 */
export const HostMemoryCycleEventSchema = Schema.Struct({
  durationMs: Schema.optional(NonNegativeInt),
  failure: Schema.optional(
    Schema.Struct({
      code: Id,
      correlationId: Schema.optional(Schema.String.check(Schema.isUUID())),
    })
  ),
  kind: Schema.Literals(['observation', 'reflection']),
  outcome: Schema.Literals(['completed', 'failed', 'cancelled']),
  runId: Id,
  trigger: Schema.optional(Schema.Literals(['manual', 'turn-sync', 'async-buffer'])),
  type: Schema.Literal('memory.cycle'),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(NonNegativeInt),
      outputTokens: Schema.optional(NonNegativeInt),
      totalTokens: Schema.optional(NonNegativeInt),
    })
  ),
});
export type HostMemoryCycleEvent = (typeof HostMemoryCycleEventSchema)['Type'];
