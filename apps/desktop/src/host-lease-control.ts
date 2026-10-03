import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

// Only the utility process's parent channel accepts this lifetime control.
// It is deliberately absent from the shared initialize/attach socket protocol.
const ControlSchema = Schema.Struct({ method: Schema.Literal('close') });
export type HostLeaseControl = typeof ControlSchema.Type;
export const decodeHostLeaseControl = makeThrowingDecoder(ControlSchema, {
  onExcessProperty: 'error',
});

const ParentMessageSchema = Schema.Struct({ data: Schema.Unknown });
export const decodeHostLeaseParentMessage = makeThrowingDecoder(ParentMessageSchema, {
  onExcessProperty: 'ignore',
});
