import { createLogger } from '@brainstrike/logging';
import type { MessageConnection } from 'vscode-jsonrpc';
import { fromBoundaryResponseError } from '../boundary-wire.js';

const logger = createLogger('HostCatalogClient');
export async function sendCatalogRequest(
  connection: MessageConnection,
  method: string,
  request: unknown
): Promise<unknown> {
  try {
    return await connection.sendRequest(method, request);
  } catch (cause) {
    throw fromBoundaryResponseError(cause, (message, fields) =>
      logger.error(message, { ...fields, method })
    );
  }
}
