import { refusalError } from '@brainstrike/assistant-contract';
import type { HostProviderService } from './ports.ts';
import type { HostMethod, HostParams } from './protocol.ts';

/** These reads take the request's signal: retirement cancels their network wait. */
type HostSignalMethodHandler = <M extends HostMethod>(
  method: M,
  request: (params: HostParams<M>, signal: AbortSignal) => unknown
) => void;

/**
 * Provider availability, credential verification and OpenRouter model metadata
 * on one authenticated connection. Keys never cross the protocol: a client
 * sends a provider or model id, the host reads its own credential store.
 *
 * Failures cross through the connection's boundary like any other method's: a
 * typed refusal (no key configured) reaches the client as it is, and anything
 * else is logged and crosses as the internal fault.
 */
export function bindHostProviderMethods(
  handle: HostSignalMethodHandler,
  providers: HostProviderService | undefined
): void {
  const service = (): HostProviderService => {
    if (!providers) {
      throw refusalError(
        'configuration',
        'provider.unavailable',
        'This host owns no provider services'
      );
    }
    return providers;
  };
  handle('host/status', async () => await service().status());
  handle(
    'providers/verify',
    async ({ provider }, signal) => await service().verify(provider, signal)
  );
  handle(
    'providers/openrouter-model',
    async ({ model }, signal) => await service().openRouterModel(model, signal)
  );
}
