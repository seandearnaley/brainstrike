import { sanitizeStdioDiagnosticLine } from '@brainstrike/host-capabilities/mcp/stdio-diagnostics';
import { z } from 'zod';
import {
  parseOfficialCustomHeaderContext,
  runProductionMcpConformanceClient,
} from './mcp/official-conformance-client';
import {
  AllOfficialAuthScenarioNameSchema,
  parseOfficialAuthScenarioContext,
} from './mcp/official-conformance-oauth';

const FAILURE_CAUSE_MAX_DEPTH = 4;
const FAILURE_CAUSE_MAX_PARTS = 6;
const FAILURE_CAUSE_MAX_AGGREGATED = 3;

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
  } else if (parsed.scenario === 'http-custom-headers') {
    parseOfficialCustomHeaderContext(context);
  } else if (context !== undefined) {
    throw new Error('Production MCP conformance context is invalid');
  }
  return parsed;
}

function collectFailureCauseParts(error: unknown, parts: string[], depth: number): void {
  if (
    error === undefined ||
    error === null ||
    depth >= FAILURE_CAUSE_MAX_DEPTH ||
    parts.length >= FAILURE_CAUSE_MAX_PARTS
  ) {
    return;
  }
  if (!(error instanceof Error)) {
    try {
      parts.push(String(error));
    } catch {
      parts.push('[unprintable cause]');
    }
    return;
  }
  parts.push(`${error.name}: ${error.message}`);
  if (error instanceof AggregateError) {
    for (const aggregated of error.errors.slice(0, FAILURE_CAUSE_MAX_AGGREGATED)) {
      collectFailureCauseParts(aggregated, parts, depth + 1);
    }
  }
  collectFailureCauseParts(error.cause, parts, depth + 1);
}

export function describeConformanceFailureCause(error: unknown): string {
  const parts: string[] = [];
  collectFailureCauseParts(error, parts, 0);
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
