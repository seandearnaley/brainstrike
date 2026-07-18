import type { ToolsInput } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';

import { applyToolModelOutputProjections } from '../mastra/tool-model-output';

type TestTool = ToolsInput[string] & {
  execute?: (...args: unknown[]) => unknown;
  toModelOutput?: (output: unknown) => unknown;
};

function asTool(value: Record<string, unknown>): TestTool {
  return value as unknown as TestTool;
}

describe('applyToolModelOutputProjections', () => {
  it('keeps raw execution untouched and gives the model a bounded text projection', async () => {
    const rawOnlyTail = 'raw-only-tail';
    const rawOutput = {
      content: `${'x'.repeat(20_000)}${rawOnlyTail}`,
      path: '/large-output.txt',
    };
    const execute = vi.fn(() => Promise.resolve(rawOutput));
    const tool = asTool({ execute, id: 'read_file' });

    const projected = applyToolModelOutputProjections(
      { read_file: tool },
      new Map([['read_file', 'filesystem.read_file']])
    );
    const projectedTool = projected['read_file'] as TestTool;

    await expect(projectedTool.execute?.()).resolves.toBe(rawOutput);
    const modelOutput = projectedTool.toModelOutput?.(rawOutput) as
      | { type?: string; value?: string }
      | undefined;
    expect(modelOutput?.type).toBe('text');
    expect(modelOutput?.value).toContain('output was truncated');
    expect(modelOutput?.value).not.toContain(rawOnlyTail);
    expect(modelOutput?.value?.length).toBeLessThanOrEqual(12_000);
  });

  it('preserves an existing domain-specific projection unchanged', () => {
    const toModelOutput = vi.fn((output: unknown) => ({ type: 'text', value: String(output) }));
    const tool = asTool({
      execute: () => 'raw',
      id: 'custom',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { custom: tool },
      new Map([['custom', 'custom']])
    );

    expect(projected['custom']).not.toBe(tool);
    expect((projected['custom'] as TestTool).toModelOutput?.('result')).toEqual({
      type: 'text',
      value: 'result',
    });
    expect(toModelOutput).toHaveBeenCalledOnce();
  });

  it('bounds an oversized existing domain-specific text projection', () => {
    const rawOnlyTail = 'custom-raw-only-tail';
    const toModelOutput = vi.fn(() => ({
      type: 'text',
      value: `${'x'.repeat(20_000)}${rawOnlyTail}`,
    }));
    const tool = asTool({
      execute: () => 'raw',
      id: 'custom',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { custom: tool },
      new Map([['custom', 'custom']])
    );
    const modelOutput = (projected['custom'] as TestTool).toModelOutput?.('result') as {
      type?: string;
      value?: string;
    };

    expect(modelOutput.type).toBe('text');
    expect(modelOutput.value).toContain('output was truncated');
    expect(modelOutput.value).not.toContain(rawOnlyTail);
    expect(modelOutput.value?.length).toBeLessThanOrEqual(8000);
  });

  it('preserves MCP image and audio data while bounding model-facing text', () => {
    const rawOutput = {
      content: [
        { text: `${'x'.repeat(20_000)}text-only-tail`, type: 'text' },
        { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
        { data: 'UklGRg==', mimeType: 'audio/wav', type: 'audio' },
      ],
      hookAdditionalContext: 'Inspect the media provenance before continuing.',
    };
    const tool = asTool({ execute: () => rawOutput, id: 'multimodal' });

    const projected = applyToolModelOutputProjections(
      { multimodal: tool },
      new Map([['multimodal', 'remote.multimodal']])
    );
    const modelOutput = (projected['multimodal'] as TestTool).toModelOutput?.(rawOutput) as {
      type?: string;
      value?: Record<string, unknown>[];
    };

    expect(modelOutput.type).toBe('content');
    expect(modelOutput.value).toContainEqual({
      data: 'aGVsbG8=',
      mediaType: 'image/png',
      type: 'image-data',
    });
    expect(modelOutput.value).toContainEqual({
      data: 'UklGRg==',
      mediaType: 'audio/wav',
      type: 'file-data',
    });
    const text = modelOutput.value?.find((part) => part['type'] === 'text')?.['text'];
    expect(text).toContain('output was truncated');
    expect(text).toContain('Inspect the media provenance before continuing.');
    expect(text).not.toContain('text-only-tail');
  });

  it('fails loudly for a malformed declared projection', () => {
    const malformed = asTool({
      execute: () => 'raw',
      id: 'malformed',
      toModelOutput: 'not-callable',
    });

    expect(() =>
      applyToolModelOutputProjections({ malformed }, new Map([['malformed', 'malformed']]))
    ).toThrow('malformed declares a non-callable toModelOutput');
  });
});
