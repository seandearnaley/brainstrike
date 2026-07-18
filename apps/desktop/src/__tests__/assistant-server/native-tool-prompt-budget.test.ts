import {
  createMastraAgentRuntime,
  PROVIDER_DEFAULT_MODELS,
  type RuntimeData,
} from '@brainstrike/agent';
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

const MAX_AUTHORED_NATIVE_TOOL_TOKENS = 7900;
const MAX_MASTRA_OPENROUTER_NATIVE_TOOL_TOKENS = 11_500;
const OPENROUTER_PROMPT_BUDGET_MODEL = 'openai/gpt-5.6-terra';
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
  budget: number;
  descriptions: number;
  instructions: number;
  label: string;
  schemas: number;
  toolBreakdown: readonly { name: string; tokens: number }[];
  total: number;
}): string {
  const tools = args.toolBreakdown.map(({ name, tokens }) => `  ${name}: ${tokens}`).join('\n');
  return [
    `${args.label} is ${args.total} tokens; budget is ${args.budget}.`,
    `  instructions: ${args.instructions}`,
    `  descriptions: ${args.descriptions}`,
    `  schemas: ${args.schemas}`,
    '  serialized tools:',
    tools,
  ].join('\n');
}

function expectProviderSurfaceWithinBudget(args: {
  budget: number;
  instructions: string;
  label: string;
  tools: readonly ProviderFunctionTool[];
}): void {
  const payload = JSON.stringify({ instructions: args.instructions, tools: args.tools });
  const total = countO200kTokens(payload);
  const toolBreakdown = args.tools.map((tool) => ({
    name: tool.function.name,
    tokens: countO200kTokens(JSON.stringify(tool)),
  }));
  const descriptions = countO200kTokens(
    args.tools.map((tool) => tool.function.description).join('\n')
  );
  const schemas = args.tools.reduce(
    (tokens, tool) => tokens + countO200kTokens(JSON.stringify(tool.function.parameters)),
    0
  );
  const instructions = countO200kTokens(args.instructions);

  expect(
    total,
    formatBudgetFailure({
      budget: args.budget,
      descriptions,
      instructions,
      label: args.label,
      schemas,
      toolBreakdown,
      total,
    })
  ).toBeLessThanOrEqual(args.budget);
}

describe('desktop native tool provider prompt budget', () => {
  it('keeps the authored full hosted registry and instructions within 7,900 o200k tokens', async () => {
    expect(PROVIDER_DEFAULT_MODELS.openrouter).toBe(OPENROUTER_PROMPT_BUDGET_MODEL);
    const desktopTools = buildDesktopAssistantTools({ provider: 'openrouter' } as RuntimeData);
    const providerSurface = snapshotProviderToolSurface(desktopTools);
    const runtime = await createMastraAgentRuntime({
      model: OPENROUTER_PROMPT_BUDGET_MODEL,
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
      expectProviderSurfaceWithinBudget({
        budget: MAX_AUTHORED_NATIVE_TOOL_TOKENS,
        instructions: resolvedInstructions,
        label: 'Authored native tool surface',
        tools: providerTools,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps the actual Mastra/OpenRouter full hosted registry and instructions within 11,500 o200k tokens', async () => {
    expect(PROVIDER_DEFAULT_MODELS.openrouter).toBe(OPENROUTER_PROMPT_BUDGET_MODEL);
    const desktopTools = buildDesktopAssistantTools({ provider: 'openrouter' } as RuntimeData);
    const runtime = await createMastraAgentRuntime({
      model: OPENROUTER_PROMPT_BUDGET_MODEL,
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
      const coreTools = await runtime.agent.getToolsForExecution({});
      const providerTools = Array.from(runtime.toolNameMap, ([name, originalName]) => {
        const tool = coreTools[name];
        if (!tool) {
          throw new Error(`Mastra omitted desktop tool ${originalName} (${name})`);
        }
        if (typeof tool.description !== 'string') {
          throw new TypeError(`Mastra tool ${name} lacks a description`);
        }
        const parameters = tool.parameters;
        if (!parameters || typeof parameters !== 'object' || !('jsonSchema' in parameters)) {
          throw new TypeError(`Mastra tool ${name} lacks provider JSON Schema`);
        }
        if (parameters.jsonSchema === undefined) {
          throw new TypeError(`Mastra tool ${name} has undefined provider JSON Schema`);
        }
        return {
          function: {
            description: tool.description,
            name,
            parameters: parameters.jsonSchema,
          },
          type: 'function' as const,
        };
      });

      expectProviderSurfaceWithinBudget({
        budget: MAX_MASTRA_OPENROUTER_NATIVE_TOOL_TOKENS,
        instructions: resolvedInstructions,
        label: 'Actual Mastra/OpenRouter native tool surface',
        tools: providerTools,
      });
    } finally {
      await runtime.dispose();
    }
  });
});
