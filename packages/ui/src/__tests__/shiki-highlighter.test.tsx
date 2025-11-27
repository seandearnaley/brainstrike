import { describe, expect, it, vi } from 'vitest';

// Mock shiki to avoid loading actual highlighters
vi.mock('shiki', () => ({
  createHighlighter: vi.fn().mockResolvedValue({
    codeToHtml: vi.fn().mockReturnValue('<code>highlighted code</code>'),
    dispose: vi.fn(),
  }),
}));

describe('SyntaxHighlighterComponent', () => {
  it('module can be imported', async () => {
    const module = await import('../assistant-ui-panel/shiki-highlighter');
    expect(module.SyntaxHighlighterComponent).toBeDefined();
  });
});
