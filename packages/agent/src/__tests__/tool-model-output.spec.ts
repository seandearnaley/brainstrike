import type { ToolsInput } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';

import { applyToolModelOutputProjections } from '../mastra/tool-model-output';
import { HOOK_RESULT_ENVELOPE_FIELD } from '../tools/hook-runner';
import { applyToolHooks } from '../tools/hook-tool-wrap';

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

  it('passes the raw result from a Mastra envelope to an existing projection', () => {
    const rawOutput = { summary: 'compact result' };
    const toModelOutput = vi.fn((output: unknown) => ({
      type: 'text',
      value: (output as { summary?: string }).summary,
    }));
    const tool = asTool({
      execute: () => rawOutput,
      id: 'custom-envelope',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { custom_envelope: tool },
      new Map([['custom_envelope', 'custom.envelope']])
    );
    const modelOutput = (projected['custom_envelope'] as TestTool).toModelOutput?.({
      input: { query: 'summary' },
      output: rawOutput,
      toolCallId: 'call-custom-envelope',
    });

    expect(modelOutput).toEqual({ type: 'text', value: 'compact result' });
    expect(toModelOutput).toHaveBeenCalledWith(rawOutput);
  });

  it.each([
    ['tool_failed', 'The tool did not complete successfully.'],
    ['tool_blocked_by_hook', 'Blocked by workspace policy.'],
  ] as const)('bypasses a domain projector for a guarded %s result', (code, message) => {
    const guardedError = {
      error: { code, message, toolName: 'custom.guarded' },
      ok: false,
    };
    const toModelOutput = vi.fn(() => {
      throw new Error('domain projector must not receive guarded failures');
    });
    const tool = asTool({
      execute: () => guardedError,
      id: 'custom-guarded',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { custom_guarded: tool },
      new Map([['custom_guarded', 'custom.guarded']])
    );
    const modelOutput = (projected['custom_guarded'] as TestTool).toModelOutput?.(guardedError) as {
      type?: string;
      value?: string;
    };

    expect(toModelOutput).not.toHaveBeenCalled();
    expect(modelOutput.type).toBe('text');
    expect(modelOutput.value).toContain(code);
    expect(modelOutput.value).toContain(message);
  });

  it('centrally composes post-tool context after a domain projection', async () => {
    const domainOutput = { summary: 'compact result' };
    const toModelOutput = vi.fn((output: unknown) => ({
      type: 'text',
      value: (output as { summary?: string }).summary,
    }));
    const tool = asTool({
      execute: () => domainOutput,
      id: 'custom-hook-context',
      toModelOutput,
    });
    const toolNameMap = new Map([['custom_hook_context', 'custom.hook-context']]);
    const hooked = applyToolHooks(
      { custom_hook_context: tool },
      {
        hookRunner: {
          postToolUse: () =>
            Promise.resolve({
              additionalContext: 'Inspect the related package before continuing.',
            }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['custom_hook_context'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = projectedTool.toModelOutput?.(rawOutput) as {
      type?: string;
      value?: string;
    };

    expect(toModelOutput).toHaveBeenCalledWith(domainOutput);
    expect(modelOutput).toEqual({
      type: 'text',
      value: 'compact result\nPost-tool context: Inspect the related package before continuing.',
    });
  });

  it('does not reinterpret an ordinary domain hookAdditionalContext field', () => {
    const rawOutput = {
      hookAdditionalContext: 'domain-owned value',
      summary: 'ordinary result',
    };
    const toModelOutput = vi.fn((output: unknown) => ({
      type: 'text',
      value: JSON.stringify(output),
    }));
    const tool = asTool({
      execute: () => rawOutput,
      id: 'custom-domain-hook-field',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { custom_domain_hook_field: tool },
      new Map([['custom_domain_hook_field', 'custom.domain-hook-field']])
    );
    const modelOutput = (projected['custom_domain_hook_field'] as TestTool).toModelOutput?.(
      rawOutput
    );

    expect(toModelOutput).toHaveBeenCalledWith(rawOutput);
    expect(modelOutput).toEqual({
      type: 'text',
      value: JSON.stringify(rawOutput),
    });
  });

  it('unwraps a primitive hook result before invoking its domain projector', async () => {
    const toModelOutput = vi.fn((output: unknown) => ({
      type: 'text',
      value: `primitive: ${String(output)}`,
    }));
    const tool = asTool({
      execute: () => Promise.resolve('original primitive'),
      id: 'custom-primitive-hook-context',
      toModelOutput,
    });
    const toolNameMap = new Map([
      ['custom_primitive_hook_context', 'custom.primitive-hook-context'],
    ]);
    const hooked = applyToolHooks(
      { custom_primitive_hook_context: tool },
      {
        hookRunner: {
          postToolUse: () =>
            Promise.resolve({ additionalContext: 'Inspect primitive provenance.' }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['custom_primitive_hook_context'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = projectedTool.toModelOutput?.(rawOutput);

    expect(toModelOutput).toHaveBeenCalledWith('original primitive');
    expect(modelOutput).toEqual({
      type: 'text',
      value: 'primitive: original primitive\nPost-tool context: Inspect primitive provenance.',
    });
  });

  it('unwraps and composes a primitive hook result for the default projector', async () => {
    const tool = asTool({
      execute: () => Promise.resolve('default primitive'),
      id: 'default-primitive-hook-context',
    });
    const toolNameMap = new Map([
      ['default_primitive_hook_context', 'default.primitive-hook-context'],
    ]);
    const hooked = applyToolHooks(
      { default_primitive_hook_context: tool },
      {
        hookRunner: {
          postToolUse: () => Promise.resolve({ additionalContext: 'Inspect default provenance.' }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['default_primitive_hook_context'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = projectedTool.toModelOutput?.(rawOutput);

    expect(modelOutput).toEqual({
      type: 'text',
      value: 'default primitive\nPost-tool context: Inspect default provenance.',
    });
    expect(JSON.stringify(modelOutput)).not.toContain(HOOK_RESULT_ENVELOPE_FIELD);
  });

  it('preserves an object result that owns the reserved hook-wrapper field', async () => {
    const originalResult = { [HOOK_RESULT_ENVELOPE_FIELD]: 'domain value' };
    const toModelOutput = vi.fn((output: unknown) => ({
      type: 'text',
      value: JSON.stringify(output),
    }));
    const tool = asTool({
      execute: () => Promise.resolve(originalResult),
      id: 'custom-reserved-field',
      toModelOutput,
    });
    const toolNameMap = new Map([['custom_reserved_field', 'custom.reserved-field']]);
    const hooked = applyToolHooks(
      { custom_reserved_field: tool },
      {
        hookRunner: {
          postToolUse: () => Promise.resolve({ additionalContext: 'Inspect reserved fields.' }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['custom_reserved_field'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = projectedTool.toModelOutput?.(rawOutput);

    expect(toModelOutput).toHaveBeenCalledWith(originalResult);
    expect(modelOutput).toEqual({
      type: 'text',
      value:
        `{"${HOOK_RESULT_ENVELOPE_FIELD}":"domain value"}` +
        '\nPost-tool context: Inspect reserved fields.',
    });
  });

  it('keeps the complete domain projection and bounded post-tool context within one budget', async () => {
    const continuation = 'nextCursor: line:201';
    const domainBody = `${'x'.repeat(2800)}middle-source-sentinel${'y'.repeat(2700)}`;
    const domainProjection = `path: "/workspace/large.ts"\n${domainBody}\n${continuation}`;
    const domainOutput = { summary: 'raw result' };
    const hookContext = `Inspect packages/db before continuing.${'\u0000'.repeat(2000)}`;
    const toModelOutput = vi.fn(async () => ({
      type: 'text',
      value: domainProjection,
    }));
    const tool = asTool({
      execute: () => domainOutput,
      id: 'custom-bounded-hook-context',
      toModelOutput,
    });
    const toolNameMap = new Map([['custom_bounded_hook_context', 'custom.bounded-hook-context']]);
    const hooked = applyToolHooks(
      { custom_bounded_hook_context: tool },
      {
        hookRunner: {
          postToolUse: () => Promise.resolve({ additionalContext: hookContext }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['custom_bounded_hook_context'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = (await projectedTool.toModelOutput?.(rawOutput)) as {
      type?: string;
      value?: string;
    };

    expect(modelOutput.type).toBe('text');
    expect(modelOutput.value?.startsWith(domainProjection)).toBe(true);
    expect(modelOutput.value).toContain('middle-source-sentinel');
    expect(modelOutput.value).toContain(continuation);
    expect(modelOutput.value).toContain(
      'Post-tool context: Inspect packages/db before continuing.'
    );
    expect(modelOutput.value).toContain('[post-tool context truncated]');
    expect(modelOutput.value).not.toContain('[model projection truncated]');
    expect(JSON.stringify(modelOutput).length).toBeLessThanOrEqual(8000);
  });

  it('appends hook context without reordering authored content parts', async () => {
    const domainOutput = { summary: 'raw multimodal result' };
    const authoredContent = [
      { text: 'caption before image', type: 'text' },
      { data: 'aGVsbG8=', mediaType: 'image/png', type: 'media' },
      { text: 'follow-up after image', type: 'text' },
    ];
    const tool = asTool({
      execute: () => domainOutput,
      id: 'custom-ordered-content',
      toModelOutput: () => ({ type: 'content', value: authoredContent }),
    });
    const toolNameMap = new Map([['custom_ordered_content', 'custom.ordered-content']]);
    const hooked = applyToolHooks(
      { custom_ordered_content: tool },
      {
        hookRunner: {
          postToolUse: () =>
            Promise.resolve({ additionalContext: 'Inspect the image after both captions.' }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['custom_ordered_content'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = projectedTool.toModelOutput?.(rawOutput) as {
      type?: string;
      value?: Record<string, unknown>[];
    };

    expect(modelOutput.type).toBe('content');
    expect(modelOutput.value?.slice(0, authoredContent.length)).toEqual(authoredContent);
    expect(modelOutput.value?.at(-1)).toEqual({
      text: 'Post-tool context: Inspect the image after both captions.',
      type: 'text',
    });
  });

  it.each([
    null,
    undefined,
  ])('bounds the raw result when a custom projection declines with %s', (customProjection) => {
    const rawOnlyTail = 'conditional-raw-only-tail';
    const rawOutput = { content: `${'x'.repeat(20_000)}${rawOnlyTail}` };
    const toModelOutput = vi.fn(() => customProjection);
    const tool = asTool({
      execute: () => rawOutput,
      id: 'conditional-custom',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { conditional_custom: tool },
      new Map([['conditional_custom', 'custom.conditional']])
    );
    const modelOutput = (projected['conditional_custom'] as TestTool).toModelOutput?.(
      rawOutput
    ) as { type?: string; value?: string };

    expect(modelOutput.type).toBe('text');
    expect(modelOutput.value).toContain('output was truncated');
    expect(modelOutput.value).not.toContain(rawOnlyTail);
  });

  it('uses the unwrapped primitive when a hook-aware custom projection declines', async () => {
    const toModelOutput = vi.fn(() => undefined);
    const tool = asTool({
      execute: () => Promise.resolve('primitive fallback'),
      id: 'conditional-primitive-hook',
      toModelOutput,
    });
    const toolNameMap = new Map([
      ['conditional_primitive_hook', 'custom.conditional-primitive-hook'],
    ]);
    const hooked = applyToolHooks(
      { conditional_primitive_hook: tool },
      {
        hookRunner: {
          postToolUse: () => Promise.resolve({ additionalContext: 'Inspect fallback context.' }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['conditional_primitive_hook'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = projectedTool.toModelOutput?.(rawOutput);

    expect(toModelOutput).toHaveBeenCalledWith('primitive fallback');
    expect(modelOutput).toEqual({
      type: 'text',
      value: 'primitive fallback\nPost-tool context: Inspect fallback context.',
    });
  });

  it('bounds the raw result when an asynchronous custom projection declines', async () => {
    const rawOnlyTail = 'async-conditional-raw-only-tail';
    const rawOutput = { content: `${'x'.repeat(20_000)}${rawOnlyTail}` };
    const toModelOutput = vi.fn(async () => undefined);
    const tool = asTool({
      execute: () => rawOutput,
      id: 'async-conditional-custom',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { async_conditional_custom: tool },
      new Map([['async_conditional_custom', 'custom.async-conditional']])
    );

    const modelOutput = (await (projected['async_conditional_custom'] as TestTool).toModelOutput?.(
      rawOutput
    )) as { type?: string; value?: string };

    expect(modelOutput.type).toBe('text');
    expect(modelOutput.value).toContain('output was truncated');
    expect(modelOutput.value).not.toContain(rawOnlyTail);
  });

  it('rejects an oversized domain projection that did not self-fit', () => {
    const toModelOutput = vi.fn(() => ({
      type: 'text',
      value: 'x'.repeat(20_000),
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

    expect(() => (projected['custom'] as TestTool).toModelOutput?.('result')).toThrow(
      'must self-fit'
    );
  });

  it('preserves Mastra-native media from a self-fitting async custom projection', async () => {
    const mediaData = 'a'.repeat(10_000);
    const imageDataUrl = `data:image/png;base64,${'b'.repeat(10_000)}`;
    const toModelOutput = vi.fn(async () => ({
      type: 'content',
      value: [
        { data: mediaData, mediaType: 'image/png', type: 'media' },
        { type: 'image-url', url: imageDataUrl },
        { text: `${'x'.repeat(4000)}custom-text-tail`, type: 'text' },
      ],
    }));
    const tool = asTool({
      execute: () => 'raw',
      id: 'custom-media',
      toModelOutput,
    });

    const projected = applyToolModelOutputProjections(
      { custom_media: tool },
      new Map([['custom_media', 'custom.media']])
    );
    const modelOutput = (await (projected['custom_media'] as TestTool).toModelOutput?.(
      'result'
    )) as {
      type?: string;
      value?: Record<string, unknown>[];
    };

    expect(modelOutput.type).toBe('content');
    expect(modelOutput.value).toContainEqual({
      data: mediaData,
      mediaType: 'image/png',
      type: 'media',
    });
    expect(modelOutput.value).toContainEqual({
      type: 'image-url',
      url: imageDataUrl,
    });
    const text = modelOutput.value?.find((part) => part['type'] === 'text')?.['text'];
    expect(text).toContain('custom-text-tail');
    expect(text).not.toContain('output was truncated');
  });

  it('preserves MCP image and audio data while bounding model-facing text', async () => {
    const domainOutput = {
      content: [
        { text: `${'x'.repeat(20_000)}text-only-tail`, type: 'text' },
        { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
        { data: 'UklGRg==', mimeType: 'audio/wav', type: 'audio' },
      ],
    };
    const tool = asTool({ execute: () => domainOutput, id: 'multimodal' });
    const toolNameMap = new Map([['multimodal', 'remote.multimodal']]);
    const hooked = applyToolHooks(
      { multimodal: tool },
      {
        hookRunner: {
          postToolUse: () =>
            Promise.resolve({
              additionalContext: 'Inspect the media provenance before continuing.',
            }),
          preToolUse: () => Promise.resolve({ decision: 'allow' }),
        },
        toolNameMap,
      }
    );
    const projected = applyToolModelOutputProjections(hooked, toolNameMap);
    const projectedTool = projected['multimodal'] as TestTool;

    const rawOutput = await projectedTool.execute?.({});
    const modelOutput = projectedTool.toModelOutput?.(rawOutput) as {
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
    expect(text).not.toContain('text-only-tail');
    expect(modelOutput.value?.at(-1)).toEqual({
      text: 'Post-tool context: Inspect the media provenance before continuing.',
      type: 'text',
    });
    expect(JSON.stringify(modelOutput)).not.toContain(HOOK_RESULT_ENVELOPE_FIELD);
  });

  it('extracts MCP media from the Mastra execution envelope', () => {
    const rawOutput = {
      content: [
        { text: 'Inspect both attachments.', type: 'text' },
        { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
        { data: 'UklGRg==', mimeType: 'audio/wav', type: 'audio' },
      ],
    };
    const tool = asTool({ execute: () => rawOutput, id: 'multimodal' });

    const projected = applyToolModelOutputProjections(
      { multimodal: tool },
      new Map([['multimodal', 'remote.multimodal']])
    );
    const modelOutput = (projected['multimodal'] as TestTool).toModelOutput?.({
      input: { query: 'attachments' },
      output: rawOutput,
      toolCallId: 'call-multimodal',
    }) as {
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
