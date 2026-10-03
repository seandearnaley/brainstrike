import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

const StartupMessageSchema = Schema.Union([
  Schema.Struct({ event: Schema.Literal('ready') }),
  Schema.Struct({
    event: Schema.Literal('failed'),
    kind: Schema.Literals(['root-locked', 'foreign-lock', 'error']),
    message: Schema.String,
  }),
]);
export type StartupMessage = typeof StartupMessageSchema.Type;
export const decodeStartupMessage = makeThrowingDecoder(StartupMessageSchema, {
  onExcessProperty: 'error',
});
