import type { McpClientCapabilityOptions } from '@brainstrike/agent/mcp-client';
import { type McpHostOperation, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import {
  parseMcpConfig,
  type ResolvedMcpConfig,
} from '@brainstrike/host-capabilities/mcp/config-file';
import { z } from 'zod';
import {
  createDesktopMcpHostRuntime,
  type DesktopMcpHostRuntime,
  type DesktopMcpHostRuntimeDependencies,
} from './host-runtime';
import { createOfficialConformanceAuthorizationOpener } from './official-conformance-authorization';
import {
  AllOfficialAuthScenarioNameSchema,
  BaselineOfficialAuthScenarioNameSchema,
  createEphemeralOfficialConformanceOAuthRuntime,
  ModernOnlyOfficialAuthScenarioNameSchema,
  type OfficialAuthScenarioName,
} from './official-conformance-oauth';

const CONFORMANCE_SERVER_ID = parseConfiguredMcpServerId('official-conformance');
const OfficialCustomHeaderContextSchema = z.strictObject({
  name: z.literal('http-custom-headers'),
  toolCalls: z.tuple([
    z.strictObject({
      arguments: z.record(z.string(), z.json()),
      name: z.literal('test_custom_headers'),
    }),
    z.strictObject({
      arguments: z.record(z.string(), z.json()),
      name: z.literal('test_custom_headers_null'),
    }),
  ]),
});
const OfficialMrtrRequestedSchema = z.strictObject({
  properties: z.strictObject({
    confirmed: z.strictObject({
      description: z.string().optional(),
      type: z.literal('boolean'),
    }),
  }),
  required: z.tuple([z.literal('confirmed')]).optional(),
  type: z.literal('object'),
});
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
  z.strictObject({
    protocolVersion: z.literal('2026-07-28'),
    scenario: z.enum([
      'request-metadata',
      'sep-2322-client-request-state',
      'http-standard-headers',
      'http-invalid-tool-headers',
      'json-schema-ref-no-deref',
    ]),
    serverUrl: z.string().min(1),
  }),
  z.strictObject({
    context: z.string().min(1),
    protocolVersion: z.literal('2026-07-28'),
    scenario: z.literal('http-custom-headers'),
    serverUrl: z.string().min(1),
  }),
  z.strictObject({
    context: z.string().optional(),
    protocolVersion: z.enum(['2025-11-25', '2026-07-28']),
    scenario: BaselineOfficialAuthScenarioNameSchema,
    serverUrl: z.string().min(1),
  }),
  z.strictObject({
    context: z.string().optional(),
    protocolVersion: z.literal('2026-07-28'),
    scenario: ModernOnlyOfficialAuthScenarioNameSchema,
    serverUrl: z.string().min(1),
  }),
]);
type ProductionConformanceInput = z.output<typeof ProductionConformanceInputSchema>;
type McpToolArguments = NonNullable<Extract<McpHostOperation, { type: 'tools/call' }>['arguments']>;
type ToolScenario = 'elicitation-sep1034-client-defaults' | 'sse-retry' | 'tools_call';
const AUTH_SCENARIO_TOOL = Object.freeze({ arguments: {}, name: 'test-tool' });

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
  readonly host: Pick<DesktopMcpHostRuntime['host'], 'close' | 'control' | 'invoke'>;
  replaceResolvedConfig(
    config: ResolvedMcpConfig
  ): ReturnType<DesktopMcpHostRuntime['replaceResolvedConfig']>;
}

interface ProductionConformanceClientDependencies {
  createRuntime?: (
    dependencies: DesktopMcpHostRuntimeDependencies
  ) => ProductionConformanceClientRuntime;
  openAuthorization?: (url: string) => Promise<void>;
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
  if (scenario === 'sep-2322-client-request-state') {
    return {
      elicitation: {
        form: true,
        handle: async (request, context) => {
          context.signal.throwIfAborted();
          if (
            !(
              'requestedSchema' in request.params &&
              OfficialMrtrRequestedSchema.safeParse(request.params.requestedSchema).success
            )
          ) {
            throw new Error('Official MCP MRTR elicitation schema is unsupported');
          }
          return { action: 'accept', content: { confirmed: true } };
        },
        url: false,
      },
    };
  }
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

function isOfficialAuthScenario(value: string): value is OfficialAuthScenarioName {
  return AllOfficialAuthScenarioNameSchema.safeParse(value).success;
}

function isToolScenario(value: ProductionConformanceInput['scenario']): value is ToolScenario {
  return (
    value === 'elicitation-sep1034-client-defaults' ||
    value === 'sse-retry' ||
    value === 'tools_call'
  );
}

export function parseOfficialCustomHeaderContext(
  context: string | undefined
): z.output<typeof OfficialCustomHeaderContextSchema> {
  if (context === undefined) {
    throw new Error('Official MCP custom-header context is required');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(context);
  } catch {
    throw new Error('Official MCP custom-header context is invalid');
  }
  const parsed = OfficialCustomHeaderContextSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('Official MCP custom-header context is invalid');
  }
  return parsed.data;
}

async function callScenarioTool(
  runtime: ProductionConformanceClientRuntime,
  listed: Awaited<ReturnType<ProductionConformanceClientRuntime['host']['invoke']>>,
  name: string,
  arguments_: McpToolArguments
): Promise<void> {
  if (listed.type !== 'tools/list') {
    throw new Error('Production MCP conformance client received an invalid tools/list result');
  }
  if (!listed.result.tools.some((tool) => tool.name === name)) {
    throw new Error(`Production MCP conformance server does not expose ${name}`);
  }
  const called = await runtime.host.invoke({
    arguments: arguments_,
    configuredServerId: CONFORMANCE_SERVER_ID,
    toolName: name,
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

async function runHttpStandardHeadersScenario(
  runtime: ProductionConformanceClientRuntime,
  listed: Awaited<ReturnType<ProductionConformanceClientRuntime['host']['invoke']>>
): Promise<void> {
  await callScenarioTool(runtime, listed, 'test_headers', {});
  const resources = await runtime.host.invoke({
    configuredServerId: CONFORMANCE_SERVER_ID,
    type: 'resources/list',
  });
  if (resources.type !== 'resources/list') {
    throw new Error('Production MCP conformance client received an invalid resources/list result');
  }
  const [resource] = resources.result.resources;
  if (!resource) {
    throw new Error('Production MCP conformance server exposes no resource for header proof');
  }
  await runtime.host.invoke({
    configuredServerId: CONFORMANCE_SERVER_ID,
    type: 'resources/read',
    uri: resource.uri,
  });
  const prompts = await runtime.host.invoke({
    configuredServerId: CONFORMANCE_SERVER_ID,
    type: 'prompts/list',
  });
  if (prompts.type !== 'prompts/list') {
    throw new Error('Production MCP conformance client received an invalid prompts/list result');
  }
  const [prompt] = prompts.result.prompts;
  if (!prompt) {
    throw new Error('Production MCP conformance server exposes no prompt for header proof');
  }
  await runtime.host.invoke({
    configuredServerId: CONFORMANCE_SERVER_ID,
    name: prompt.name,
    type: 'prompts/get',
  });
}

async function runModernScenario(
  parsed: ProductionConformanceInput,
  runtime: ProductionConformanceClientRuntime,
  listed: Awaited<ReturnType<ProductionConformanceClientRuntime['host']['invoke']>>
): Promise<boolean> {
  switch (parsed.scenario) {
    case 'json-schema-ref-no-deref':
      return true;
    case 'sep-2322-client-request-state':
      await Promise.all(
        [
          'test_mrtr_echo_state',
          'test_mrtr_unrelated',
          'test_mrtr_no_state',
          'test_mrtr_no_result_type',
        ].map((name) => callScenarioTool(runtime, listed, name, {}))
      );
      return true;
    case 'http-standard-headers':
      await runHttpStandardHeadersScenario(runtime, listed);
      return true;
    case 'http-custom-headers': {
      await Promise.all(
        parseOfficialCustomHeaderContext(parsed.context).toolCalls.map((toolCall) =>
          callScenarioTool(runtime, listed, toolCall.name, toolCall.arguments)
        )
      );
      return true;
    }
    case 'http-invalid-tool-headers':
      await callScenarioTool(runtime, listed, 'valid_tool', { region: 'us-west1' });
      return true;
    case 'initialize':
    case 'request-metadata':
    case 'elicitation-sep1034-client-defaults':
    case 'sse-retry':
    case 'tools_call':
      return false;
    default:
      if (isOfficialAuthScenario(parsed.scenario)) {
        return false;
      }
      return assertUnreachableScenario(parsed.scenario);
  }
}

function assertUnreachableScenario(scenario: never): never {
  throw new Error(`Production MCP conformance scenario is unhandled: ${scenario}`);
}

function composeProductionRuntime(
  parsed: ProductionConformanceInput,
  dependencies: ProductionConformanceClientDependencies
): {
  authScenario: OfficialAuthScenarioName | undefined;
  config: ResolvedMcpConfig;
  oauthDependencies: ReturnType<typeof createEphemeralOfficialConformanceOAuthRuntime> | undefined;
  runtime: ProductionConformanceClientRuntime;
} {
  const authScenario = isOfficialAuthScenario(parsed.scenario) ? parsed.scenario : undefined;
  const oauthDependencies = authScenario
    ? createEphemeralOfficialConformanceOAuthRuntime({
        ...('context' in parsed && parsed.context !== undefined ? { context: parsed.context } : {}),
        openAuthorization:
          dependencies.openAuthorization ?? createOfficialConformanceAuthorizationOpener(),
        scenario: authScenario,
      })
    : undefined;
  const config = parseMcpConfig(
    JSON.stringify({
      servers: [
        {
          auth: { type: authScenario ? 'oauth-user' : 'none' },
          name: CONFORMANCE_SERVER_ID,
          protocol: parsed.protocolVersion === '2025-11-25' ? 'legacy' : '2026-07-28',
          startup: authScenario ? 'authentication-required' : 'automatic',
          transport: 'streamable-http',
          url: parsed.serverUrl,
        },
      ],
    })
  );
  const runtimeDependencies = {
    ...oauthDependencies,
    resolveClientCapabilities: () => clientCapabilitiesForScenario(parsed.scenario),
  } satisfies DesktopMcpHostRuntimeDependencies;
  const runtime =
    dependencies.createRuntime?.(runtimeDependencies) ??
    createDesktopMcpHostRuntime(runtimeDependencies);
  return { authScenario, config, oauthDependencies, runtime };
}

async function executeProductionScenario(
  parsed: ProductionConformanceInput,
  runtime: ProductionConformanceClientRuntime,
  config: ResolvedMcpConfig,
  authScenario: OfficialAuthScenarioName | undefined
): Promise<void> {
  await runtime.replaceResolvedConfig(config);
  if (parsed.scenario === 'initialize' || parsed.scenario === 'request-metadata') {
    const connected = await runtime.host.control({
      action: 'connect',
      configuredServerId: CONFORMANCE_SERVER_ID,
    });
    if (connected.state !== 'connected') {
      throw new Error(
        `Production MCP conformance ${parsed.scenario} connection did not reach connected state`
      );
    }
    return;
  }
  if (authScenario) {
    const connected = await runtime.host.control({
      action: 'connect',
      configuredServerId: CONFORMANCE_SERVER_ID,
    });
    if (connected.state !== 'connected') {
      throw new Error('Production MCP conformance OAuth connection did not reach connected state');
    }
  }
  const listed = await runtime.host.invoke({
    configuredServerId: CONFORMANCE_SERVER_ID,
    type: 'tools/list',
  });
  if (listed.type !== 'tools/list') {
    throw new Error('Production MCP conformance client received an invalid tools/list result');
  }
  if (authScenario && authScenario !== 'auth/pre-registration') {
    // The alpha.10 auth fixtures expose one common tool after authorization.
    await callScenarioTool(runtime, listed, AUTH_SCENARIO_TOOL.name, AUTH_SCENARIO_TOOL.arguments);
    return;
  }
  if (await runModernScenario(parsed, runtime, listed)) {
    return;
  }
  // Pre-registration is proven by the authenticated connect and tools/list; its
  // upstream fixture intentionally does not require the common auth tool call.
  if (isToolScenario(parsed.scenario)) {
    const target = scenarioTool(parsed.scenario);
    await callScenarioTool(runtime, listed, target.name, target.arguments);
  }
}

async function collectCleanupFailures(
  runtime: ProductionConformanceClientRuntime,
  oauthDependencies: ReturnType<typeof createEphemeralOfficialConformanceOAuthRuntime> | undefined,
  failures: unknown[]
): Promise<void> {
  try {
    const failure = cleanupError(await runtime.host.close());
    if (failure) {
      failures.push(failure);
    }
  } catch (error) {
    failures.push(error);
  }
  if (!oauthDependencies) {
    return;
  }
  try {
    await oauthDependencies.oauthStore.clearAll();
  } catch (error) {
    failures.push(
      new Error('Production MCP conformance OAuth state cleanup failed', { cause: error })
    );
  }
}

export async function runProductionMcpConformanceClient(
  input: unknown,
  dependencies: ProductionConformanceClientDependencies = {}
): Promise<void> {
  const parsed = ProductionConformanceInputSchema.parse(input);
  const { authScenario, config, oauthDependencies, runtime } = composeProductionRuntime(
    parsed,
    dependencies
  );
  const failures: unknown[] = [];
  try {
    await executeProductionScenario(parsed, runtime, config, authScenario);
  } catch (error) {
    failures.push(error);
  }
  await collectCleanupFailures(runtime, oauthDependencies, failures);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Production MCP conformance client and cleanup failed');
  }
}
