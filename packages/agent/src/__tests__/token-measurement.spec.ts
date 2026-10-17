import type { TokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { HostToolDefinition } from '../host-tool-definition';
import { createProviderNativeWebSearchTool } from '../providers/native-web-search';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';
import {
  createPreparedTokenMeasurement,
  createRunTokenDiagnostics as createRunTokenDiagnosticsWithBudget,
  serializeModelOutputForTokenMeasurement,
} from '../token-measurement';
import { TOKEN_MEASUREMENT_FIXTURES } from './fixtures/token-measurement-fixtures';

const EXACT_O200K: TokenMeasurementCapability = {
  mode: 'exact-selected-model',
  tokenizer: 'o200k_base',
};

const ANCHOR_TOOL_RESULT_BUDGET = resolveScaledToolResultBudget(131_072);

function createRunTokenDiagnostics(
  params: Omit<
    Parameters<typeof createRunTokenDiagnosticsWithBudget>[0],
    'resolvedToolResultBudget'
  >,
  dependencies?: Parameters<typeof createRunTokenDiagnosticsWithBudget>[1]
): ReturnType<typeof createRunTokenDiagnosticsWithBudget> {
  return createRunTokenDiagnosticsWithBudget(
    { ...params, resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET },
    dependencies
  );
}

describe('prepared token measurement', () => {
  it.each(TOKEN_MEASUREMENT_FIXTURES)(
    'matches the verified o200k count for $name',
    async ({ o200kTokens, text }) => {
      const measurement = await createPreparedTokenMeasurement(EXACT_O200K);

      expect(measurement.measure(text)).toEqual({
        backstopTokens: Math.ceil(text.length / 4),
        serializedCharacters: text.length,
        status: 'measured',
        tokenCount: o200kTokens,
      });
    }
  );

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
    const tool = {
      description: `Look up ${secret}`,
      execute: async () => ({ secret }),
      id: 'lookup',
      inputSchema: z.object({ query: z.string().describe(secret) }),
    } satisfies HostToolDefinition;
    const diagnostics = await createRunTokenDiagnostics({
      capability: EXACT_O200K,
      tools: { lookup: tool },
    });

    diagnostics.recordModelOutput('lookup', {
      type: 'text',
      value: `projected ${secret}`,
    });
    const fields = diagnostics.toLogFields({ promptTokensSummedAcrossSteps: 321 });

    expect(fields).toMatchObject({
      measurementMode: 'exact-selected-model',
      measurementStatus: 'measured',
      modelVisibleProjectionCount: 1,
      promptTokensSummedAcrossSteps: 321,
      resolvedDomainBudgetTokens: 1500,
      resolvedTransportBudgetTokens: 3000,
      tokenizer: 'o200k_base',
      toolDefinitionCount: 1,
    });
    expect(fields['toolDefinitionTokens']).toBeGreaterThan(0);
    expect(fields['modelVisibleProjectionTokens']).toBeGreaterThan(0);
    expect(JSON.stringify(fields)).not.toContain(secret);
  });

  it('logs the resolved per-run tool-result budgets unconditionally', async () => {
    const diagnostics = await createRunTokenDiagnosticsWithBudget({
      capability: EXACT_O200K,
      resolvedToolResultBudget: resolveScaledToolResultBudget(200_000),
      tools: {},
    });

    expect(diagnostics.toLogFields()).toMatchObject({
      resolvedDomainBudgetTokens: 2289,
      resolvedTransportBudgetTokens: 4578,
    });
  });

  it('adds newly loaded tool definitions with the same aggregate measurement shape', async () => {
    const initialTool = {
      description: 'Initially visible tool.',
      execute: async () => ({}),
      id: 'initial_tool',
      inputSchema: z.object({ query: z.string() }),
    } satisfies HostToolDefinition;
    const deferredTool = {
      description: 'Deferred workspace tool with a distinct schema.',
      execute: async () => ({}),
      id: 'deferred_tool',
      inputSchema: z.object({ path: z.string(), startLine: z.number().optional() }),
    } satisfies HostToolDefinition;
    const diagnostics = await createRunTokenDiagnostics({
      capability: EXACT_O200K,
      tools: { initial_tool: initialTool },
    });
    const before = diagnostics.toLogFields();

    diagnostics.recordAdditionalToolDefinitions({ deferred_tool: deferredTool });
    diagnostics.recordAdditionalToolDefinitions({});
    const after = diagnostics.toLogFields();

    expect(after['toolDefinitionCount']).toBe(2);
    expect(after['toolDefinitionBackstopTokens']).toBeGreaterThan(
      Number(before['toolDefinitionBackstopTokens'])
    );
    expect(after['toolDefinitionSerializedCharacters']).toBeGreaterThan(
      Number(before['toolDefinitionSerializedCharacters'])
    );
    expect(after['toolDefinitionTokens']).toBeGreaterThan(Number(before['toolDefinitionTokens']));
    expect(diagnostics.toolDefinitionContextBreakdown()?.byTool).toHaveLength(1);
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
        candidatesTruncated: false,
        isPaginationFollowup: false,
        modelFacingChars: JSON.stringify({
          type: 'json',
          value: { omittedItems: 4, truncated: true },
        }).length,
        occurredAt: expect.any(Number),
        scanLimited: false,
        toolId: 'grepSearch',
        truncated: true,
      },
      {
        candidatesTruncated: false,
        isPaginationFollowup: false,
        modelFacingChars: JSON.stringify({
          type: 'text',
          value: 'private file contents',
        }).length,
        occurredAt: expect.any(Number),
        scanLimited: false,
        toolId: 'readWorkspaceFile',
        truncated: false,
      },
    ]);
    expect(JSON.stringify(telemetry)).not.toContain('private file contents');
  });

  it('recognizes the two truncation shapes that actually occur (budget-fit text, artifact-page next)', async () => {
    const diagnostics = await createRunTokenDiagnostics({ capability: EXACT_O200K, tools: {} });

    // Budget-fit path (trimCollectionToBudget): the domain record's
    // truncation marker survives JSON-stringified inside a text-typed wire
    // value — never a top-level `{type:'json'}` field.
    diagnostics.recordModelOutput('executeCommand', {
      type: 'text',
      value: JSON.stringify({ hint: 'narrow the request', omittedItems: 3, truncated: true }),
    });
    // Durable-artifact settlement page: json-typed, continuation signalled by
    // a `next` object, no `truncated` key at all.
    diagnostics.recordModelOutput('readWorkspaceFile', {
      type: 'json',
      value: { content: 'partial', next: { input: { cursor: 'c1' }, tool: 'readArtifact' } },
    });
    // A plain non-JSON text projection (e.g. grepSearch's compact format)
    // must not be misread as truncated just because it fails to parse.
    diagnostics.recordModelOutput('grepSearch', {
      type: 'text',
      value: 'Found 3 matches in 2 files',
    });

    const telemetry = diagnostics.toolCallTelemetry();
    expect(telemetry.map((sample) => [sample.toolId, sample.truncated])).toEqual([
      ['executeCommand', true],
      ['readWorkspaceFile', true],
      ['grepSearch', false],
    ]);
  });

  it('records subagent tool outputs as telemetry WITHOUT inflating the parent-run projection aggregate (BST-1196 review fix)', async () => {
    const diagnostics = await createRunTokenDiagnostics({ capability: EXACT_O200K, tools: {} });

    // A subagent/persona-delegated tool call: must land in per-tool
    // telemetry, but must NOT feed `modelVisibleProjection*` — that
    // aggregate reconciles against `promptTokensSummedAcrossSteps`, i.e. what
    // the PARENT model actually saw in its OWN prompt, which a child tool
    // output never enters.
    diagnostics.recordSubagentToolOutput('brainstrike.grepSearch', {
      type: 'text',
      value: 'child tool result',
    });

    const telemetryAfterSubagentOnly = diagnostics.toolCallTelemetry();
    expect(telemetryAfterSubagentOnly).toHaveLength(1);
    expect(telemetryAfterSubagentOnly[0]).toMatchObject({
      toolId: 'brainstrike.grepSearch',
    });

    const fieldsAfterSubagentOnly = diagnostics.toLogFields();
    expect(fieldsAfterSubagentOnly['modelVisibleProjectionCount']).toBe(0);
    expect(fieldsAfterSubagentOnly['modelVisibleProjectionTokens']).toBe(0);

    // A subsequent PRIMARY tool call still accumulates into the projection
    // aggregate as before — the split is additive, not a regression of the
    // primary path.
    diagnostics.recordModelOutput('grepSearch', {
      type: 'text',
      value: 'parent tool result',
    });

    const telemetryAfterBoth = diagnostics.toolCallTelemetry();
    expect(telemetryAfterBoth).toHaveLength(2);
    expect(telemetryAfterBoth.map((sample) => sample.toolId)).toEqual([
      'brainstrike.grepSearch',
      'grepSearch',
    ]);

    const fieldsAfterBoth = diagnostics.toLogFields();
    expect(fieldsAfterBoth['modelVisibleProjectionCount']).toBe(1);
    expect(fieldsAfterBoth['modelVisibleProjectionTokens']).toBeGreaterThan(0);
  });

  it.each(['anthropic', 'openai'])(
    'measures the provider-native definition for the %s web-search tool',
    async (provider) => {
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
      expect(fields['toolDefinitionTokens']).toBeGreaterThan(0);
    }
  );

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

  it('compacts SDK7 inline file bytes while retaining inline text, URLs and references', () => {
    const output = [
      { data: { data: 'inline-image-bytes', type: 'data' }, mediaType: 'image/png', type: 'file' },
      {
        data: { type: 'url', url: new URL('data:image/png;base64,inline-data-url') },
        mediaType: 'image/png',
        type: 'file',
      },
      {
        data: { text: 'important inline document', type: 'text' },
        mediaType: 'text/plain',
        type: 'file',
      },
      {
        data: { type: 'url', url: new URL('https://example.test/image.png') },
        mediaType: 'image/png',
        type: 'file',
      },
      {
        data: { reference: { openai: 'file_reference' }, type: 'reference' },
        mediaType: 'image/png',
        type: 'file',
      },
    ];
    const serialized = serializeModelOutputForTokenMeasurement(output);
    expect(serialized).not.toContain('inline-image-bytes');
    expect(serialized).not.toContain('inline-data-url');
    expect(serialized).toContain('important inline document');
    expect(serialized).toContain('https://example.test/image.png');
    expect(serialized).toContain('file_reference');
    expect(output[0]?.data).toEqual({ data: 'inline-image-bytes', type: 'data' });
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
        candidatesTruncated: false,
        isPaginationFollowup: false,
        modelFacingChars: JSON.stringify(output).length,
        occurredAt: expect.any(Number),
        scanLimited: false,
        toolId: 'imageTool',
        truncated: false,
      },
    ]);
  });

  it('keeps the shipped token measurement intact when the telemetry-only stringify throws', async () => {
    const diagnostics = await createRunTokenDiagnostics({ capability: EXACT_O200K, tools: {} });
    const output = { type: 'text', value: 'ok' };
    // `serializeModelOutputForTokenMeasurement` stringifies `compactMedia(output)`
    // — a DIFFERENT object reference — while the telemetry char count
    // stringifies `output` directly. Throwing only on the exact `output`
    // reference reproduces "raw stringify fails (e.g. RangeError: Invalid
    // string length on huge base64), masked stringify succeeds" without
    // constructing a real oversized payload.
    const realStringify = JSON.stringify.bind(JSON);
    const stringifySpy = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, replacer?: unknown, space?: unknown) => {
        if (value === output) {
          throw new RangeError('Invalid string length');
        }
        return realStringify(value, replacer as never, space as never);
      });

    try {
      diagnostics.recordModelOutput('lookup', output);
    } finally {
      stringifySpy.mockRestore();
    }

    // The telemetry sample is simply omitted...
    expect(diagnostics.toolCallTelemetry()).toEqual([]);
    // ...but the pre-existing, already-shipped token measurement still ran
    // (best-effort telemetry failure must not degrade it — review fix).
    const fields = diagnostics.toLogFields();
    expect(fields['measurementStatus']).toBe('measured');
    expect(fields['modelVisibleProjectionCount']).toBe(1);
    expect(fields['modelVisibleProjectionTokens']).toBeGreaterThan(0);
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
    const small = {
      description: 'Tiny helper.',
      execute: async () => ({}),
      id: 'small_tool',
      inputSchema: z.object({ a: z.string() }),
    } satisfies HostToolDefinition;
    const big = {
      description: `Large tool. ${'schema detail '.repeat(50)}`,
      execute: async () => ({}),
      id: 'big_tool',
      inputSchema: z.object({
        alpha: z.string().describe('first field with a long description'),
        beta: z.number().describe('second field with a long description'),
        gamma: z.boolean().describe('third field with a long description'),
      }),
    } satisfies HostToolDefinition;
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
    const tool = {
      description: 'Backstop-counted tool.',
      execute: async () => ({}),
      id: 'plain_tool',
      inputSchema: z.object({ q: z.string() }),
    } satisfies HostToolDefinition;
    const diagnostics = await createRunTokenDiagnostics({
      capability: { charactersPerToken: 4, mode: 'deterministic-serialized-character-backstop' },
      tools: { plain_tool: tool },
    });
    const breakdown = diagnostics.toolDefinitionContextBreakdown();
    expect(breakdown?.provenance).toBe('heuristic');
    expect(breakdown?.byTool).toHaveLength(1);
  });

  it('returns undefined from the per-tool breakdown when measurement failed (never zero-faked)', async () => {
    const tool = {
      description: 'Unmeasurable under a broken counter.',
      execute: async () => ({}),
      id: 'any_tool',
      inputSchema: z.object({}),
    } satisfies HostToolDefinition;
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
