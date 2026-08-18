import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  BedrockMessageHygiene,
  buildBedrockMessageHygieneInputProcessor,
} from '../mastra/bedrock-message-hygiene';

type Prompt = ProcessLLMRequestArgs['prompt'];

function run(prompt: unknown): Prompt | undefined {
  const result = new BedrockMessageHygiene().processLLMRequest({
    prompt: prompt as Prompt,
  } as ProcessLLMRequestArgs);
  return result?.prompt;
}

describe('BedrockMessageHygiene', () => {
  it('drops empty text parts but keeps the rest of the message', () => {
    const prompt = run([
      {
        content: [
          { text: '', type: 'text' },
          { text: 'real content', type: 'text' },
        ],
        role: 'user',
      },
    ]);
    expect(prompt).toEqual([{ content: [{ text: 'real content', type: 'text' }], role: 'user' }]);
  });

  it('drops a message left with no content at all', () => {
    const prompt = run([
      { content: [{ text: '', type: 'text' }], role: 'assistant' },
      { content: [{ text: 'kept', type: 'text' }], role: 'user' },
    ]);
    expect(prompt).toEqual([{ content: [{ text: 'kept', type: 'text' }], role: 'user' }]);
  });

  it('drops an empty string-content message', () => {
    const prompt = run([
      { content: '', role: 'system' },
      { content: 'kept', role: 'system' },
    ]);
    expect(prompt).toEqual([{ content: 'kept', role: 'system' }]);
  });

  it('drops empty reasoning but keeps reasoning carrying a bedrock signature', () => {
    const prompt = run([
      {
        content: [
          { text: '   ', type: 'reasoning' },
          {
            providerOptions: { bedrock: { signature: 'sig-1' } },
            text: '',
            type: 'reasoning',
          },
          { text: 'actual thinking', type: 'reasoning' },
          { text: 'answer', type: 'text' },
        ],
        role: 'assistant',
      },
    ]);
    expect(prompt).toEqual([
      {
        content: [
          { providerOptions: { bedrock: { signature: 'sig-1' } }, text: '', type: 'reasoning' },
          { text: 'actual thinking', type: 'reasoning' },
          { text: 'answer', type: 'text' },
        ],
        role: 'assistant',
      },
    ]);
  });

  it('keeps empty reasoning carrying redactedData', () => {
    // Paired with a blank text part so a rewrite definitely happens — that way
    // the surviving reasoning part is observed, not inferred from a no-op.
    const prompt = run([
      {
        content: [
          { providerOptions: { bedrock: { redactedData: 'abc' } }, text: '', type: 'reasoning' },
          { text: '', type: 'text' },
        ],
        role: 'assistant',
      },
    ]);
    expect(prompt).toEqual([
      {
        content: [
          { providerOptions: { bedrock: { redactedData: 'abc' } }, text: '', type: 'reasoning' },
        ],
        role: 'assistant',
      },
    ]);
  });

  it('sanitizes tool-call ids and the matching tool results identically', () => {
    const prompt = run([
      {
        content: [
          { input: {}, toolCallId: 'call:abc.123', toolName: 'read', type: 'tool-call' },
          { input: {}, toolCallId: 'plain_id-1', toolName: 'read', type: 'tool-call' },
        ],
        role: 'assistant',
      },
      {
        content: [
          { output: {}, toolCallId: 'call:abc.123', toolName: 'read', type: 'tool-result' },
        ],
        role: 'tool',
      },
    ]);
    const assistant = prompt?.[0] as { content: { toolCallId: string }[] };
    const tool = prompt?.[1] as { content: { toolCallId: string }[] };
    expect(assistant.content[0]?.toolCallId).toBe('call_abc_123');
    // Already-valid ids must survive untouched, or every replay would churn.
    expect(assistant.content[1]?.toolCallId).toBe('plain_id-1');
    // The pair must stay joined: a call and its result rewritten differently
    // is an unmatched tool_use, which Bedrock rejects.
    expect(tool.content[0]?.toolCallId).toBe('call_abc_123');
  });

  it('never mutates the messages it was given (durable history stays intact)', () => {
    const original = {
      content: [
        { text: '', type: 'text' },
        { input: {}, toolCallId: 'call:1', toolName: 'read', type: 'tool-call' },
      ],
      role: 'assistant',
    };
    const snapshot = structuredClone(original);
    run([original]);
    expect(original).toEqual(snapshot);
  });

  it('returns undefined when nothing needed cleaning', () => {
    expect(
      run([
        { content: [{ text: 'hello', type: 'text' }], role: 'user' },
        {
          content: [{ input: {}, toolCallId: 'ok-1', toolName: 'read', type: 'tool-call' }],
          role: 'assistant',
        },
      ])
    ).toBeUndefined();
  });
});

describe('buildBedrockMessageHygieneInputProcessor', () => {
  it('is installed for bedrock only', () => {
    expect(buildBedrockMessageHygieneInputProcessor(' Bedrock ')?.id).toBe(
      'bedrock-message-hygiene'
    );
    expect(buildBedrockMessageHygieneInputProcessor('anthropic')).toBeUndefined();
    expect(buildBedrockMessageHygieneInputProcessor('openai')).toBeUndefined();
    expect(buildBedrockMessageHygieneInputProcessor('')).toBeUndefined();
  });
});
