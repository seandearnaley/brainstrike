import { createLogger } from '@brainstrike/logging';
import type { MessageConnection } from 'vscode-jsonrpc';
import { sendHostRequest } from '../client-request.ts';

const logger = createLogger('HostCatalogClient');
export async function sendCatalogRequest(
  connection: MessageConnection,
  method: string,
  request: unknown
): Promise<unknown> {
  return await sendHostRequest(
    connection,
    () => connection.sendRequest(method, request),
    (message, fields) => logger.error(message, { ...fields, method })
  );
}
