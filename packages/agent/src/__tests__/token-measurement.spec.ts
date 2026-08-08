import type { TokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createPreparedTokenMeasurement,
  createRunTokenDiagnostics,
  serializeModelOutputForTokenMeasurement,
} from '../mastra/token-measurement';
import { createProviderNativeWebSearchTool } from '../providers/native-web-search';
import { TOKEN_MEASUREMENT_FIXTURES } from './fixtures/token-measurement-fixtures';

const EXACT_O200K: TokenMeasurementCapability = {
  mode: 'exact-selected-model',
  tokenizer: 'o200k_base',
};

describe('prepared token measurement', () => {
  it.each(TOKEN_MEASUREMENT_FIXTURES)('matches the verified o200k count for $name', async ({
    o200kTokens,
    text,
  }) => {
    const measurement = await createPreparedTokenMeasurement(EXACT_O200K);

    expect(measurement.measure(text)).toEqual({
      backstopTokens: Math.ceil(text.length / 4),
      serializedCharacters: text.length,
      status: 'measured',
      tokenCount: o200kTokens,
    });
  });

  it('labels a deterministic backstop without claiming exactness', async () => {
    const measurement = await createPreparedTokenMeasurement({
      charactersPerToken: 4,
      mode: 'deterministic-serialized-character-backstop',
    });

    expect(measurement.capability.mode).toBe('deterministic-serialized-character-backstop');
    expect(measurement.measure('工具🧠')).toEqual({
      backstopTokens: 1,
      serializedCharacters: 4,
      status: 'measured',
      tokenCount: 1,
    });
  });

  it('surfaces counter initialization failure under the declared mode', async () => {
    const measurement = await createPreparedTokenMeasurement(EXACT_O200K, {
      loadCounter: async () => {
        throw new Error('fixture initialization failed');
      },
    });

    expect(measurement.measure('bounded input')).toEqual({
      backstopTokens: 4,
      failureCode: 'counter-initialization-failed',
      failureMessage: 'fixture initialization failed',
      serializedCharacters: 13,
      status: 'failed',
    });
    expect(measurement.capability).toEqual(EXACT_O200K);
  });

  it('surfaces counter execution failure instead of changing modes', async () => {
    const measurement = await createPreparedTokenMeasurement(EXACT_O200K, {
      loadCounter: async () => () => {
        throw new Error('fixture encode failed');
      },
    });

    expect(measurement.measure('bounded input')).toMatchObject({
      failureCode: 'counter-execution-failed',
      failureMessage: 'fixture encode failed',
      status: 'failed',
    });
    expect(measurement.capability).toEqual(EXACT_O200K);
  });
});

describe('run token diagnostics', () => {
  it('records bounded counts without retaining tool schemas or projected content', async () => {
    const secret = 'sk-test-never-log-this';
    const tool = createTool({
      description: `Look up ${secret}`,
      execute: async () => ({ secret }),
      id: 'lookup',
      inputSchema: z.object({ query: z.string().describe(secret) }),
    });
    const diagnostics = await createRunTokenDiagnostics({
      capability: EXACT_O200K,
      tools: { lookup: tool },
    });

    diagnostics.recordModelOutput('lookup', {
      type: 'text',
      value: `projected ${secret}`,
    });
    const fields = diagnostics.toLogFields({ providerReportedPromptTokens: 321 });

    expect(fields).toMatchObject({
      measurementMode: 'exact-selected-model',
      measurementStatus: 'measured',
      modelVisibleProjectionCount: 1,
      providerReportedPromptTokens: 321,
      tokenizer: 'o200k_base',
      toolDefinitionCount: 1,
    });
    expect(fields.toolDefinitionTokens).toBeGreaterThan(0);
    expect(fields.modelVisibleProjectionTokens).toBeGreaterThan(0);
    expect(JSON.stringify(fields)).not.toContain(secret);
  });

  it('records privacy-safe per-tool model-facing characters and generic truncation', async () => {
    const diagnostics = await createRunTokenDiagnostics({ capability: EXACT_O200K, tools: {} });

    diagnostics.recordModelOutput('grepSearch', {
      type: 'json',
      value: { omittedItems: 4, truncated: true },
    });
    diagnostics.recordModelOutput('readWorkspaceFile', {
      type: 'text',
      value: 'private file contents',
    });

    const telemetry = diagnostics.toolCallTelemetry();
    expect(telemetry).toEqual([
      {
        isPaginationFollowup: false,
        modelFacingChars: JSON.stringify({
          type: 'json',
          value: { omittedItems: 4, truncated: true },
        }).length,
        toolId: 'grepSearch',
        truncated: true,
      },
      {
        isPaginationFollowup: false,
        modelFacingChars: JSON.stringify({
          type: 'text',
          value: 'private file contents',
        }).length,
        toolId: 'readWorkspaceFile',
        truncated: false,
      },
    ]);
    expect(JSON.stringify(telemetry)).not.toContain('private file contents');
  });

  it.each([
    'anthropic',
    'openai',
  ])('measures the provider-native definition for the %s web-search tool', async (provider) => {
    const nativeTool = createProviderNativeWebSearchTool(provider, undefined);
    expect(nativeTool).toBeDefined();

    const diagnostics = await createRunTokenDiagnostics({
      capability: EXACT_O200K,
      tools: { web_search: nativeTool! },
    });
    const fields = diagnostics.toLogFields();

    expect(fields).toMatchObject({
      measurementStatus: 'measured',
      toolDefinitionCount: 1,
    });
    expect(fields.toolDefinitionTokens).toBeGreaterThan(0);
  });

  it('compacts inline media to a deterministic marker before counting', () => {
    const serialized = serializeModelOutputForTokenMeasurement({
      type: 'content',
      value: [
        { text: 'Summary', type: 'text' },
        { data: 'secret-base64-payload', mediaType: 'image/png', type: 'image-data' },
      ],
    });

    expect(serialized).toContain(
      '[image-data payload omitted from token count; media type: image/png]'
    );
    expect(serialized).not.toContain('secret-base64-payload');
  });

  it('counts actual serialized media characters for telemetry even though token counting masks them', async () => {
    const diagnostics = await createRunTokenDiagnostics({ capability: EXACT_O200K, tools: {} });
    const output = {
      type: 'content',
      value: [{ data: 'actual-base64-payload', mediaType: 'image/png', type: 'image-data' }],
    };

    diagnostics.recordModelOutput('imageTool', output);

    expect(diagnostics.toolCallTelemetry()).toEqual([
      {
        isPaginationFollowup: false,
        modelFacingChars: JSON.stringify(output).length,
        toolId: 'imageTool',
        truncated: false,
      },
    ]);
  });

  it('keeps deterministic backstop totals when the optional counter fails', async () => {
    const diagnostics = await createRunTokenDiagnostics(
      {
        capability: EXACT_O200K,
        tools: {},
      },
      {
        loadCounter: async () => {
          throw new Error('counter unavailable with secret-model-output');
        },
      }
    );
    diagnostics.recordModelOutput('lookup', { type: 'text', value: 'safe projection' });

    const logFields = diagnostics.toLogFields();
    expect(logFields).toMatchObject({
      measurementFailureCode: 'counter-initialization-failed',
      measurementMode: 'exact-selected-model',
      measurementStatus: 'failed',
      modelVisibleProjectionBackstopTokens: 11,
      modelVisibleProjectionCount: 1,
      toolDefinitionBackstopTokens: 1,
      toolDefinitionCount: 0,
    });
    expect(logFields).not.toHaveProperty('modelVisibleProjectionTokens');
    expect(logFields).not.toHaveProperty('toolDefinitionTokens');
    expect(JSON.stringify(logFields)).not.toContain('secret-model-output');
  });

  it('exposes a per-tool definition breakdown for the context popover (BST-940)', async () => {
    const small = createTool({
      description: 'Tiny helper.',
      execute: async () => ({}),
      id: 'small_tool',
      inputSchema: z.object({ a: z.string() }),
    });
    const big = createTool({
      description: `Large tool. ${'schema detail '.repeat(50)}`,
      execute: async () => ({}),
      id: 'big_tool',
      inputSchema: z.object({
        alpha: z.string().describe('first field with a long description'),
        beta: z.number().describe('second field with a long description'),
        gamma: z.boolean().describe('third field with a long description'),
      }),
    });
    const diagnostics = await createRunTokenDiagnostics({
      capability: EXACT_O200K,
      tools: { big_tool: big, small_tool: small },
    });

    const breakdown = diagnostics.toolDefinitionContextBreakdown();
    expect(breakdown).toBeDefined();
    if (!breakdown) {
      throw new Error('expected a tool definition breakdown');
    }
    expect(breakdown.provenance).toBe('measured');
    expect(breakdown.byTool.map((entry) => entry.name)).toEqual(['big_tool', 'small_tool']);
    const bigEntry = breakdown.byTool[0];
    const smallEntry = breakdown.byTool[1];
    expect(bigEntry?.tokens ?? 0).toBeGreaterThan(smallEntry?.tokens ?? 0);
    expect(breakdown.totalTokens).toBe(
      breakdown.byTool.reduce((sum, entry) => sum + entry.tokens, 0)
    );
  });

  it('reports the backstop provenance as heuristic in the per-tool breakdown', async () => {
    const tool = createTool({
      description: 'Backstop-counted tool.',
      execute: async () => ({}),
      id: 'plain_tool',
      inputSchema: z.object({ q: z.string() }),
    });
    const diagnostics = await createRunTokenDiagnostics({
      capability: { charactersPerToken: 4, mode: 'deterministic-serialized-character-backstop' },
      tools: { plain_tool: tool },
    });
    const breakdown = diagnostics.toolDefinitionContextBreakdown();
    expect(breakdown?.provenance).toBe('heuristic');
    expect(breakdown?.byTool).toHaveLength(1);
  });

  it('returns undefined from the per-tool breakdown when measurement failed (never zero-faked)', async () => {
    const tool = createTool({
      description: 'Unmeasurable under a broken counter.',
      execute: async () => ({}),
      id: 'any_tool',
      inputSchema: z.object({}),
    });
    const diagnostics = await createRunTokenDiagnostics(
      { capability: EXACT_O200K, tools: { any_tool: tool } },
      {
        loadCounter: async () => {
          throw new Error('counter unavailable');
        },
      }
    );
    expect(diagnostics.toolDefinitionContextBreakdown()).toBeUndefined();
  });
});
