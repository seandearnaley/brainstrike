import type { McpClientCapabilityOptions } from '@brainstrike/agent/mcp-client';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { z } from 'zod';
import { parseMcpConfig, type ResolvedMcpConfig } from '../mcp-loader';
import {
  createDesktopMcpHostRuntime,
  type DesktopMcpHostRuntime,
  type DesktopMcpHostRuntimeDependencies,
} from './host-runtime';

const CONFORMANCE_SERVER_ID = parseConfiguredMcpServerId('official-conformance');
const ProductionConformanceInputSchema = z.discriminatedUnion('scenario', [
  z.strictObject({
    protocolVersion: z.literal('2025-11-25'),
    scenario: z.literal('initialize'),
    serverUrl: z.string().min(1),
  }),
  z.strictObject({
    protocolVersion: z.enum(['2025-11-25', '2026-07-28']),
    scenario: z.literal('tools_call'),
    serverUrl: z.string().min(1),
  }),
  z.strictObject({
    protocolVersion: z.literal('2025-11-25'),
    scenario: z.literal('elicitation-sep1034-client-defaults'),
    serverUrl: z.string().min(1),
  }),
  z.strictObject({
    protocolVersion: z.literal('2025-11-25'),
    scenario: z.literal('sse-retry'),
    serverUrl: z.string().min(1),
  }),
]);
type ProductionConformanceInput = z.output<typeof ProductionConformanceInputSchema>;
type ToolScenario = Exclude<ProductionConformanceInput['scenario'], 'initialize'>;

function scenarioTool(scenario: ToolScenario): {
  arguments: Record<string, number>;
  name: string;
} {
  switch (scenario) {
    case 'elicitation-sep1034-client-defaults':
      return { arguments: {}, name: 'test_client_elicitation_defaults' };
    case 'sse-retry':
      return { arguments: {}, name: 'test_reconnection' };
    case 'tools_call':
      return { arguments: { a: 5, b: 3 }, name: 'add_numbers' };
  }
}

export interface ProductionConformanceClientRuntime {
  readonly host: Pick<DesktopMcpHostRuntime['host'], 'close' | 'invoke'>;
  replaceResolvedConfig(
    config: ResolvedMcpConfig
  ): ReturnType<DesktopMcpHostRuntime['replaceResolvedConfig']>;
}

interface ProductionConformanceClientDependencies {
  createRuntime?: (
    dependencies: DesktopMcpHostRuntimeDependencies
  ) => ProductionConformanceClientRuntime;
}

function cleanupError(
  report: Awaited<ReturnType<DesktopMcpHostRuntime['host']['close']>>
): Error | undefined {
  if (report.failures.length === 0) {
    return;
  }
  return new Error('Production MCP conformance client cleanup reported failures', {
    cause: report,
  });
}

function clientCapabilitiesForScenario(
  scenario: ProductionConformanceInput['scenario']
): McpClientCapabilityOptions | undefined {
  if (scenario !== 'elicitation-sep1034-client-defaults') {
    return;
  }
  return {
    elicitation: {
      applyDefaults: true,
      form: true,
      handle: async (_request, context) => {
        context.signal.throwIfAborted();
        return { action: 'accept', content: {} };
      },
      url: false,
    },
  };
}

export async function runProductionMcpConformanceClient(
  input: unknown,
  dependencies: ProductionConformanceClientDependencies = {}
): Promise<void> {
  const parsed = ProductionConformanceInputSchema.parse(input);
  const config = parseMcpConfig(
    JSON.stringify({
      servers: [
        {
          auth: { type: 'none' },
          name: CONFORMANCE_SERVER_ID,
          protocol: parsed.protocolVersion === '2025-11-25' ? 'legacy' : '2026-07-28',
          startup: 'automatic',
          transport: 'streamable-http',
          url: parsed.serverUrl,
        },
      ],
    })
  );
  const runtimeDependencies = {
    resolveClientCapabilities: () => clientCapabilitiesForScenario(parsed.scenario),
  } satisfies DesktopMcpHostRuntimeDependencies;
  const runtime =
    dependencies.createRuntime?.(runtimeDependencies) ??
    createDesktopMcpHostRuntime(runtimeDependencies);
  const failures: unknown[] = [];
  try {
    await runtime.replaceResolvedConfig(config);
    const listed = await runtime.host.invoke({
      configuredServerId: CONFORMANCE_SERVER_ID,
      type: 'tools/list',
    });
    if (listed.type !== 'tools/list') {
      throw new Error('Production MCP conformance client received an invalid tools/list result');
    }
    if (parsed.scenario !== 'initialize') {
      const target = scenarioTool(parsed.scenario);
      if (!listed.result.tools.some(({ name }) => name === target.name)) {
        throw new Error(`Production MCP conformance server does not expose ${target.name}`);
      }
      const called = await runtime.host.invoke({
        arguments: target.arguments,
        configuredServerId: CONFORMANCE_SERVER_ID,
        toolName: target.name,
        type: 'tools/call',
      });
      if (called.type !== 'tools/call') {
        throw new Error('Production MCP conformance client received an invalid tools/call result');
      }
      if (called.result.isError === true) {
        throw new Error('Production MCP conformance server reported a tools/call error', {
          cause: called.result,
        });
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const failure = cleanupError(await runtime.host.close());
    if (failure) {
      failures.push(failure);
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Production MCP conformance client and cleanup failed');
  }
}
