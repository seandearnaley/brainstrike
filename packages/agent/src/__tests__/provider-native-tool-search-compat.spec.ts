import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Intentional dependency canary: when either evaluated SDK surface changes,
// revisit the BST-614 evidence before accepting the dependency update.
describe('provider-native tool-search compatibility seam', () => {
  it('exposes the exact hosted search tools evaluated by BST-614', () => {
    const openaiSearch = createOpenAI({ apiKey: 'not-used' }).tools.toolSearch();
    const anthropicSearch = createAnthropic({ apiKey: 'not-used' }).tools.toolSearchBm25_20251119();

    expect(openaiSearch).toMatchObject({
      id: 'openai.tool_search',
      isProviderExecuted: false,
      type: 'provider',
    });
    expect(anthropicSearch).toMatchObject({
      id: 'anthropic.tool_search_bm25_20251119',
      isProviderExecuted: true,
      type: 'provider',
    });
  });

  it('preserves defer-loading metadata and approval on a Mastra tool', () => {
    const execute = vi.fn(async () => ({ changed: true }));
    const tool = createTool({
      description: 'Edit a workspace file by replacing one exact string.',
      execute,
      id: 'edit_workspace',
      inputSchema: z.object({ replacement: z.string() }),
      outputSchema: z.object({ changed: z.boolean() }),
      providerOptions: {
        anthropic: { deferLoading: true },
        openai: { deferLoading: true },
      },
      requireApproval: true,
    });

    expect(tool.providerOptions).toEqual({
      anthropic: { deferLoading: true },
      openai: { deferLoading: true },
    });
    expect(tool.requireApproval).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
