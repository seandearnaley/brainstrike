import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useShikiHighlighter: vi.fn<() => unknown>(() => null),
  writeText: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({
    writeText: mocks.writeText,
  }),
}));

vi.mock('react-shiki/core', () => ({
  default: ({ children, language }: { children: ReactNode; language: string }) => (
    <div data-language={language} data-testid="shiki-highlighter">
      {children}
    </div>
  ),
}));

vi.mock('../../shiki/highlighter-core', () => ({
  normalizeShikiLanguage: (language: string | undefined) => language ?? '',
  useShikiHighlighter: mocks.useShikiHighlighter,
}));

import { TooltipProvider } from '../../tooltip';
import { MarkdownCodeBlock } from '../markdown-code-block';

// The real app mounts one TooltipProvider at the AppLayout root; the copy
// button's tooltip needs it.
const renderBlock = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe('MarkdownCodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useShikiHighlighter.mockReturnValue(null);
    mocks.writeText.mockResolvedValue({ ok: true });
  });

  it('renders the shared box: language header + highlighted body', () => {
    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });

    const { container } = renderBlock(
      <MarkdownCodeBlock code="const x = 1;" language="typescript" />
    );

    expect(container.querySelector('.bs-code-block')).not.toBeNull();
    expect(screen.getByText('typescript')).toBeInTheDocument();
    expect(screen.getByTestId('shiki-highlighter')).toHaveTextContent('const x = 1;');
  });

  it('copies the fence contents through the shared clipboard service', async () => {
    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });

    renderBlock(<MarkdownCodeBlock code="const x = 1;" language="typescript" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code to clipboard' }));

    await waitFor(() => {
      expect(mocks.writeText).toHaveBeenCalledWith('const x = 1;');
    });
  });

  it('keeps the box chrome with a plain pre fallback before the highlighter resolves', () => {
    const { container } = renderBlock(<MarkdownCodeBlock code="select 1" language="sql" />);

    expect(container.querySelector('.bs-code-block')).not.toBeNull();
    expect(screen.getByText('sql')).toBeInTheDocument();
    expect(container.querySelector('.bs-code-block-body pre code')).toHaveTextContent('select 1');
    expect(screen.queryByTestId('shiki-highlighter')).not.toBeInTheDocument();
  });
});
