import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.js';
import type { HostClientOrigin, HostProviderService } from './ports.js';

const MAX_VISIBLE_ERROR_CHARS = 300;

/**
 * Provider availability, credential verification and OpenRouter model metadata
 * on one authenticated connection. Keys never cross the protocol: a client
 * sends a provider or model id, the host reads its own credential store.
 */
export function bindHostProviderMethods(
  handle: HostMethodHandler,
  providers: HostProviderService | undefined,
  origin: HostClientOrigin
): void {
  const service = (): HostProviderService => {
    if (!providers) {
      throw new Error('This host owns no provider services');
    }
    return providers;
  };
  // The client shows the failure text as it is, so it crosses unprefixed.
  const visible = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      throw new ResponseError(
        ErrorCodes.InternalError,
        cause instanceof Error
          ? cause.message.slice(0, MAX_VISIBLE_ERROR_CHARS)
          : 'Provider request failed.'
      );
    }
  };
  handle('host/status', () => visible(() => service().status()));
  handle('providers/verify', ({ provider }) => visible(() => service().verify(provider, origin)));
  handle('providers/openrouter-model', ({ model }) =>
    visible(() => service().openRouterModel(model))
  );
}
