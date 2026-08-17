import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const primitiveMocks = vi.hoisted(() => ({
  markdownTextPrimitive: vi.fn((_props: unknown) => null),
}));

vi.mock('@assistant-ui/react-markdown', () => ({
  MarkdownTextPrimitive: primitiveMocks.markdownTextPrimitive,
  unstable_memoizeMarkdownComponents: <T,>(components: T) => components,
}));

vi.mock('@assistant-ui/react', () => ({
  useMessagePartText: () => ({ status: { type: 'running' }, text: 'streaming…', type: 'text' }),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({ writeText: vi.fn() }),
}));

vi.mock('../shiki-highlighter', () => ({
  SyntaxHighlighterComponent: () => null,
}));

import { MarkdownText } from '../markdown-text';

describe('MarkdownText streaming performance', () => {
  it('enables deferred parsing so streaming chunks do not synchronously re-parse the whole message', () => {
    // MarkdownTextPrimitive defaults defer to false, which re-runs the full
    // remark/GFM parse over ALL accumulated text on every streamed chunk at
    // urgent priority. The library's escape hatch is `defer` (its
    // useDeferredValue path); component memoization only spares unchanged
    // rendered blocks, not the parse itself.
    render(<MarkdownText />);

    expect(primitiveMocks.markdownTextPrimitive).toHaveBeenCalled();
    const props = primitiveMocks.markdownTextPrimitive.mock.calls[0]?.[0] as
      | { defer?: boolean }
      | undefined;
    expect(props?.defer).toBe(true);
  });
});
