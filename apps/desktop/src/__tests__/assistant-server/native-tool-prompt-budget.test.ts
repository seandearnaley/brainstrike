import { createMastraAgentRuntime, type RuntimeData } from '@brainstrike/agent';
import { get_encoding } from 'tiktoken';
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(),
}));

const MAX_PROVIDER_VISIBLE_NATIVE_TOOL_TOKENS = 7900;
const SUSPENDING_TOOL_IDS = ['brainstrike.askUser', 'brainstrike.submitPlan'] as const;

interface ProviderFunctionTool {
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
  type: 'function';
}

interface MastraProviderTool {
  description: string;
  inputSchema: unknown;
}

function snapshotProviderToolSurface(
  tools: NonNullable<RuntimeData['mastraTools']>
): Readonly<Record<string, MastraProviderTool>> {
  return Object.fromEntries(
    Object.entries(tools).map(([toolId, tool]) => [
      toolId,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    ])
  );
}

/**
 * Suspension/resume schemas are workflow metadata, not model-visible tool
 * definitions. Strip only that metadata so the real Mastra conversion keeps
 * both hosted tools without constructing a database-backed workflow store.
 */
function omitNonProviderSuspendMetadata(
  tools: NonNullable<RuntimeData['mastraTools']>
): NonNullable<RuntimeData['mastraTools']> {
  const promptTools = { ...tools };
  for (const toolId of SUSPENDING_TOOL_IDS) {
    const tool = tools[toolId];
    if (!tool) {
      throw new Error(`Desktop hosted registry is missing ${toolId}`);
    }
    promptTools[toolId] = {
      description: tool.description,
      execute: tool.execute,
      id: tool.id,
      inputSchema: tool.inputSchema,
    };
  }
  return promptTools;
}

interface JsonSchemaConversionContext {
  jsonSchema: Record<string, unknown>;
  zodSchema: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function applyMastraJsonSchemaOverride(context: JsonSchemaConversionContext): undefined {
  const zodSchema = asRecord(context.zodSchema);
  const jsonSchema = context.jsonSchema;
  if (
    jsonSchema['type'] === 'object' &&
    jsonSchema['properties'] !== undefined &&
    !jsonSchema['additionalProperties']
  ) {
    jsonSchema['additionalProperties'] = false;
  }

  const legacyDefinition = asRecord(zodSchema?.['_def']);
  const schemaType = zodSchema?.['type'];
  const isDate = schemaType === 'date' || legacyDefinition?.['typeName'] === 'ZodDate';
  if (isDate) {
    if (schemaType === 'date') {
      jsonSchema['type'] = 'string';
      jsonSchema['format'] = 'date-time';
    }
    const zodInternals = asRecord(zodSchema?.['_zod']);
    const zodDefinition = asRecord(zodInternals?.['def']);
    jsonSchema['x-date'] = !zodDefinition?.['coerce'];
    return;
  }

  const zodInternals = asRecord(zodSchema?.['_zod']);
  const zodDefinition = asRecord(zodInternals?.['def']);
  const catchall = asRecord(zodDefinition?.['catchall']);
  if (schemaType === 'object' && catchall?.['type'] === 'unknown') {
    jsonSchema['additionalProperties'] = true;
  }
}

/**
 * Mirrors @mastra/core 1.51's public standardSchemaToJSONSchema(..., { io:
 * 'input' }) boundary through the schema's Standard Schema protocol. Desktop
 * declares Zod, not @mastra/core, so the test invokes that protocol directly
 * instead of reaching through another workspace package's node_modules.
 */
function toMastraStandardInputJsonSchema(schema: unknown, toolName: string): unknown {
  const standard = asRecord(schema)?.['~standard'];
  const jsonSchema = asRecord(standard)?.['jsonSchema'];
  const input = asRecord(jsonSchema)?.['input'];
  if (typeof input !== 'function') {
    throw new Error(`Desktop tool ${toolName} is not a Standard Schema with JSON input support`);
  }
  const converted = input({
    libraryOptions: {
      override: applyMastraJsonSchemaOverride,
      unrepresentable: 'any',
    },
    target: 'draft-07',
  });
  return JSON.parse(JSON.stringify(converted)) as unknown;
}

function buildProviderFunctionTools(
  tools: Readonly<Record<string, MastraProviderTool>>,
  nameMap: ReadonlyMap<string, string>
): ProviderFunctionTool[] {
  return Array.from(nameMap, ([name, originalName]) => {
    const tool = tools[originalName];
    if (!tool) {
      throw new Error(`Runtime tool-name map references missing desktop tool ${originalName}`);
    }
    return {
      function: {
        description: tool.description,
        name,
        parameters: toMastraStandardInputJsonSchema(tool.inputSchema, originalName),
      },
      type: 'function' as const,
    };
  });
}

function countO200kTokens(text: string): number {
  const encoding = get_encoding('o200k_base');
  try {
    return encoding.encode(text).length;
  } finally {
    encoding.free();
  }
}

function formatBudgetFailure(args: {
  descriptions: number;
  instructions: number;
  schemas: number;
  toolBreakdown: readonly { name: string; tokens: number }[];
  total: number;
}): string {
  const tools = args.toolBreakdown.map(({ name, tokens }) => `  ${name}: ${tokens}`).join('\n');
  return [
    `Provider-visible native tool surface is ${args.total} tokens; budget is ${MAX_PROVIDER_VISIBLE_NATIVE_TOOL_TOKENS}.`,
    `  instructions: ${args.instructions}`,
    `  descriptions: ${args.descriptions}`,
    `  schemas: ${args.schemas}`,
    '  serialized tools:',
    tools,
  ].join('\n');
}

describe('desktop native tool provider prompt budget', () => {
  it('keeps the exact full hosted registry and instructions within 7,900 o200k tokens', async () => {
    const desktopTools = buildDesktopAssistantTools({ provider: 'openrouter' } as RuntimeData);
    const providerSurface = snapshotProviderToolSurface(desktopTools);
    const runtime = await createMastraAgentRuntime({
      runtime: {
        apiKey: 'prompt-budget-test-key',
        provider: 'openrouter',
      },
      tools: omitNonProviderSuspendMetadata(desktopTools),
    });

    try {
      const resolvedInstructions = await runtime.agent.getInstructions();
      if (typeof resolvedInstructions !== 'string') {
        throw new TypeError('Brainstrike hosted instructions must resolve to one string');
      }
      const providerTools = buildProviderFunctionTools(providerSurface, runtime.toolNameMap);
      const payload = JSON.stringify({ instructions: resolvedInstructions, tools: providerTools });
      const total = countO200kTokens(payload);
      const toolBreakdown = providerTools.map((tool) => ({
        name: tool.function.name,
        tokens: countO200kTokens(JSON.stringify(tool)),
      }));
      const descriptions = countO200kTokens(
        providerTools.map((tool) => tool.function.description).join('\n')
      );
      const schemas = providerTools.reduce(
        (tokens, tool) => tokens + countO200kTokens(JSON.stringify(tool.function.parameters)),
        0
      );
      const instructionTokens = countO200kTokens(resolvedInstructions);

      expect(
        total,
        formatBudgetFailure({
          descriptions,
          instructions: instructionTokens,
          schemas,
          toolBreakdown,
          total,
        })
      ).toBeLessThanOrEqual(MAX_PROVIDER_VISIBLE_NATIVE_TOOL_TOKENS);
    } finally {
      await runtime.dispose();
    }
  });
});
