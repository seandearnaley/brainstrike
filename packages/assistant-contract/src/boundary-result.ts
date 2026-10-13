import { createLogger } from '@brainstrike/logging';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  decodeBoundaryFailure,
  INTERNAL_FAULT,
} from './boundary-failure.js';

/** IPC returns failures as data: Electron does not preserve custom Error fields. */
export type BoundaryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BoundaryFailure };

/** Transport counterpart of a capability; push subscriptions are unchanged. */
export type BoundaryTransport<C> = {
  [K in keyof C]: C[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<BoundaryResult<R>>
    : C[K];
};

const logger = createLogger('BoundaryResult');

/** Decode on the receiving renderer, after contextBridge has transported plain data. */
export function readBoundaryResult<T>(wire: BoundaryResult<T>): T {
  if (typeof wire !== 'object' || wire === null) {
    logger.error('Desktop IPC returned a malformed envelope', { wire });
    throw new BoundaryFailureError(INTERNAL_FAULT);
  }
  if (wire.ok === true && Object.hasOwn(wire, 'value')) {
    return wire.value;
  }
  if (wire.ok === false) {
    const { failure, valid } = decodeBoundaryFailure(wire.error);
    if (!valid) {
      logger.error('Desktop IPC returned an untyped failure', { wire });
    }
    throw new BoundaryFailureError(failure);
  }
  logger.error('Desktop IPC returned a malformed envelope', { wire });
  throw new BoundaryFailureError(INTERNAL_FAULT);
}

/** A rejected transport is an infrastructure fault, never public Electron error prose. */
export async function callBoundary<T>(invoke: () => Promise<BoundaryResult<T>>): Promise<T> {
  let wire: BoundaryResult<T>;
  try {
    wire = await invoke();
  } catch (cause) {
    logger.error('Desktop IPC transport failed', { cause });
    throw new BoundaryFailureError(INTERNAL_FAULT, { cause });
  }
  return readBoundaryResult(wire);
}
