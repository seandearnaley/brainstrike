import { z } from 'zod';

/**
 * The one failure shape that crosses a process boundary (Main, agent host,
 * renderer, hidden hosts). A `refusal` is a request understood and declined for
 * a reason its user or model can act on; it is never retried automatically. A
 * `fault` is an operation that failed; its inner cause stays in the sender's log
 * under `correlationId` and never travels.
 *
 * zod, not Effect Schema: it is the agent-host protocol's library, and Effect
 * stays out of the renderer bundle, the preload and the tool guard
 * (docs/agents/effect-boundary.md). Effect-framed utility faults map in at Main.
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
const BoundaryFailureCode = z.union([
  z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
  // Existing native-index refusal codes are consumed by the Ready re-run seam.
  z.enum([
    'native-index-transitioning',
    'native-index-closed',
    'native-index-setup-required',
    'native-index-settings-invalid',
    'native-index-source-failure',
  ]),
]);

/** The facts of a lost child process; none of them is a path or a message. */
const ProcessLostFacts = z.strictObject({
  child: z.enum([
    'agent-host',
    'db-host',
    'index-utility',
    'embedding-host',
    'llm-host',
    'chunking-host',
    'parser-host',
  ]),
  exitCode: z.number().int().optional(),
  reason: z.string().min(1).max(64).optional(),
  signal: z.string().min(1).max(32).optional(),
});

export type BoundaryChild = z.infer<typeof ProcessLostFacts>['child'];

export const BoundaryFailureSchema = z.strictObject({
  category: z.enum(BOUNDARY_FAILURE_CATEGORIES),
  code: BoundaryFailureCode,
  /** Links a fault to its inner cause in the sender's log. */
  correlationId: z.string().uuid().optional(),
  kind: z.enum(['refusal', 'fault']),
  /** The typed text a user or model is shown. Never a raw error message. */
  message: z.string().min(1).max(1000),
  process: ProcessLostFacts.optional(),
  /** Deliberate, secret-redacted provider response evidence, bounded at its producer. */
  providerEvidence: z.string().min(1).max(600).optional(),
  /** What the user can do about it, when there is something. */
  remedy: z.string().min(1).max(500).optional(),
});

export type BoundaryFailure = z.infer<typeof BoundaryFailureSchema>;

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
  const parsed = BoundaryFailureSchema.safeParse(wire);
  return parsed.success
    ? { failure: parsed.data, valid: true }
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
  return BoundaryFailureSchema.parse({ ...bounded(failure), kind: 'refusal' });
}

export function fault(
  failure: Pick<BoundaryFailure, 'category' | 'code' | 'message'> &
    Partial<Pick<BoundaryFailure, 'correlationId' | 'remedy' | 'providerEvidence'>>
): BoundaryFailure {
  return BoundaryFailureSchema.parse({ ...bounded(failure), kind: 'fault' });
}

const CHILD_NAMES: Readonly<Record<BoundaryChild, string>> = {
  'agent-host': 'The agent host',
  'chunking-host': 'The chunking host',
  'db-host': 'The database host',
  'embedding-host': 'The embedding host',
  'index-utility': 'The index process',
  'llm-host': 'The local model host',
  'parser-host': 'The parser host',
};

/** The cause a supervisor reports when its child exits without being asked. */
export function processLost(facts: z.infer<typeof ProcessLostFacts>): BoundaryFailure {
  return BoundaryFailureSchema.parse({
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

  constructor(failure: BoundaryFailure, options?: { readonly cause?: unknown }) {
    super(failure.message, options);
    this.name = 'BoundaryFailureError';
    this.failure = failure;
    this.code = failure.code;
  }
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
