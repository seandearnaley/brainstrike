import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostAuthService, HostClientOrigin } from './ports.js';
import {
  CLIENT_OPEN_EXTERNAL,
  ClientOpenExternalParamsSchema,
  ClientOpenExternalResultSchema,
  type HostMethod,
  type HostParams,
} from './protocol.js';

export type HostMethodHandler = <M extends HostMethod>(
  method: M,
  request: (params: HostParams<M>) => unknown
) => void;

/**
 * The host's credential methods on one authenticated connection. Writes other
 * than a validated provider login, and refresh-aware verification, belong to
 * the launching desktop's private client only.
 */
export function bindHostAuthMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  auth: HostAuthService | undefined,
  origin: HostClientOrigin
): void {
  const service = (): HostAuthService => {
    if (!auth) {
      throw new Error('This host owns no credential store');
    }
    return auth;
  };
  const desktop = (): HostAuthService => {
    if (origin !== 'desktop-ui') {
      throw new Error("This credential method is available only to the desktop's private client");
    }
    return service();
  };
  handle('auth/login', async ({ credential, provider }) => {
    await service().storeProviderCredential(provider, credential);
    return { stored: true };
  });
  handle('auth/status', ({ provider }) => service().status(provider));
  // The requesting client opens the sign-in page: a UI action, never the host's.
  const openOnClient = async (url: string): Promise<void> => {
    ClientOpenExternalResultSchema.parse(
      await connection.sendRequest(
        CLIENT_OPEN_EXTERNAL,
        ClientOpenExternalParamsSchema.parse({ url })
      )
    );
  };
  handle('auth/connect', ({ method, provider }) =>
    service().connect(provider, method, origin, openOnClient)
  );
  handle('auth/cancel', ({ provider }) => service().cancel(provider));
  handle('auth/disconnect', ({ provider }) => service().disconnect(provider));
  handle('auth/credential/set', async ({ account, credential }) => {
    await desktop().setCredential(account, credential);
    return { stored: true };
  });
  handle('auth/credential/delete', async ({ account }) => ({
    deleted: await desktop().deleteCredential(account),
  }));
  handle('auth/clear', async () => ({ cleared: await desktop().clear() }));
  handle('auth/import-legacy', (input) => desktop().importLegacy(input));
  handle('auth/verify', ({ provider }) => desktop().verify(provider));
}
