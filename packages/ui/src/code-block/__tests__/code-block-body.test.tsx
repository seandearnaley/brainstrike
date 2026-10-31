import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../theme-provider';
import { CodeBlockBody } from '../code-block-body';

interface CapturedShikiProps {
  addDefaultStyles?: boolean;
  children?: ReactNode;
  defaultColor?: false | string;
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

/** Observers the blocks registered; `enterViewport` reports every observed block as near. */
const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
class ViewportObserver {
  private readonly entry: (typeof observers)[number];
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, targets: [] };
    observers.push(this.entry);
  }
  observe(target: Element): void {
    this.entry.targets.push(target);
  }
  disconnect(): void {
    this.entry.targets.length = 0;
  }
}
function enterViewport(): void {
  act(() => {
    for (const { callback, targets } of observers) {
      callback(
        targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry),
        {} as IntersectionObserver
      );
    }
  });
}

describe('CodeBlockBody', () => {
  beforeEach(() => {
    mocks.capturedShikiProps.length = 0;
    mocks.useShikiHighlighter.mockReturnValue(null);
    observers.length = 0;
    vi.stubGlobal('IntersectionObserver', ViewportObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the plain block until it comes near the visible area, then highlights it', () => {
    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });

    const { container } = render(<CodeBlockBody code="const x = 1;" language="ts" />);
    expect(container.querySelector('pre code')).toHaveTextContent('const x = 1;');
    expect(screen.queryByTestId('shiki-highlighter')).not.toBeInTheDocument();

    enterViewport();
    expect(screen.getByTestId('shiki-highlighter')).toHaveTextContent('const x = 1;');
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
    enterViewport();

    expect(screen.getByTestId('shiki-highlighter')).toHaveTextContent('echo hi');
    expect(mocks.capturedShikiProps).toHaveLength(1);
    const props = mocks.capturedShikiProps[0];
    expect(props?.showLanguage).toBe(false);
    expect(props?.addDefaultStyles).toBe(false);
    expect(props?.delay).toBe(50);
    expect(props?.language).toBe('normalized:zsh');
    expect(props?.theme).toEqual({ dark: 'monokai', light: 'github-light' });
    expect(props?.defaultColor).toBe(false);
    expect(props?.highlighter).toEqual({ highlighter: 'core' });
  });

  it('highlights with the Shiki pair of the code theme chosen in Appearance', async () => {
    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });
    const storageAdapter = {
      getItem: async (key: string) => (key === 'ui-theme-code-theme' ? 'catppuccin' : null),
      setItem: async () => undefined,
    };

    render(
      <ThemeProvider storageAdapter={storageAdapter}>
        <CodeBlockBody code="echo hi" language="bash" />
      </ThemeProvider>
    );
    await screen.findByText('echo hi');
    // The provider shows the block after its async load, outside act, so the
    // block's observer effect can still be pending once its text is on screen.
    await waitFor(() => expect(observers.flatMap(({ targets }) => targets)).not.toHaveLength(0));
    enterViewport();

    expect(mocks.capturedShikiProps.at(-1)?.theme).toEqual({
      dark: 'catppuccin-mocha',
      light: 'catppuccin-latte',
    });
  });

  it('keeps the wrapper element constant across the fallback → highlighted swap', () => {
    const { container, rerender } = render(<CodeBlockBody code="const x = 1;" language="ts" />);
    enterViewport();
    const wrapperBefore = container.querySelector('.bs-code-block-body');

    mocks.useShikiHighlighter.mockReturnValue({ highlighter: 'core' });
    rerender(<CodeBlockBody code="const x = 1;" language="ts" />);

    expect(container.querySelector('.bs-code-block-body')).toBe(wrapperBefore);
    expect(screen.getByTestId('shiki-highlighter')).toBeInTheDocument();
  });
});
