import { fromBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import { createLogger } from '@brainstrike/logging';
import type { MessagePortMain } from 'electron';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { forkIndexUtility } from '../fork-utility';
import { mainPlatformConnection } from './connection';
import { type DesktopPlatformCapabilities, serveDesktopPlatform } from './main-platform';
import { serveUtilityLending } from './main-utility-lending';

const logger = createLogger('DesktopPlatformPort');

export interface DesktopPlatformBinding {
  close(): Promise<void>;
  /** Asks this host for what only it owns (its folders, its index); a typed refusal continues. */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Full Main binds the port bootstrap allocated before loading its service graph. */
export function bindDesktopPlatformPort(
  port: MessagePortMain,
  capabilities: DesktopPlatformCapabilities
): DesktopPlatformBinding {
  const connection = mainPlatformConnection(port);
  const owner = serveDesktopPlatform(connection, capabilities);
  const utilities = serveUtilityLending(connection, port, forkIndexUtility);
  return {
    close: async () => {
      const results = await Promise.allSettled([owner.close(), utilities.close()]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Desktop platform owners did not close');
      }
    },
    request: async (method, params, signal) => {
      signal?.throwIfAborted();
      const cancellation = new CancellationTokenSource();
      const cancel = (): void => cancellation.cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await connection.sendRequest(method, params, cancellation.token);
      } catch (cause) {
        throw fromBoundaryResponseError(cause, (message, fields) =>
          logger.error(message, { ...fields, method })
        );
      } finally {
        signal?.removeEventListener('abort', cancel);
        cancellation.dispose();
      }
    },
  };
}
