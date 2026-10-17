import { Schema } from 'effect';
import { BoundaryFailureSchema, describeBoundaryFailure } from './boundary-failure.js';
/** One failed attachment read, captured once by its run admission. No content or host path. */
export const ReferencedFileFailureSchema = Schema.Struct({
  failure: BoundaryFailureSchema,
  path: Schema.String.check(Schema.isMinCodePoints(1)),
  rootId: Schema.String.check(Schema.isMinCodePoints(1)),
});
export type ReferencedFileFailure = (typeof ReferencedFileFailureSchema)['Type'];
export function describeReferencedFileFailure(file: ReferencedFileFailure): {
  label: string;
  detail: string;
} {
  return {
    detail: `${file.path}: ${describeBoundaryFailure(file.failure)}`,
    label: 'Referenced file could not be attached',
  };
}
