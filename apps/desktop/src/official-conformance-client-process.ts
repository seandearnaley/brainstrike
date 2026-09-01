import { z } from 'zod';
import { runProductionMcpConformanceClient } from './mcp/official-conformance-client';
import {
  AllOfficialAuthScenarioNameSchema,
  parseOfficialAuthScenarioContext,
} from './mcp/official-conformance-oauth';
import { sanitizeStdioDiagnosticLine } from './mcp/stdio-diagnostics';

const FAILURE_CAUSE_MAX_DEPTH = 4;

const ProcessInputSchema = z.strictObject({
  context: z.string().optional(),
  protocolVersion: z.enum(['2025-11-25', '2026-07-28']),
  scenario: z.string().min(1),
  serverUrl: z
    .url({ protocol: /^https?$/u })
    .refine((value) => new URL(value).username === '' && new URL(value).password === '', {
      message: 'server URL must not include credentials',
    }),
});

interface ProcessDependencies {
  runClient?: typeof runProductionMcpConformanceClient;
  writeError?: (message: string) => void;
}

export function parseOfficialConformanceProcessInput(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv
): z.output<typeof ProcessInputSchema> {
  if (argv.length !== 1) {
    throw new Error('Production MCP conformance client requires exactly one server URL');
  }
  const context = environment['MCP_CONFORMANCE_CONTEXT'];
  const parsed = ProcessInputSchema.parse({
    ...(context === undefined ? {} : { context }),
    protocolVersion: environment['MCP_CONFORMANCE_PROTOCOL_VERSION'],
    scenario: environment['MCP_CONFORMANCE_SCENARIO'],
    serverUrl: argv[0],
  });
  const authScenario = AllOfficialAuthScenarioNameSchema.safeParse(parsed.scenario);
  if (authScenario.success) {
    parseOfficialAuthScenarioContext(authScenario.data, context);
  } else if (context !== undefined) {
    throw new Error('Production MCP conformance context is invalid');
  }
  return parsed;
}

export function describeConformanceFailureCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < FAILURE_CAUSE_MAX_DEPTH; depth += 1) {
    if (current === undefined || current === null) {
      break;
    }
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const flattened = parts.join(' <- ').replace(/\s+/gu, ' ');
  return sanitizeStdioDiagnosticLine(flattened)?.message ?? 'unknown cause';
}

export async function runOfficialConformanceProcess(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  dependencies: ProcessDependencies = {}
): Promise<number> {
  const writeError = dependencies.writeError ?? process.stderr.write.bind(process.stderr);
  let input: z.output<typeof ProcessInputSchema>;
  try {
    // Process input can carry credential-bearing auth context; never echo any
    // parse detail for it.
    input = parseOfficialConformanceProcessInput(argv, environment);
  } catch {
    writeError('Production MCP conformance client failed: invalid process input\n');
    return 1;
  }
  try {
    await (dependencies.runClient ?? runProductionMcpConformanceClient)(input);
    return 0;
  } catch (error) {
    writeError(
      `Production MCP conformance client failed: ${describeConformanceFailureCause(error)}\n`
    );
    return 1;
  }
}
