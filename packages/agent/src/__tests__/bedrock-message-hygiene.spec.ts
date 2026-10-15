import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  BedrockMessageHygiene,
  buildBedrockMessageHygieneInputProcessor,
} from '../mastra-processors/bedrock-message-hygiene';

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

  it('drops a WHITESPACE-ONLY text part, matching the reasoning check', () => {
    // Converse rejects a blank text block, and "blank" there means no visible
    // content — a part of three spaces is exactly as empty as `''`.
    const prompt = run([
      {
        content: [
          { text: '   ', type: 'text' },
          { text: 'real content', type: 'text' },
        ],
        role: 'user',
      },
    ]);
    expect(prompt).toEqual([{ content: [{ text: 'real content', type: 'text' }], role: 'user' }]);
  });

  it('drops a user message whose only text part is whitespace', () => {
    const prompt = run([
      { content: [{ text: '\n\t ', type: 'text' }], role: 'user' },
      { content: [{ text: 'kept', type: 'text' }], role: 'assistant' },
    ]);
    expect(prompt).toEqual([{ content: [{ text: 'kept', type: 'text' }], role: 'assistant' }]);
  });

  it('drops a whitespace-only string-content message', () => {
    const prompt = run([
      { content: '   ', role: 'system' },
      { content: 'kept', role: 'system' },
    ]);
    expect(prompt).toEqual([{ content: 'kept', role: 'system' }]);
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

  it('keeps sanitized tool-call ids INJECTIVE when two originals collide', () => {
    // `call:1` and `call.1` both sanitize to `call_1`. Collapsing them would
    // merge two distinct tool invocations into one id — Bedrock would see a
    // duplicate tool_use and the results would bind to the wrong call.
    const prompt = run([
      {
        content: [
          { input: {}, toolCallId: 'call:1', toolName: 'read', type: 'tool-call' },
          { input: {}, toolCallId: 'call.1', toolName: 'read', type: 'tool-call' },
        ],
        role: 'assistant',
      },
      {
        content: [
          { output: {}, toolCallId: 'call.1', toolName: 'read', type: 'tool-result' },
          { output: {}, toolCallId: 'call:1', toolName: 'read', type: 'tool-result' },
        ],
        role: 'tool',
      },
    ]);
    const assistant = prompt?.[0] as { content: { toolCallId: string }[] };
    const tool = prompt?.[1] as { content: { toolCallId: string }[] };
    const first = assistant.content[0]?.toolCallId;
    const second = assistant.content[1]?.toolCallId;
    expect(first).toBe('call_1');
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[a-zA-Z0-9_-]+$/);
    // Results still bind to their own call, in whichever order they appear.
    expect(tool.content[0]?.toolCallId).toBe(second);
    expect(tool.content[1]?.toolCallId).toBe(first);
  });

  it('clamps a sanitized id to the Converse 64-character limit', () => {
    const longId = `call:${'x'.repeat(200)}`;
    const prompt = run([
      {
        content: [{ input: {}, toolCallId: longId, toolName: 'read', type: 'tool-call' }],
        role: 'assistant',
      },
    ]);
    const assistant = prompt?.[0] as { content: { toolCallId: string }[] };
    const id = assistant.content[0]?.toolCallId ?? '';
    expect(id.length).toBe(64);
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('keeps clamped ids injective when two long originals share a prefix', () => {
    const base = 'call:'.concat('y'.repeat(200));
    const prompt = run([
      {
        content: [
          { input: {}, toolCallId: `${base}A`, toolName: 'read', type: 'tool-call' },
          { input: {}, toolCallId: `${base}B`, toolName: 'read', type: 'tool-call' },
        ],
        role: 'assistant',
      },
    ]);
    const assistant = prompt?.[0] as { content: { toolCallId: string }[] };
    const first = assistant.content[0]?.toolCallId ?? '';
    const second = assistant.content[1]?.toolCallId ?? '';
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
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
