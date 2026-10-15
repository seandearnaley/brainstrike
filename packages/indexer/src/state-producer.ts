/**
 * A state producer module's projection: how the derived index decodes and
 * projects committed rows, built from the module's exports (ADR-0011). It is
 * portable; the desktop loads its producer by file URL (`state-projection.ts`)
 * and the browser state writer (BST-1940) passes its producer in.
 */
import { decodeEvent, type EventSchema } from '@brainstrike/state-store/event-schema';
import type { MemoryObservationRecord } from '@brainstrike/state-store/state-truth-reader';
import { Predicate, Schema } from 'effect';
import {
  decoder,
  type StateMessageIdentity,
  type StateObservationGroup,
  type StateSearchRow,
  stateMessageIdentitySchema,
  stateObservationGroupSchema,
  stateSearchRowSchema,
} from './contracts.js';

const callable = Schema.declare<(...args: readonly unknown[]) => unknown>(
  (input): input is (...args: readonly unknown[]) => unknown => Predicate.isFunction(input)
);
const record = Schema.Record(Schema.String, Schema.Unknown);
const moduleSchema = Schema.Struct({
  decode: Schema.optional(callable),
  messages: Schema.optional(callable),
  observationChunks: Schema.optional(callable),
  observations: Schema.optional(callable),
  schema: Schema.optional(
    Schema.Struct({
      currentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
      upgraders: Schema.Record(Schema.String, callable),
      validate: callable,
    })
  ),
  search: Schema.optional(callable),
  text: callable,
});
const eventIdentity = Schema.StructWithRest(
  Schema.Struct({ seq: Schema.Int.check(Schema.isGreaterThan(0)), type: Schema.String }),
  [record]
);
const unreadable = Schema.Struct({ reason: Schema.String, type: Schema.Literal('unreadable') });

export interface StateProjectionRow {
  readonly gap: string | null;
  /** Gap 10: the event's searchable conversation row, when its producer projects one. */
  readonly search: StateSearchRow;
  readonly seq: number;
  readonly text: string | null;
}
export interface StateMessageEvent {
  readonly event: unknown;
  readonly seq: number;
  readonly threadId: string;
}
export type StateProducerDecoder = (
  raw: string,
  mode: 'dev' | 'prod',
  stateRoot?: string
) => unknown;
export interface StateProjection {
  decode(raw: string): StateProjectionRow;
  event(raw: string): unknown;
  readonly identity: string;
  messages?(rows: readonly StateMessageEvent[]): readonly StateMessageIdentity[];
  observationChunks?(text: string): readonly string[];
  observations?(record: MemoryObservationRecord): readonly StateObservationGroup[];
}

/**
 * The projection of a producer module's exports. `identity` names the
 * producer and its build, so an index made by a different producer is rebuilt;
 * `stateRoot` is passed to the producer's own decoder.
 */
export function createStateProjection(
  producer: unknown,
  mode: 'dev' | 'prod',
  identity: string,
  stateRoot?: string
): StateProjection {
  const options = { mode };
  const loaded = decoder(moduleSchema)(producer);
  if ((loaded.observations === undefined) !== (loaded.observationChunks === undefined)) {
    throw new TypeError(
      'State observation projection and native chunk primitive must be acquired together.'
    );
  }
  if ((loaded.schema === undefined) === (loaded.decode === undefined)) {
    throw new TypeError(
      'State producer must export exactly one versioned schema or canonical decode function.'
    );
  }
  const versioned = loaded.schema;
  const schema: EventSchema<unknown> | undefined = versioned
    ? {
        currentVersion: versioned.currentVersion,
        upgraders: Object.fromEntries(
          Object.entries(versioned.upgraders).map(([version, upgrade]) => [
            version,
            (event: Readonly<Record<string, unknown>>) => decoder(record)(upgrade(event)),
          ])
        ),
        validate: (event, seq) => versioned.validate(event, seq),
      }
    : undefined;
  const decode = (raw: string): unknown => {
    if (schema) {
      return decodeEvent(raw, options.mode, schema);
    }
    const source = decoder(eventIdentity)(JSON.parse(raw));
    if (source.type === 'purged') {
      return { seq: source.seq, type: 'purged' };
    }
    const event = loaded.decode?.(raw, options.mode, stateRoot);
    if (decoder(eventIdentity)(event).seq !== source.seq) {
      throw new Error('State producer decoder changed the committed sequence identity');
    }
    return event;
  };
  return {
    ...(loaded.observations && loaded.observationChunks
      ? {
          observationChunks: (text: string) =>
            decoder(Schema.Array(Schema.NonEmptyString))(loaded.observationChunks?.(text)),
          observations: (record: MemoryObservationRecord) =>
            decoder(Schema.Array(stateObservationGroupSchema))(loaded.observations?.(record)),
        }
      : {}),
    ...(loaded.messages
      ? {
          messages: (rows: readonly StateMessageEvent[]) =>
            decoder(Schema.Array(stateMessageIdentitySchema))(loaded.messages?.(rows)),
        }
      : {}),
    decode: (raw) => {
      const event = decode(raw);
      const { seq, type } = decoder(eventIdentity)(event);
      if (type === 'purged') {
        return { gap: null, search: null, seq, text: null };
      }
      if (Schema.is(unreadable)(event)) {
        return { gap: event.reason, search: null, seq, text: null };
      }
      return {
        gap: null,
        search: loaded.search ? decoder(stateSearchRowSchema)(loaded.search(event)) : null,
        seq,
        text: decoder(Schema.NullOr(Schema.String))(loaded.text(event)),
      };
    },
    event: decode,
    identity,
  };
}
