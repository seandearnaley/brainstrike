import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const primitiveMocks = vi.hoisted(() => ({
  markdownTextPrimitive: vi.fn((_props: unknown) => null),
}));

vi.mock('@assistant-ui/react-streamdown', () => ({
  StreamdownTextPrimitive: primitiveMocks.markdownTextPrimitive,
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

describe('MarkdownText streaming reveal', () => {
  it('reveals words with Streamdown animation instead of a frame-paced re-render', () => {
    // BST-1929: the vendor `smooth` reveal committed on every animation frame,
    // and `defer` split each token into an urgent and a deferred commit.
    // Streamdown's `animated` fades words in with CSS: one commit per token.
    render(<MarkdownText />);

    expect(primitiveMocks.markdownTextPrimitive).toHaveBeenCalled();
    const props = primitiveMocks.markdownTextPrimitive.mock.calls[0]?.[0] as
      | Readonly<Record<string, unknown>>
      | undefined;
    expect(props?.['animated']).toEqual({ animation: 'fadeIn', sep: 'word' });
    expect(props).not.toHaveProperty('smooth');
    expect(props).not.toHaveProperty('defer');
  });
});
