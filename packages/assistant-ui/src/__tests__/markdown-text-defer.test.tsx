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

describe('MarkdownText streaming performance', () => {
  it('enables deferred parsing so streaming chunks do not synchronously re-parse the whole message', () => {
    // StreamdownTextPrimitive defaults defer to false, which parses each
    // streamed chunk at urgent priority. `defer` (its useDeferredValue path)
    // keeps the composer responsive; block memoization separately limits each
    // parse to the open block.
    render(<MarkdownText />);

    expect(primitiveMocks.markdownTextPrimitive).toHaveBeenCalled();
    const props = primitiveMocks.markdownTextPrimitive.mock.calls[0]?.[0] as
      | { defer?: boolean }
      | undefined;
    expect(props?.defer).toBe(true);
  });
});
