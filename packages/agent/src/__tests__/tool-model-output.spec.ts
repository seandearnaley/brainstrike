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

    expect(projected['custom']).toBe(tool);
    expect((projected['custom'] as TestTool).toModelOutput?.('result')).toEqual({
      type: 'text',
      value: 'result',
    });
    expect(toModelOutput).toHaveBeenCalledOnce();
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
