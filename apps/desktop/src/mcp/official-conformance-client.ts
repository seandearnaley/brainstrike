import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { z } from 'zod';
import { parseMcpConfig, type ResolvedMcpConfig } from '../mcp-loader';
import { createDesktopMcpHostRuntime, type DesktopMcpHostRuntime } from './host-runtime';

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
]);

export interface ProductionConformanceClientRuntime {
  readonly host: Pick<DesktopMcpHostRuntime['host'], 'close' | 'invoke'>;
  replaceResolvedConfig(
    config: ResolvedMcpConfig
  ): ReturnType<DesktopMcpHostRuntime['replaceResolvedConfig']>;
}

interface ProductionConformanceClientDependencies {
  createRuntime?: () => ProductionConformanceClientRuntime;
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
  const runtime = dependencies.createRuntime?.() ?? createDesktopMcpHostRuntime();
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
    if (parsed.scenario === 'tools_call') {
      if (!listed.result.tools.some(({ name }) => name === 'add_numbers')) {
        throw new Error('Production MCP conformance server does not expose add_numbers');
      }
      const called = await runtime.host.invoke({
        arguments: { a: 5, b: 3 },
        configuredServerId: CONFORMANCE_SERVER_ID,
        toolName: 'add_numbers',
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
