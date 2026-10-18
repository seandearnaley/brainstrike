import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import type { HostClientOrigin, HostProviderService } from './ports.js';
import type { HostMethod, HostParams } from './protocol.js';

const MAX_VISIBLE_ERROR_CHARS = 300;

/** These reads take the request's signal: retirement cancels their network wait. */
type HostSignalMethodHandler = <M extends HostMethod>(
  method: M,
  request: (params: HostParams<M>, signal: AbortSignal) => unknown
) => void;

/**
 * Provider availability, credential verification and OpenRouter model metadata
 * on one authenticated connection. Keys never cross the protocol: a client
 * sends a provider or model id, the host reads its own credential store.
 */
export function bindHostProviderMethods(
  handle: HostSignalMethodHandler,
  providers: HostProviderService | undefined,
  origin: HostClientOrigin
): void {
  const service = (): HostProviderService => {
    if (!providers) {
      throw new Error('This host owns no provider services');
    }
    return providers;
  };
  // The client shows the failure text as it is, so it crosses unprefixed. A
  // typed failure (the request's own `host.closing` cancellation) keeps its type.
  const visible = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof BoundaryFailureError) {
        throw cause;
      }
      throw new ResponseError(
        ErrorCodes.InternalError,
        cause instanceof Error
          ? cause.message.slice(0, MAX_VISIBLE_ERROR_CHARS)
          : 'Provider request failed.'
      );
    }
  };
  handle('host/status', () => visible(() => service().status()));
  handle('providers/verify', ({ provider }, signal) =>
    visible(() => service().verify(provider, origin, signal))
  );
  handle('providers/openrouter-model', ({ model }, signal) =>
    visible(() => service().openRouterModel(model, signal))
  );
}
