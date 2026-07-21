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

    diagnostics.recordModelOutput({
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
    diagnostics.recordModelOutput({ type: 'text', value: 'safe projection' });

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
});
