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
  extractParserHostRequestId,
  isParserHostParseRequest,
  PARSER_HOST_PARSE_CHANNEL,
  type ParserHostParseResponse,
} from './parser-host-shared';

/**
 * Register the parser host IPC handler. Returns an unregister callback so
 * the caller can clean up during shutdown.
 *
 * Payload validation uses the shared `isParserHostParseRequest` guard from
 * `parser-host-shared.ts` — same predicate the utility-process entry uses
 * on the other side of the IPC boundary, so the two sides can't drift.
 */
export function registerParserHostIpcHandlers(manager: ParserHostManager): () => void {
  ipcMain.handle(
    PARSER_HOST_PARSE_CHANNEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ParserHostParseResponse> => {
      if (!isParserHostParseRequest(payload)) {
        return {
          error: 'Malformed parser host parse request.',
          ok: false,
          requestId: extractParserHostRequestId(payload),
        };
      }
      return manager.parse(payload);
    }
  );

  return () => {
    ipcMain.removeHandler(PARSER_HOST_PARSE_CHANNEL);
  };
}
