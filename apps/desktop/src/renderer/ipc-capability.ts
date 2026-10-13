import { type BoundaryResult, callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import type { Bridge, Contract, TransportBridge } from '../platform/ipc-contract';

/** Construct a renderer capability from the existing preload transport and pure contract. */
export function createIpcCapability<C extends Contract>(
  transport: TransportBridge<C>,
  contract: C
): Bridge<C> {
  const capability: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(contract)) {
    const method = transport[key] as (...args: unknown[]) => unknown;
    capability[key] =
      spec.kind === 'invoke' && spec.envelope === 'ipc-result'
        ? (...args: unknown[]) =>
            callBoundary(() => method(...args) as Promise<BoundaryResult<unknown>>)
        : method;
  }
  return capability as Bridge<C>;
}
