import {
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProductionConformanceClientRuntime,
  runProductionMcpConformanceClient,
} from '../../mcp/official-conformance-client.js';
import { MODERN_ONLY_OFFICIAL_AUTH_SCENARIO_NAMES } from '../../mcp/official-conformance-oauth.js';

const MODERN_ONLY_AUTH_SCENARIOS = [
  'auth/resource-mismatch',
  'auth/offline-access-scope',
  'auth/offline-access-not-supported',
  'auth/authorization-server-migration',
  'auth/iss-supported',
  'auth/iss-not-advertised',
  'auth/iss-supported-missing',
  'auth/iss-wrong-issuer',
  'auth/iss-unexpected',
  'auth/iss-normalized',
  'auth/metadata-issuer-mismatch',
] as const;
const SERVER_ID = parseConfiguredMcpServerId('official-conformance');

function connectedSnapshot(): McpHostServerSnapshot {
  return {
    configuredProtocol: '2026-07-28',
    configuredServerId: SERVER_ID,
    generation: 1,
    negotiated: {
      advertisedCapabilityIds: ['tools'],
      era: 'modern',
      revision: '2026-07-28',
    },
    state: 'connected',
    transport: 'streamable-http',
  };
}

function connectedRuntime(): ProductionConformanceClientRuntime {
  return {
    host: {
      close: vi.fn(async () => ({
        callbacksClosed: 0,
        childProcessesClosed: 0,
        clientsClosed: 1,
        failures: [],
        loopbackPortsClosed: 0,
        probesClosed: 0,
        requestsSettled: 1,
        subscriptionsClosed: 0,
      })),
      control: vi.fn(async () => connectedSnapshot()),
      invoke: vi.fn(async (operation: McpHostOperation): Promise<McpHostOperationResult> => {
        if (operation.type === 'tools/list') {
          return {
            result: { tools: [{ inputSchema: { type: 'object' }, name: 'test-tool' }] },
            type: 'tools/list',
          };
        }
        return {
          result: { content: [{ text: 'ok', type: 'text' }] },
          type: 'tools/call',
        };
      }),
    },
    replaceResolvedConfig: vi.fn(async () => ({ revision: 1, servers: [] })),
  };
}

describe('official conformance modern-only auth adapter', () => {
  it('pins the exact eleven alpha.10 scenarios in upstream order', () => {
    expect(MODERN_ONLY_OFFICIAL_AUTH_SCENARIO_NAMES).toEqual(MODERN_ONLY_AUTH_SCENARIOS);
  });

  it.each(MODERN_ONLY_AUTH_SCENARIOS)(
    'routes %s through the production host at 2026-07-28',
    async (scenario) => {
      const runtime = connectedRuntime();

      await runProductionMcpConformanceClient(
        {
          protocolVersion: '2026-07-28',
          scenario,
          serverUrl: 'http://127.0.0.1:4000/mcp',
        },
        { createRuntime: () => runtime, openAuthorization: vi.fn() }
      );

      expect(runtime.replaceResolvedConfig).toHaveBeenCalledWith({
        servers: [
          expect.objectContaining({
            auth: { type: 'oauth-user' },
            protocol: '2026-07-28',
            startup: 'authentication-required',
          }),
        ],
      });
      expect(runtime.host.control).toHaveBeenCalledOnce();
      expect(runtime.host.invoke).toHaveBeenLastCalledWith({
        arguments: {},
        configuredServerId: 'official-conformance',
        toolName: 'test-tool',
        type: 'tools/call',
      });
    }
  );

  it.each(MODERN_ONLY_AUTH_SCENARIOS)(
    'rejects fabricated 2025 applicability for %s before runtime creation',
    async (scenario) => {
      const createRuntime = vi.fn();

      await expect(
        runProductionMcpConformanceClient(
          {
            protocolVersion: '2025-11-25',
            scenario,
            serverUrl: 'http://127.0.0.1:4000/mcp',
          },
          { createRuntime }
        )
      ).rejects.toThrow(/protocolVersion/u);
      expect(createRuntime).not.toHaveBeenCalled();
    }
  );
});
