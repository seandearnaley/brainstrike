import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import { HostRecordSchema } from './record.ts';

const StartupMessageSchema = Schema.Union([
  // Lifecycle R3: readiness is this message, and it carries what the parent
  // needs to attach, so the parent never rediscovers the host it started.
  Schema.Struct({ event: Schema.Literal('ready'), record: HostRecordSchema }),
  Schema.Struct({
    event: Schema.Literal('failed'),
    kind: Schema.Literals(['root-locked', 'foreign-lock', 'error']),
    message: Schema.String,
    ownership: Schema.optional(Schema.Literals(['released', 'retained'])),
  }),
]);
export type StartupMessage = typeof StartupMessageSchema.Type;
export const decodeStartupMessage = makeThrowingDecoder(StartupMessageSchema, {
  onExcessProperty: 'error',
});
