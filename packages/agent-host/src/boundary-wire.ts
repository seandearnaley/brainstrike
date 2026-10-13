import {
  type BoundaryFailure,
  BoundaryFailureError,
  decodeBoundaryFailure,
  fault,
  INTERNAL_FAULT,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';

/** The JSON-RPC error code of a refusal; a fault keeps `InternalError`. */
export const BOUNDARY_REFUSAL_RPC_CODE = -32_001;

/** How an untyped failure is recorded where it happened, under its correlation id. */
export type BoundaryLog = (message: string, fields: Readonly<Record<string, unknown>>) => void;

const CONNECTION_LOST = fault({
  category: 'availability',
  code: 'host.connection-lost',
  message: 'The connection closed before the request was answered.',
});

function typedFailure(cause: unknown): BoundaryFailure | undefined {
  if (cause instanceof BoundaryFailureError) {
    return cause.failure;
  }
  if (cause instanceof Error && 'code' in cause && cause.code === 'EMBEDDING_DEVICE_LOST') {
    return fault({
      category: 'availability',
      code: 'EMBEDDING_DEVICE_LOST',
      message: 'WebGPU device was lost.',
      remedy: 'Choose the model again to retry.',
    });
  }
  if (cause instanceof ToolInputError) {
    return {
      category: 'input',
      code: 'tool.input-invalid',
      kind: 'refusal',
      message: cause.message.slice(0, 1000),
    };
  }
  if (cause instanceof ResponseError) {
    const { failure, valid } = decodeBoundaryFailure(cause.data);
    return valid ? failure : undefined;
  }
  return;
}

/**
 * The response error a request handler sends for any failure. A typed failure
 * travels as the response `data`; anything else is logged here, under a new
 * correlation id, and travels as the fixed internal fault.
 */
export function toBoundaryFailure(cause: unknown, log: BoundaryLog): BoundaryFailure {
  const typed = typedFailure(cause);
  if (typed?.kind === 'refusal') {
    return typed;
  }
  if (typed) {
    // A typed fault's inner cause stays here, logged under its correlation id.
    const inner = cause instanceof BoundaryFailureError ? cause.cause : cause;
    const correlationId = typed.correlationId ?? crypto.randomUUID();
    if (inner !== undefined) {
      log('A typed fault crossed a process boundary', {
        cause: inner,
        code: typed.code,
        correlationId,
      });
    }
    const failure: BoundaryFailure = { ...typed, correlationId };
    return failure;
  }
  const correlationId = crypto.randomUUID();
  log('Untyped failure crossed a process boundary', { correlationId, error: cause });
  const failure: BoundaryFailure = { ...INTERNAL_FAULT, correlationId };
  return failure;
}

export function toBoundaryResponseError(
  cause: unknown,
  log: BoundaryLog
): ResponseError<BoundaryFailure> {
  const failure = toBoundaryFailure(cause, log);
  return new ResponseError(
    failure.kind === 'refusal' ? BOUNDARY_REFUSAL_RPC_CODE : ErrorCodes.InternalError,
    failure.message,
    failure
  );
}

/**
 * The error a requester throws for a failed response: the typed failure the
 * peer sent, or the internal fault (with what arrived logged) when it sent none.
 * The original response error stays the cause.
 */
export function fromBoundaryResponseError(cause: unknown, log: BoundaryLog): unknown {
  if (!(cause instanceof ResponseError)) {
    return cause;
  }
  if (
    cause.code === ErrorCodes.PendingResponseRejected ||
    cause.code === ErrorCodes.ConnectionInactive
  ) {
    return new BoundaryFailureError(CONNECTION_LOST, { cause });
  }
  const { failure, valid } = decodeBoundaryFailure(cause.data);
  if (!valid) {
    log('A peer sent a failure without a typed outcome', {
      code: cause.code,
      error: cause,
    });
  }
  return new BoundaryFailureError(failure, { cause });
}
