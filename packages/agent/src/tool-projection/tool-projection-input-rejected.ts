/**
 * Marker for a domain tool projector's SHAPE-VALIDATION rejections: the value
 * it received is not the tool's result at all (a failed/cancelled tool's
 * value, a stored projection with drifted keys, a caller-convention carrier).
 *
 * The runtime dispatcher fails soft ONLY on this marker — it logs a keys-only
 * shape summary and degrades to the generic bounded projection instead of
 * killing the run (2026-08-03: a grep projection TypeError became a fatal run
 * error and destroyed the diagnostic for the tool failure underneath it).
 * Every other projector throw is deliberate contract enforcement — truncated
 * results without continuation guidance, self-fit budget guards — and MUST
 * keep failing the run, so plain TypeError/RangeError still propagates.
 */

/** `Symbol.for`-keyed so the check survives duplicate module copies (CJS/ESM). */
const PROJECTION_INPUT_REJECTED = Symbol.for('brainstrike.toolProjectionInputRejected');

export class ToolProjectionInputRejectedError extends TypeError {
  readonly [PROJECTION_INPUT_REJECTED] = true;

  constructor(message: string) {
    super(message);
    this.name = 'ToolProjectionInputRejectedError';
  }
}

export function isToolProjectionInputRejected(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as Record<PropertyKey, unknown>)[PROJECTION_INPUT_REJECTED] === true
  );
}
