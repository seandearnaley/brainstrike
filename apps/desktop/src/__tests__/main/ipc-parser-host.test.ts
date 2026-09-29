/**
 * Tests for the parser host IPC bridge (Phase 4 Cycle 4.3).
 *
 * Mocks `electron.ipcMain` to capture handler registration. Uses a fake
 * ParserHostManager to verify the handler delegates correctly and returns
 * sensible responses for malformed payloads.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 4)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParserHostManager } from '../../parser-host-manager';
import {
  PARSER_HOST_PARSE_CHANNEL,
  type ParserHostParseRequest,
  type ParserHostParseResponse,
} from '../../parser-host-shared';

const ipcMainHandle = vi.hoisted(() => vi.fn());
const ipcMainRemoveHandler = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMainHandle,
    removeHandler: ipcMainRemoveHandler,
  },
}));

afterEach(() => {
  vi.resetModules();
  ipcMainHandle.mockReset();
  ipcMainRemoveHandler.mockReset();
});

function createFakeManager(
  parseImpl?: (req: ParserHostParseRequest) => Promise<ParserHostParseResponse>
): ParserHostManager {
  return {
    parse: vi.fn(
      parseImpl ??
        (async (req) => ({ ok: true, requestId: req.requestId, root: { type: 'Program' } }))
    ),
    stop: vi.fn(async () => undefined),
  } as unknown as ParserHostManager;
}

const validRequest: ParserHostParseRequest = {
  content: 'const x = 1',
  options: { errorRecovery: true, jsx: false, language: 'javascript' },
  requestId: 'ipc-1',
};

describe('registerParserHostIpcHandlers', () => {
  it('registers an ipcMain handler for the parse channel', async () => {
    const { registerParserHostIpcHandlers } = await import('../../ipc-parser-host');
    const manager = createFakeManager();

    registerParserHostIpcHandlers(manager);

    expect(ipcMainHandle).toHaveBeenCalledTimes(1);
    expect(ipcMainHandle.mock.calls[0]?.[0]).toBe(PARSER_HOST_PARSE_CHANNEL);
  });

  it('delegates valid parse requests to manager.parse', async () => {
    const { registerParserHostIpcHandlers } = await import('../../ipc-parser-host');
    const manager = createFakeManager();
    registerParserHostIpcHandlers(manager);

    const handler = ipcMainHandle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<ParserHostParseResponse>;
    const response = await handler({}, validRequest);

    expect(manager.parse).toHaveBeenCalledWith(validRequest);
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('ipc-1');
  });

  it('returns a malformed-request failure without calling manager.parse', async () => {
    const { registerParserHostIpcHandlers } = await import('../../ipc-parser-host');
    const manager = createFakeManager();
    registerParserHostIpcHandlers(manager);

    const handler = ipcMainHandle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<ParserHostParseResponse>;
    const response = await handler({}, { content: 999, requestId: 'bad' });

    expect(manager.parse).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expect(response.requestId).toBe('bad');
  });

  it.each([
    ['array request', Object.assign([], validRequest)],
    ['array options', { ...validRequest, options: Object.assign([], validRequest.options) }],
  ])('rejects an %s while preserving its request ID', async (_name, payload) => {
    const { registerParserHostIpcHandlers } = await import('../../ipc-parser-host');
    const manager = createFakeManager();
    registerParserHostIpcHandlers(manager);

    const handler = ipcMainHandle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<ParserHostParseResponse>;
    await expect(handler({}, payload)).resolves.toEqual({
      error: 'Malformed parser host parse request.',
      ok: false,
      requestId: 'ipc-1',
    });
    expect(manager.parse).not.toHaveBeenCalled();
  });

  it('returns a unique unregister callback that calls ipcMain.removeHandler', async () => {
    const { registerParserHostIpcHandlers } = await import('../../ipc-parser-host');
    const manager = createFakeManager();

    const unregister = registerParserHostIpcHandlers(manager);
    unregister();

    expect(ipcMainRemoveHandler).toHaveBeenCalledWith(PARSER_HOST_PARSE_CHANNEL);
  });
});
