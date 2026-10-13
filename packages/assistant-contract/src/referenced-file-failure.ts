import { z } from 'zod';
import { BoundaryFailureSchema, describeBoundaryFailure } from './boundary-failure.js';

/** One failed attachment read, captured once by its run admission. No content or host path. */
export const ReferencedFileFailureSchema = z.strictObject({
  failure: BoundaryFailureSchema,
  path: z.string().min(1),
  rootId: z.string().min(1),
});
export type ReferencedFileFailure = z.infer<typeof ReferencedFileFailureSchema>;
export function describeReferencedFileFailure(file: ReferencedFileFailure): {
  label: string;
  detail: string;
} {
  return {
    detail: `${file.path}: ${describeBoundaryFailure(file.failure)}`,
    label: 'Referenced file could not be attached',
  };
}
