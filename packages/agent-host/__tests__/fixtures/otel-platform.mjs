import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

export const OTEL_FIXTURE_MODEL_ID = 'otel-fixture-model';
export const OTEL_FIXTURE_TITLE = 'Traced fixture title';
export const OTEL_FIXTURE_TOOL_INPUT = 'written by permitted host tool';
export const OTEL_FIXTURE_TOOL_RESULT = 'traced fixture note body';

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/**
 * BST-2067: a host run that makes one policy-allowed tool call (no approval
 * pause), streams its answer, and titles its thread through the same model.
 * @returns {Promise<import('../../src/ports.js').HostPlatform>}
 */
export async function createHostPlatform() {
  const run = scriptedModel('read_note');
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ text: OTEL_FIXTURE_TITLE, type: 'text' }],
      finishReason: { raw: 'stop', unified: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: (options) => run.doStream(options),
    modelId: OTEL_FIXTURE_MODEL_ID,
    provider: 'otel-fixture',
  });
  return {
    async close() {},
    generatesThreadTitles: true,
    maxSteps: 3,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'allow' },
      yolo: false,
    }),
    async resolveModel(modelId) {
      if (modelId !== 'scripted') {
        throw new Error('Unknown fixture model');
      }
      return model;
    },
    tools: {
      read_note: {
        description: 'Read a note',
        async execute(input) {
          z.object({ text: z.literal(OTEL_FIXTURE_TOOL_INPUT) }).parse(input);
          return { note: OTEL_FIXTURE_TOOL_RESULT };
        },
        identity: 'otel-fixture-read-note-generation-1',
        inputSchema: z.object({ text: z.string() }),
        risk: 'read',
      },
    },
  };
}
