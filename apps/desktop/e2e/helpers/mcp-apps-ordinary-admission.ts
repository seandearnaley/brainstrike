import {
  composeRuntimeToolMap,
  createMcpAppOrdinaryToolCallPreparer,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent';
import { type McpHostPort, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
// @boundaries-ignore packaged verification composes the production Agent pipeline without exporting its internal assembly surface.
// @boundaries-ignore packaged verification composes the production Agent pipeline without exporting its internal assembly surface.
// @boundaries-ignore packaged verification uses the production transport-budget constructor required by the internal pipeline.
// @boundaries-ignore packaged verification exercises the local Apps package before production registration exports it to Desktop.
import type {
  McpAppPreparedToolCall,
  McpAppToolCall,
} from '../../../../packages/mcp-app-host/src/index';

interface AdmissionServer {
  readonly installAdmission: (
    prepare: (call: McpAppToolCall) => Promise<McpAppPreparedToolCall>
  ) => void;
  readonly origin: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function installOrdinaryRuntimeAdmission(
  server: AdmissionServer
): Promise<() => Promise<void>> {
  const configuredServerId = parseConfiguredMcpServerId('linear');
  const host: McpHostPort = {
    close: async () => ({
      callbacksClosed: 0,
      childProcessesClosed: 0,
      clientsClosed: 0,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    }),
    control: async () => {
      throw new Error('BST-1571 verifier does not expose host controls');
    },
    invoke: async (operation, options) => {
      if (operation.type === 'tools/list') {
        return parseMcpHostOperationResult({
          result: {
            tools: [
              {
                inputSchema: { type: 'object' },
                name: 'create_issue',
                outputSchema: { type: 'object' },
              },
            ],
          },
          type: operation.type,
        });
      }
      if (operation.type !== 'tools/call') {
        throw new Error(`BST-1571 unexpected host operation: ${operation.type}`);
      }
      const response = await fetch(`${server.origin}/tool`, {
        body: JSON.stringify(operation.arguments ?? {}),
        method: 'POST',
        signal: options?.signal,
      });
      if (!response.ok) {
        throw new Error(`BST-1571 loopback tool failed with ${response.status}`);
      }
      const result: unknown = await response.json();
      if (!isRecord(result)) {
        throw new Error('BST-1571 loopback tool returned an invalid result');
      }
      return parseMcpHostOperationResult({ result, type: operation.type });
    },
    replaceConfig: async () => {
      throw new Error('BST-1571 verifier does not replace host config');
    },
    snapshot: () => ({
      revision: 1,
      servers: [
        {
          configuredProtocol: '2026-07-28',
          configuredServerId,
          generation: 1,
          negotiated: { era: 'modern', revision: '2026-07-28' },
          state: 'connected',
          transport: 'streamable-http',
        },
      ],
    }),
    watch: () => () => undefined,
  };
  const runtime = await composeRuntimeToolMap({
    auth: undefined,
    getDelegationToolNames: undefined,
    hasStorage: true,
    hookRunner: undefined,
    inlineMaxSerializedCharsByToolName: undefined,
    localTools: undefined,
    mcpConfig: undefined,
    mcpHost: host,
    mcpTaskTracking: undefined,
    mcpTimeoutMs: undefined,
    permissionSnapshot: {
      defaultRisk: 'mcp',
      perToolOverrides: { 'linear.create_issue': 'ask' },
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { 'linear.create_issue': 'execute' },
      yolo: false,
    },
    planModeActive: false,
    preserveExecuteBackedWebSearch: undefined,
    provider: 'openai',
    remembered: () => undefined,
    resolvedToolResultBudget: resolveScaledToolResultBudget(131_072),
    toolOutputArtifactStore: undefined,
    workspaceSkills: undefined,
  });
  server.installAdmission(
    createMcpAppOrdinaryToolCallPreparer({ admission: runtime.mcpAppToolAdmission })
  );
  return async () => runtime.mcpClient?.disconnect();
}
