import type { MastraDBMessage } from '@mastra/core/memory';
import { describe, expect, it } from 'vitest';
import { createHookResultEnvelope } from '../../tools/hook-runner';
import { projectMessageContentForTranscript } from '../transcript-projection';

const citation = '\u{E200}cite\u{E202}turn0search0\u{E201}';

describe('projectMessageContentForTranscript', () => {
  it('returns unsupported and already-clean content by identity', () => {
    const legacy = { content: 'legacy' } as MastraDBMessage['content'];
    const clean = {
      content: 'clean',
      format: 2,
      parts: [{ text: 'clean', type: 'text' }],
    } as MastraDBMessage['content'];

    expect(projectMessageContentForTranscript(legacy, 'assistant')).toBe(legacy);
    expect(projectMessageContentForTranscript(clean, 'assistant')).toBe(clean);
  });

  it('strips settled assistant citations from text parts and the flattened fallback only', () => {
    const content = {
      content: `Answer${citation}`,
      format: 2,
      parts: [
        { text: `Answer${citation}`, type: 'text' },
        { reasoning: `Reasoning${citation}`, type: 'reasoning' },
      ],
    } as MastraDBMessage['content'];

    expect(projectMessageContentForTranscript(content, 'assistant')).toEqual({
      content: 'Answer',
      format: 2,
      parts: [
        { text: 'Answer', type: 'text' },
        { reasoning: `Reasoning${citation}`, type: 'reasoning' },
      ],
    });
    expect(projectMessageContentForTranscript(content, 'user')).toBe(content);
  });

  it('unwraps trusted result transforms in both the part and invocation mirror', () => {
    const args = createHookResultEnvelope({ query: 'visible input' }, 'hidden input context');
    const result = createHookResultEnvelope({ value: 42 }, 'hidden output context');
    const content = {
      format: 2,
      parts: [
        {
          toolInvocation: {
            args,
            result,
            state: 'result',
            toolCallId: 'call-1',
            toolName: 'test-tool',
          },
          type: 'tool-invocation',
        },
      ],
      toolInvocations: [
        {
          args,
          result,
          state: 'result',
          toolCallId: 'call-1',
          toolName: 'test-tool',
        },
      ],
    } as MastraDBMessage['content'];

    const projected = projectMessageContentForTranscript(content, 'assistant');

    expect(projected).toMatchObject({
      parts: [
        {
          toolInvocation: {
            args: { query: 'visible input' },
            result: { value: 42 },
          },
        },
      ],
      toolInvocations: [
        {
          args: { query: 'visible input' },
          result: { value: 42 },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain('hidden');
    expect(content).toMatchObject({
      parts: [{ toolInvocation: { args, result } }],
    });
  });

  it('projects error payloads without fabricating a result field', () => {
    const errorText = createHookResultEnvelope('visible failure', 'hidden error context');
    const content = {
      format: 2,
      parts: [
        {
          toolInvocation: {
            args: { path: 'file.ts' },
            errorText,
            state: 'output-error',
            toolCallId: 'call-error',
            toolName: 'test-tool',
          },
          type: 'tool-invocation',
        },
      ],
    } as MastraDBMessage['content'];

    const projected = projectMessageContentForTranscript(content, 'assistant') as {
      parts: Array<{ toolInvocation: Record<string, unknown> }>;
    };

    expect(projected.parts[0]?.toolInvocation).toMatchObject({
      errorText: 'visible failure',
      state: 'output-error',
    });
    expect(projected.parts[0]?.toolInvocation).not.toHaveProperty('result');
    expect(JSON.stringify(projected)).not.toContain('hidden error context');
  });
});
