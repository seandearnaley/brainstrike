import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedShikiProps {
  addDefaultStyles?: boolean;
  children?: ReactNode;
  delay?: number;
  highlighter?: unknown;
  language?: string;
  showLanguage?: boolean;
  theme?: { dark: string; light: string };
}

const mocks = vi.hoisted(() => ({
  capturedShikiProps: [] as CapturedShikiProps[],
  useShikiHighlighter: vi.fn<() => unknown>(() => null),
}));

vi.mock('react-shiki/core', () => ({
  default: (props: CapturedShikiProps) => {
    mocks.capturedShikiProps.push(props);
    return <div data-testid="shiki-highlighter">{props.children}</div>;
  },
}));

vi.mock('../../shiki/highlighter-core', () => ({
  normalizeShikiLanguage: (language: string | undefined) => `normalized:${language ?? ''}`,
  useShikiHighlighter: mocks.useShikiHighlighter,
}));

import { CodeBlockBody } from '../code-block-body';

describe('CodeBlockBody', () => {
  beforeEach(() => {
    mocks.capturedShikiProps.length = 0;
    mocks.useShikiHighlighter.mockReturnValue(null);
  });

  it('renders the default plain fallback inside the constant wrapper while the highlighter is unavailable', () => {
    const { container } = render(<CodeBlockBody code="const x = 1;" language="ts" />);

    const wrapper = container.querySelector('.bs-code-block-body');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('pre code')).toHaveTextContent('const x = 1;');
    expect(screen.queryByTestId('shiki-highlighter')).not.toBeInTheDocument();
  });

  it('renders a custom fallback when provided', () => {
    render(
      <CodeBlockBody
        code="const x = 1;"
        fallback={<pre data-testid="custom-fallback">const x = 1;</pre>}
        language="ts"
      />
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('shiki-highlighter')).not.toBeInTheDocument();
  });

  it('keeps the fallback for empty code even when the highlighter is ready', () => {
    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });

    const { container } = render(<CodeBlockBody code="" language="ts" />);

    expect(container.querySelector('.bs-code-block-body')).not.toBeNull();
    expect(screen.queryByTestId('shiki-highlighter')).not.toBeInTheDocument();
  });

  it('renders Shiki with the language label and default styles disabled', () => {
    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });

    render(<CodeBlockBody code="echo hi" delay={50} language="zsh" />);

    expect(screen.getByTestId('shiki-highlighter')).toHaveTextContent('echo hi');
    expect(mocks.capturedShikiProps).toHaveLength(1);
    const props = mocks.capturedShikiProps[0];
    expect(props?.showLanguage).toBe(false);
    expect(props?.addDefaultStyles).toBe(false);
    expect(props?.delay).toBe(50);
    expect(props?.language).toBe('normalized:zsh');
    expect(props?.theme).toEqual({ dark: 'github-dark', light: 'github-light' });
    expect(props?.highlighter).toEqual({ highlighter: 'core' });
  });

  it('keeps the wrapper element constant across the fallback → highlighted swap', () => {
    const { container, rerender } = render(<CodeBlockBody code="const x = 1;" language="ts" />);
    const wrapperBefore = container.querySelector('.bs-code-block-body');

    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });
    rerender(<CodeBlockBody code="const x = 1;" language="ts" />);

    expect(container.querySelector('.bs-code-block-body')).toBe(wrapperBefore);
    expect(screen.getByTestId('shiki-highlighter')).toBeInTheDocument();
  });
});
