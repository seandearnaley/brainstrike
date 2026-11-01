import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { prepareProviderRequest } from '../provider-request';
import { createPreparedTokenMeasurement } from '../token-measurement';

const user = (text: string): LanguageModelV4Prompt[number] => ({
  content: [{ text, type: 'text' }],
  role: 'user',
});
const model = (provider: string): LanguageModelV4 => ({
  doGenerate: () => {
    throw new Error('No provider calls allowed.');
  },
  doStream: () => {
    throw new Error('No provider calls allowed.');
  },
  modelId: 'fixture-model',
  provider,
  specificationVersion: 'v4',
  supportedUrls: {},
});
const measurement = await createPreparedTokenMeasurement({
  charactersPerToken: 4,
  mode: 'deterministic-serialized-character-backstop',
});

describe('cross-provider history replay', () => {
  it.each([
    ['anthropic', 'anthropic.messages', 'claude-sonnet-5'],
    ['openrouter', 'openrouter', 'anthropic/claude-sonnet-5'],
  ] as const)(
    'replays foreign history to %s with valid tool ids, its own thinking only, and every input',
    async (provider, sdkProvider, modelId) => {
      const prompt: LanguageModelV4Prompt = [
        user('read it'),
        {
          content: [
            {
              providerOptions: { openai: { itemId: 'rs_foreign' } },
              text: 'gpt',
              type: 'reasoning',
            },
            {
              input: undefined,
              toolCallId: 'functions.read:0',
              toolName: 'read',
              type: 'tool-call',
            },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              output: { type: 'text', value: 'file' },
              toolCallId: 'functions.read:0',
              toolName: 'read',
              type: 'tool-result',
            },
          ],
          role: 'tool',
        },
        user('continue'),
      ];
      const before = JSON.stringify(prompt);
      const prepared = await prepareProviderRequest(
        { prompt },
        { ...model(sdkProvider), modelId },
        { provider, tokenMeasurement: measurement }
      );
      expect(prepared.params.prompt).toEqual([
        prompt[0],
        {
          content: [
            { input: {}, toolCallId: 'functions_read_0', toolName: 'read', type: 'tool-call' },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              output: { type: 'text', value: 'file' },
              toolCallId: 'functions_read_0',
              toolName: 'read',
              type: 'tool-result',
            },
          ],
          role: 'tool',
        },
        prompt[3],
      ]);
      expect(JSON.stringify(prompt)).toBe(before);
    }
  );

  it('keeps OpenRouter Claude its own reasoning in past and continued turns, dropping only foreign reasoning', async () => {
    const own = (text: string) =>
      ({
        providerOptions: {
          openrouter: {
            reasoning_details: [{ signature: `sig-${text}`, text, type: 'reasoning.text' }],
          },
        },
        text,
        type: 'reasoning',
      }) as const;
    const prompt: LanguageModelV4Prompt = [
      user('first'),
      {
        content: [
          own('past thinking'),
          { providerOptions: { openai: { itemId: 'rs_foreign' } }, text: 'gpt', type: 'reasoning' },
          { text: 'past answer', type: 'text' },
        ],
        role: 'assistant',
      },
      user('read it'),
      {
        content: [
          own('continued thinking'),
          {
            input: { path: 'a.md' },
            toolCallId: 'toolu_read',
            toolName: 'read',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'text', value: 'file' },
            toolCallId: 'toolu_read',
            toolName: 'read',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
    ];
    const prepared = await prepareProviderRequest(
      { prompt },
      { ...model('openrouter'), modelId: 'anthropic/claude-sonnet-5' },
      { provider: 'openrouter', tokenMeasurement: measurement }
    );
    expect(prepared.params.prompt).toEqual([
      prompt[0],
      {
        content: [own('past thinking'), { text: 'past answer', type: 'text' }],
        role: 'assistant',
      },
      prompt[2],
      prompt[3],
      prompt[4],
    ]);
  });
});
