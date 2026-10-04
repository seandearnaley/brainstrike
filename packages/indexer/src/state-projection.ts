import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeEvent, type EventSchema } from '@brainstrike/state-store';
import { Predicate, Schema } from 'effect';
import { decoder, type StateProjectionOptions } from './contracts.js';

const callable = Schema.declare<(...args: readonly unknown[]) => unknown>(
  (input): input is (...args: readonly unknown[]) => unknown => Predicate.isFunction(input)
);
const record = Schema.Record(Schema.String, Schema.Unknown);
const moduleSchema = Schema.Struct({
  schema: Schema.Struct({
    currentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    upgraders: Schema.Record(Schema.String, callable),
    validate: callable,
  }),
  text: callable,
});
const eventIdentity = Schema.StructWithRest(
  Schema.Struct({ seq: Schema.Int.check(Schema.isGreaterThan(0)), type: Schema.String }),
  [record]
);
const unreadable = Schema.Struct({ reason: Schema.String, type: Schema.Literal('unreadable') });

export interface StateProjectionRow {
  readonly gap: string | null;
  readonly seq: number;
  readonly text: string | null;
}
export interface StateProjection {
  decode(raw: string): StateProjectionRow;
  readonly identity: string;
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
  options: StateProjectionOptions
): Promise<StateProjection> {
  const filename = validateStateModule(options.module);
  const loaded = decoder(moduleSchema)(await import(options.module));
  const schema: EventSchema<unknown> = {
    currentVersion: loaded.schema.currentVersion,
    upgraders: Object.fromEntries(
      Object.entries(loaded.schema.upgraders).map(([version, upgrade]) => [
        version,
        (event: Readonly<Record<string, unknown>>) => decoder(record)(upgrade(event)),
      ])
    ),
    validate: (event, seq) => loaded.schema.validate(event, seq),
  };
  return {
    decode: (raw) => {
      const event = decodeEvent(raw, options.mode, schema);
      const { seq, type } = decoder(eventIdentity)(event);
      if (type === 'purged') {
        return { gap: null, seq, text: null };
      }
      if (Schema.is(unreadable)(event)) {
        return { gap: event.reason, seq, text: null };
      }
      return { gap: null, seq, text: decoder(Schema.String)(loaded.text(event)) };
    },
    identity: createHash('sha256')
      .update(JSON.stringify([options.module, options.mode, readFileSync(filename, 'utf8')]))
      .digest('hex'),
  };
}
