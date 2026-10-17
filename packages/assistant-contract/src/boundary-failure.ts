import { Schema } from 'effect';
/**
 * The one failure shape that crosses a process boundary (Main, agent host,
 * renderer, hidden hosts). A `refusal` is a request understood and declined for
 * a reason its user or model can act on; it is never retried automatically. A
 * `fault` is an operation that failed; its inner cause stays in the sender's log
 * under `correlationId` and never travels.
 *
 * Effect Schema owns this wire grammar. Preload consumers use its types only;
 * Effect-framed utility faults map in at Main (docs/agents/effect-boundary.md).
 */
export const BOUNDARY_FAILURE_CATEGORIES = [
  'input',
  'authorization',
  'configuration',
  'availability',
  'conflict',
  'timeout',
  'internal',
] as const;
export type BoundaryFailureCategory = (typeof BOUNDARY_FAILURE_CATEGORIES)[number];
/** A namespaced, stable code: `area.reason`, lower-case words joined by dashes. */
const BoundaryFailureCode = Schema.Union([
  Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)),
  Schema.Literals([
    'EMBEDDING_DEVICE_LOST',
    'native-index-transitioning',
    'native-index-closed',
    'native-index-setup-required',
    'native-index-settings-invalid',
    'native-index-source-failure',
    'native-index-rebuild-required',
  ]),
]);
/** The facts of a lost child process; none of them is a path or a message. */
const ProcessLostFacts = Schema.Struct({
  child: Schema.Literals([
    'agent-host',
    'db-host',
    'index-utility',
    'embedding-host',
    'chunking-host',
    'parser-host',
  ]),
  exitCode: Schema.optional(Schema.Int),
  reason: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(64))
  ),
  signal: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(32))
  ),
});
export type BoundaryChild = (typeof ProcessLostFacts)['Type']['child'];
export const BoundaryFailureSchema = Schema.Struct({
  category: Schema.Literals(BOUNDARY_FAILURE_CATEGORIES),
  code: BoundaryFailureCode,
  correlationId: Schema.optional(Schema.String.check(Schema.isUUID())),
  kind: Schema.Literals(['refusal', 'fault']),
  message: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(1000)),
  process: Schema.optional(ProcessLostFacts),
  providerEvidence: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(600))
  ),
  remedy: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(500))
  ),
});
export type BoundaryFailure = (typeof BoundaryFailureSchema)['Type'];
/** What a receiver shows for any failure that arrived untyped or malformed. */
export const INTERNAL_FAULT: BoundaryFailure = Object.freeze({
  category: 'internal',
  code: 'boundary.internal',
  kind: 'fault',
  message: 'Something went wrong. The details were recorded in the diagnostic log.',
});
/**
 * Decode a failure as it arrived. Anything missing or malformed is the fixed
 * internal fault (`valid: false`, so the receiver logs what it got); its raw
 * text is never returned.
 */
export function decodeBoundaryFailure(wire: unknown): {
  readonly failure: BoundaryFailure;
  readonly valid: boolean;
} {
  const parsed = Schema.decodeUnknownResult(BoundaryFailureSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(wire);
  return parsed._tag === 'Success'
    ? { failure: parsed.success, valid: true }
    : { failure: INTERNAL_FAULT, valid: false };
}
/** Text past the schema's bounds is cut, never refused: a long folder list still renders. */
const bounded = <
  T extends Pick<BoundaryFailure, 'message'> & Partial<Pick<BoundaryFailure, 'remedy'>>,
>(
  failure: T
): T => ({
  ...failure,
  message: failure.message.slice(0, 1000),
  ...(failure.remedy === undefined ? {} : { remedy: failure.remedy.slice(0, 500) }),
});
export function refusal(
  failure: Pick<BoundaryFailure, 'category' | 'code' | 'message'> &
    Partial<Pick<BoundaryFailure, 'remedy' | 'providerEvidence'>>
): BoundaryFailure {
  return Schema.decodeUnknownSync(BoundaryFailureSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({ ...bounded(failure), kind: 'refusal' });
}
export function fault(
  failure: Pick<BoundaryFailure, 'category' | 'code' | 'message'> &
    Partial<Pick<BoundaryFailure, 'correlationId' | 'remedy' | 'providerEvidence'>>
): BoundaryFailure {
  return Schema.decodeUnknownSync(BoundaryFailureSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({ ...bounded(failure), kind: 'fault' });
}
const CHILD_NAMES: Readonly<Record<BoundaryChild, string>> = {
  'agent-host': 'The agent host',
  'chunking-host': 'The chunking host',
  'db-host': 'The database host',
  'embedding-host': 'The embedding host',
  'index-utility': 'The index process',
  'parser-host': 'The parser host',
};
/** The cause a supervisor reports when its child exits without being asked. */
export function processLost(facts: (typeof ProcessLostFacts)['Type']): BoundaryFailure {
  return Schema.decodeUnknownSync(BoundaryFailureSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({
    category: 'availability',
    code: 'process.lost',
    kind: 'fault',
    message: `${CHILD_NAMES[facts.child]} stopped unexpectedly.`,
    process: facts,
  });
}
/**
 * A failure thrown inside one process on its way to a boundary. Its message is
 * the typed message; the inner cause rides `cause` and stays local.
 */
export class BoundaryFailureError extends Error {
  readonly failure: BoundaryFailure;
  readonly code: string;
  constructor(
    failure: BoundaryFailure,
    options?: {
      readonly cause?: unknown;
    }
  ) {
    super(failure.message, options);
    this.name = 'BoundaryFailureError';
    this.failure = failure;
    this.code = failure.code;
  }
}
/**
 * A typed refusal: the owner declined the work (closed, preparing, invalid
 * input), which callers report as unavailability rather than a fault.
 */
export function isBoundaryRefusal(cause: unknown): cause is BoundaryFailureError {
  return cause instanceof BoundaryFailureError && cause.failure.kind === 'refusal';
}
/** A typed refusal ready to throw: `throw refusalError('conflict', 'run.already-active', '…')`. */
export function refusalError(
  category: BoundaryFailureCategory,
  code: string,
  message: string,
  remedy?: string
): BoundaryFailureError {
  return new BoundaryFailureError(
    refusal({ category, code, message, ...(remedy === undefined ? {} : { remedy }) })
  );
}
export function isBoundaryFailureError(value: unknown): value is BoundaryFailureError {
  return value instanceof BoundaryFailureError;
}
/** Render only validated public failure fields; causes and stacks never participate. */
export function describeBoundaryFailure(failure: BoundaryFailure): string {
  return [
    failure.message,
    failure.remedy,
    failure.providerEvidence === undefined
      ? undefined
      : `Provider response: ${failure.providerEvidence}`,
  ]
    .filter((part) => part !== undefined)
    .join(' ');
}
export function describeBoundaryError(cause: unknown): string {
  return describeBoundaryFailure(
    cause instanceof BoundaryFailureError ? cause.failure : INTERNAL_FAULT
  );
}
