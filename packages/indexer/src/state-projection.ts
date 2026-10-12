import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  decodeEvent,
  type EventSchema,
  type MemoryObservationRecord,
} from '@brainstrike/state-store';
import { Predicate, Schema } from 'effect';
import {
  decoder,
  type StateMessageIdentity,
  type StateObservationGroup,
  type StateProjectionOptions,
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

export function validateStateModule(module: string): string {
  const url = new URL(module);
  if (url.protocol !== 'file:' || url.search || url.hash) {
    throw new TypeError('State projection requires an explicit canonical local file module.');
  }
  const filename = fileURLToPath(url);
  if (pathToFileURL(realpathSync(filename)).href !== url.href) {
    throw new TypeError('State projection requires an explicit canonical local file module.');
  }
  return filename;
}

/** Only the trusted acquisition owner supplies this module; callbacks stay in the writer. */
export async function loadStateProjection(
  options: StateProjectionOptions,
  stateRoot?: string
): Promise<StateProjection> {
  const filename = validateStateModule(options.module);
  const loaded = decoder(moduleSchema)(await import(options.module));
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
    identity: createHash('sha256')
      .update(JSON.stringify([options.module, options.mode, readFileSync(filename, 'utf8')]))
      .digest('hex'),
  };
}
