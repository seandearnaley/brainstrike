import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import { CodeBlock } from '../code-block';

vi.mock('../../shiki/highlighter-core', () => ({
  normalizeShikiLanguage: (language: string) => language,
  useShikiHighlighter: () => null,
}));

const lines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

const renderBlock = (code: string, streaming?: boolean) =>
  render(<CodeBlock code={code} language="ts" streaming={streaming} />, {
    wrapper: TooltipProvider,
  });

const body = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.bs-code-block-body');
  if (!element) {
    throw new Error('expected the code body');
  }
  return element;
};

describe('CodeBlock', () => {
  it('collapses a long block behind a keyboard-reachable "Show all" toggle', async () => {
    const user = userEvent.setup();
    const { container } = renderBlock(`${lines(40)}\n`);

    const toggle = screen.getByRole('button', { name: 'Show all 40 lines' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(body(container)).toHaveAttribute('data-collapsed');
    // Every line stays in the page, so find-in-page and selection still reach it.
    expect(container.querySelector('pre')).toHaveTextContent('line 40');

    toggle.focus();
    await user.keyboard('{Enter}');

    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(body(container)).not.toHaveAttribute('data-collapsed');

    await user.click(less);
    expect(screen.getByRole('button', { name: 'Show all 40 lines' })).toBeInTheDocument();
  });

  it('leaves a short block at full height with no toggle', () => {
    const { container } = renderBlock(lines(25));

    expect(screen.queryByRole('button', { name: /Show all/u })).not.toBeInTheDocument();
    expect(body(container)).not.toHaveAttribute('data-collapsed');
  });

  it('keeps a streaming block at full height, then collapses it once complete', () => {
    const { container, rerender } = renderBlock(lines(60), true);

    expect(screen.queryByRole('button', { name: /Show all/u })).not.toBeInTheDocument();
    expect(body(container)).not.toHaveAttribute('data-collapsed');

    rerender(<CodeBlock code={lines(80)} language="ts" streaming={false} />);

    expect(screen.getByRole('button', { name: 'Show all 80 lines' })).toBeInTheDocument();
    expect(body(container)).toHaveAttribute('data-collapsed');
  });

  it('wraps long lines from a toggle beside Copy', async () => {
    const user = userEvent.setup();
    const { container } = renderBlock('const veryLongLine = 1;');

    const wrap = screen.getByRole('button', { name: 'Wrap lines' });
    expect(wrap).toHaveAttribute('aria-pressed', 'false');
    expect(body(container)).not.toHaveAttribute('data-wrap');
    expect(screen.getByRole('button', { name: 'Copy code to clipboard' })).toBeInTheDocument();

    await user.click(wrap);
    expect(wrap).toHaveAttribute('aria-pressed', 'true');
    expect(body(container)).toHaveAttribute('data-wrap');

    wrap.focus();
    await user.keyboard(' ');
    expect(wrap).toHaveAttribute('aria-pressed', 'false');
    expect(body(container)).not.toHaveAttribute('data-wrap');
  });
});
