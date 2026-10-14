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
export function readBoundaryResult<T>(wire: BoundaryResult<T>): T;
export function readBoundaryResult(wire: unknown): unknown;
export function readBoundaryResult(wire: unknown): unknown {
  if (typeof wire !== 'object' || wire === null || !('ok' in wire)) {
    logger.error('Desktop IPC returned a malformed envelope', { wire });
    throw new BoundaryFailureError(INTERNAL_FAULT);
  }
  if (wire.ok === true && 'value' in wire && Object.hasOwn(wire, 'value')) {
    return wire.value;
  }
  if (wire.ok === false) {
    const { failure, valid } = decodeBoundaryFailure('error' in wire ? wire.error : undefined);
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

const receivedCapabilities = new WeakMap<object, object>();

/** Adapt an async-only preload transport at its renderer consumer, never in preload. */
export function createBoundaryCapability<C extends object>(transport: BoundaryTransport<C>): C {
  const existing = receivedCapabilities.get(transport);
  if (existing) {
    return existing as C;
  }
  const capability: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(transport)) {
    if (typeof method !== 'function') {
      throw new BoundaryFailureError(INTERNAL_FAULT);
    }
    capability[name] = (...args: unknown[]) =>
      callBoundary(
        () => Reflect.apply(method, transport, args) as Promise<BoundaryResult<unknown>>
      );
  }
  receivedCapabilities.set(transport, capability);
  return capability as C;
}
