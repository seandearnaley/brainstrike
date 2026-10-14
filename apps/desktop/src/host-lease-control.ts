import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

// Only the utility process's parent channel accepts this lifetime control.
// It is deliberately absent from the shared initialize/attach socket protocol.
const ControlSchema = Schema.Struct({ method: Schema.Literals(['close', 'clear-content']) });
export type HostLeaseControl = typeof ControlSchema.Type;
export const decodeHostLeaseControl = makeThrowingDecoder(ControlSchema, {
  onExcessProperty: 'error',
});

const ParentMessageSchema = Schema.Struct({ data: Schema.Unknown });
export const decodeHostLeaseParentMessage = makeThrowingDecoder(ParentMessageSchema, {
  onExcessProperty: 'ignore',
});

const ContentClearedSchema = Schema.Struct({
  deletedChunks: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  deletedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  event: Schema.Literal('content-cleared'),
});
export const decodeHostContentCleared = makeThrowingDecoder(ContentClearedSchema, {
  onExcessProperty: 'error',
});
