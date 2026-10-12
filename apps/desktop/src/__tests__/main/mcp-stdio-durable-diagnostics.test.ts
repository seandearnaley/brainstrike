import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import type { ResolvedMcpServer } from '@brainstrike/host-capabilities/mcp/config-file';
import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import { parseDiagnosticEventLine } from '@brainstrike/utils/diagnostics';
import { describe, expect, it, vi } from 'vitest';
import { createErrorLogSink } from '../../diagnostics/error-log-sink';
import { registerLoggingIpcHandlers } from '../../logging-ipc';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import { resetElectronMainTestHarness } from '../helpers/electron-main-test-harness';

const CONFIGURED_SERVER_ID = parseConfiguredMcpServerId('local.tools');

function createTransportClient() {
  return {
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ completion: { values: [] } })),
    connect: vi.fn(async () => undefined),
    getNegotiatedProtocolVersion: vi.fn(() => '2026-07-28'),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    getProtocolEra: vi.fn(() => 'modern' as const),
    getServerCapabilities: vi.fn(() => ({ tools: {} })),
    getServerVersion: vi.fn(() => ({ name: 'test', version: '1.0.0' })),
    listen: vi.fn(),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    listTools: vi.fn(async () => ({ tools: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
    subscribeResource: vi.fn(async () => undefined),
    unsubscribeResource: vi.fn(async () => undefined),
    watchServerFeatures: vi.fn(() => vi.fn()),
  };
}

function stdioServer(): Extract<ResolvedMcpServer, { transport: 'stdio' }> {
  return {
    args: [],
    command: '/test/mcp-server',
    name: CONFIGURED_SERVER_ID,
    protocol: 'auto',
    startup: 'authentication-required',
    transport: 'stdio',
  };
}

describe('MCP stdio durable diagnostics', () => {
  it('retains sanitized warnings across a durable sink restart', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-mcp-stderr-'));
    const filePath = path.join(directory, 'brainstrike-errors.ndjson');

    try {
      const sink = createErrorLogSink({
        appVersion: 'test',
        filePath,
        platform: 'test-platform',
        sessionId: 'before-restart',
      });
      const transportClient = createTransportClient();
      transportClient.connect.mockRejectedValueOnce(new Error('stdio connection failed'));
      resetElectronMainTestHarness();
      const unregisterLogging = registerLoggingIpcHandlers({
        getBufferedLogs: () => [],
        getState: () => ({
          capabilities: {
            canSelectDestination: true,
            defaultDestination: filePath,
            fileLoggingSupported: true,
            runtime: 'electron',
          },
          preferences: createDefaultLoggingPreferences(),
        }),
        ingestBufferedLog: vi.fn(),
        openDestination: vi.fn(async () => true),
        recordDurableLog: (record) => sink.recordLogRecord(record),
        selectDestination: vi.fn(async () => filePath),
        setPreferences: vi.fn(async (preferences: LoggingPreferences) => ({
          capabilities: {
            canSelectDestination: true,
            defaultDestination: filePath,
            fileLoggingSupported: true,
            runtime: 'electron' as const,
          },
          preferences,
        })),
      });
      const runtime = createDesktopMcpHostRuntime({
        createStdioTransportClient: (options) => {
          transportClient.close.mockImplementationOnce(async () => {
            options.onStderr?.(
              'Authorization: Bearer bst-test-bearer-value\n' +
                'Authorize at https://auth.example/callback?code=bst-test-code-value&' +
                'code_verifier=bst-test-verifier-value&state=bst-test-state-value&' +
                'redirect_uri=https%3A%2F%2Flocalhost%2Fcallback\n' +
                'code=bst-test-code-value&code_verifier=bst-test-verifier-value&' +
                'verifier=bst-test-standalone-verifier-value&state=bst-test-state-value\n'
            );
          });
          return transportClient;
        },
      });

      try {
        await runtime.replaceResolvedConfig({ servers: [stdioServer()] });
        await expect(
          runtime.host.control({ action: 'connect', configuredServerId: CONFIGURED_SERVER_ID })
        ).rejects.toMatchObject({ category: 'connection', code: 'mcp-connection-failed' });

        const diagnostics = runtime.host.snapshot().servers[0]?.diagnostics ?? [];
        expect(diagnostics).toHaveLength(3);
        expect(JSON.stringify(diagnostics)).not.toMatch(
          /bst-test-(?:bearer|code|verifier|standalone-verifier|state)-value|redirect_uri/u
        );
      } finally {
        await runtime.host.close();
        unregisterLogging();
        sink.close();
        resetElectronMainTestHarness();
      }

      const restartedSink = createErrorLogSink({
        appVersion: 'test',
        filePath,
        platform: 'test-platform',
        sessionId: 'after-restart',
      });
      try {
        restartedSink.recordLogRecord({
          args: [],
          bindings: { runtime: 'electron-main' },
          level: LogLevel.WARN,
          message: 'Restart marker',
          scope: 'Test',
          timestamp: Date.parse('2026-09-01T00:00:00.000Z'),
        });
      } finally {
        restartedSink.close();
      }

      const lines = (await fs.readFile(filePath, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0);
      const events = lines.map((line) => parseDiagnosticEventLine(line));
      expect(events).not.toContain(null);
      expect(events).toHaveLength(3);

      const stdioEvents = events.filter(
        (event) => event?.message === 'MCP stdio failure diagnostics'
      );
      expect(stdioEvents).toHaveLength(1);
      expect(stdioEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'before-restart',
            severity: 'warn',
          }),
        ])
      );
      expect(events.at(-1)).toMatchObject({
        message: 'Restart marker',
        sessionId: 'after-restart',
      });
      expect(JSON.stringify(events)).not.toMatch(
        /bst-test-(?:bearer|code|verifier|standalone-verifier|state)-value|redirect_uri/u
      );
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  });
});
