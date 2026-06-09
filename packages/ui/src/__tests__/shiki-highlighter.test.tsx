import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shikiMocks = vi.hoisted(() => ({
  createHighlighterCore: vi.fn(),
  createOnigurumaEngine: vi.fn(() => ({ engine: 'oniguruma' })),
}));

vi.mock('react-shiki/core', () => ({
  default: ({
    children,
    className,
    language,
    theme,
  }: {
    children: ReactNode;
    className?: string;
    language: string;
    theme: { dark: string; light: string };
  }) => (
    <div
      data-class-name={className}
      data-language={language}
      data-testid="shiki-highlighter"
      data-theme={`${theme.light}:${theme.dark}`}
    >
      {children}
    </div>
  ),
  createHighlighterCore: shikiMocks.createHighlighterCore,
  createOnigurumaEngine: shikiMocks.createOnigurumaEngine,
}));

const components: SyntaxHighlighterProps['components'] = {
  Pre: ({ children }: { children?: ReactNode }) => <pre data-testid="fallback-pre">{children}</pre>,
  Code: ({ children }: { children?: ReactNode }) => (
    <code data-testid="fallback-code">{children}</code>
  ),
};

async function importSubject(): Promise<typeof import('../assistant-ui-panel/shiki-highlighter')> {
  return import('../assistant-ui-panel/shiki-highlighter');
}

describe('SyntaxHighlighterComponent', () => {
  beforeEach(() => {
    vi.resetModules();
    shikiMocks.createHighlighterCore.mockReset();
    shikiMocks.createOnigurumaEngine.mockClear();
    shikiMocks.createHighlighterCore.mockResolvedValue({ highlighter: 'core' });
  });

  it('renders fallback pre/code while the highlighter is loading and then renders Shiki', async () => {
    const { SyntaxHighlighterComponent } = await importSubject();

    render(
      <SyntaxHighlighterComponent code="const answer = 42;" components={components} language="ts" />
    );

    expect(screen.getByTestId('fallback-code')).toHaveTextContent('const answer = 42;');

    await waitFor(() => expect(screen.getByTestId('shiki-highlighter')).toBeInTheDocument());
    expect(screen.getByTestId('shiki-highlighter')).toHaveTextContent('const answer = 42;');
    expect(screen.getByTestId('shiki-highlighter')).toHaveAttribute('data-language', 'typescript');
    expect(screen.getByTestId('shiki-highlighter')).toHaveAttribute(
      'data-theme',
      'github-light:github-dark'
    );
    expect(shikiMocks.createHighlighterCore).toHaveBeenCalledTimes(1);
    expect(shikiMocks.createOnigurumaEngine).toHaveBeenCalledTimes(1);
  });

  it('normalizes shell aliases and falls back unsupported languages to plaintext', async () => {
    const { SyntaxHighlighterComponent } = await importSubject();
    const { rerender } = render(
      <SyntaxHighlighterComponent code="echo hi" components={components} language="zsh" />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shiki-highlighter')).toHaveAttribute('data-language', 'bash')
    );

    rerender(
      <SyntaxHighlighterComponent code="+++" components={components} language="brainfuck" />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shiki-highlighter')).toHaveAttribute('data-language', 'plaintext')
    );
    expect(shikiMocks.createHighlighterCore).toHaveBeenCalledTimes(1);
  });

  it('uses fallback markup for empty code without rendering Shiki', async () => {
    const { SyntaxHighlighterComponent } = await importSubject();

    render(<SyntaxHighlighterComponent code="" components={components} language="tsx" />);

    expect(screen.getByTestId('fallback-pre')).toContainElement(
      screen.getByTestId('fallback-code')
    );
    expect(screen.queryByTestId('shiki-highlighter')).not.toBeInTheDocument();
  });

  it('keeps plaintext fallback when highlighter initialization fails', async () => {
    shikiMocks.createHighlighterCore.mockRejectedValueOnce(new Error('wasm unavailable'));
    const { SyntaxHighlighterComponent } = await importSubject();

    render(<SyntaxHighlighterComponent code="select 1" components={components} language="sql" />);

    await waitFor(() => expect(shikiMocks.createHighlighterCore).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('fallback-code')).toHaveTextContent('select 1');
    expect(screen.queryByTestId('shiki-highlighter')).not.toBeInTheDocument();
  });
});
