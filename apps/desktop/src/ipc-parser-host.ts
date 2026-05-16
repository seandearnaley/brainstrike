/**
 * Main-process IPC bridge for the parser host.
 *
 * Registers an `ipcMain.handle` for the parser host's parse channel. The
 * chunking-host renderer (or any other renderer that needs JS/TS AST data)
 * calls `ipcRenderer.invoke(PARSER_HOST_PARSE_CHANNEL, request)` and gets a
 * `ParserHostParseResponse` back. The handler delegates to a
 * `ParserHostManager` which owns the underlying utility process.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import type { ParserHostManager } from './parser-host-manager';
import {
  PARSER_HOST_PARSE_CHANNEL,
  type ParserHostParseRequest,
  type ParserHostParseResponse,
} from './parser-host-shared';

/**
 * Conservative payload validation. Mirrors the type guard in
 * parser-host-entry.ts so the main process refuses to forward malformed
 * requests rather than letting them propagate to the utility process.
 */
function isParseRequest(value: unknown): value is ParserHostParseRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v['requestId'] !== 'string' || typeof v['content'] !== 'string') {
    return false;
  }
  const opts = v['options'];
  if (opts === null || typeof opts !== 'object') {
    return false;
  }
  const o = opts as Record<string, unknown>;
  return (
    (o['language'] === 'javascript' || o['language'] === 'typescript') &&
    typeof o['jsx'] === 'boolean' &&
    typeof o['errorRecovery'] === 'boolean'
  );
}

/**
 * Register the parser host IPC handler. Returns an unregister callback so
 * the caller can clean up during shutdown.
 */
export function registerParserHostIpcHandlers(manager: ParserHostManager): () => void {
  ipcMain.handle(
    PARSER_HOST_PARSE_CHANNEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ParserHostParseResponse> => {
      if (!isParseRequest(payload)) {
        return {
          error: 'Malformed parser host parse request.',
          ok: false,
          requestId:
            payload !== null &&
            typeof payload === 'object' &&
            'requestId' in payload &&
            typeof (payload as { requestId?: unknown }).requestId === 'string'
              ? (payload as { requestId: string }).requestId
              : 'unknown',
        };
      }
      return manager.parse(payload);
    }
  );

  return () => {
    ipcMain.removeHandler(PARSER_HOST_PARSE_CHANNEL);
  };
}
