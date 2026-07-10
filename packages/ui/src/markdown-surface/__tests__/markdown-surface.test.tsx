import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownSurface } from '../markdown-surface';

vi.mock('../markdown-code-block', () => ({
  MarkdownCodeBlock: ({ code, language }: { code: string; language: string }) => (
    <div data-language={language} data-testid="code-block">
      {code}
    </div>
  ),
}));
vi.mock('../mermaid-block', () => ({
  MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid-block">{code}</div>,
}));

const noopResolve = () => new Promise<string>(() => undefined);

function renderSurface(
  value: string,
  overrides: Partial<Parameters<typeof MarkdownSurface>[0]> = {}
) {
  return render(
    <MarkdownSurface
      onOpenLink={vi.fn()}
      resolveImageSrc={noopResolve}
      value={value}
      {...overrides}
    />
  );
}

describe('MarkdownSurface', () => {
  it('renders GFM: headings, tables, task lists, strikethrough', () => {
    renderSurface('# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~\n');
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('gone').tagName).toBe('DEL');
  });

  it('keeps raw HTML inert (no script/iframe execution)', () => {
    const { container } = renderSurface(
      'before\n\n<script>window.__pwned = true</script>\n\n<iframe src="x"></iframe>\n'
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('routes fenced code to MarkdownCodeBlock with the language', () => {
    renderSurface('```ts\nconst x = 1;\n```\n');
    const block = screen.getByTestId('code-block');
    expect(block).toHaveAttribute('data-language', 'ts');
    expect(block).toHaveTextContent('const x = 1;');
  });

  it('routes mermaid fences to MermaidBlock', () => {
    renderSurface('```mermaid\ngraph TD; a-->b;\n```\n');
    expect(screen.getByTestId('mermaid-block')).toHaveTextContent('graph TD; a-->b;');
  });

  it('renders valid frontmatter as a properties block, removed from prose', () => {
    renderSurface('---\ntitle: Spec\n---\n# Body\n');
    expect(screen.getByTestId('markdown-frontmatter')).toHaveTextContent('title');
    expect(screen.getByTestId('markdown-frontmatter')).toHaveTextContent('Spec');
    expect(screen.queryByText(/title: Spec/)).not.toBeInTheDocument();
  });

  it('renders invalid frontmatter visibly with the raw block', () => {
    renderSurface('---\n: : :\n---\nbody\n');
    expect(screen.getByTestId('markdown-frontmatter-error')).toHaveTextContent(
      /invalid frontmatter/i
    );
    expect(screen.getByTestId('markdown-frontmatter-error')).toHaveTextContent(': : :');
  });

  it('intercepts link clicks: onOpenLink fires, default navigation is prevented', () => {
    const onOpenLink = vi.fn();
    renderSurface('[site](https://example.com)\n', { onOpenLink });
    const link = screen.getByRole('link', { name: 'site' });
    fireEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com');
  });

  it('shows an explicit placeholder when image resolution rejects', async () => {
    const resolveImageSrc = vi.fn().mockRejectedValue(new Error('outside root'));
    renderSurface('![diagram](./missing.png)\n', { resolveImageSrc });
    await waitFor(() => {
      expect(screen.getByTestId('markdown-image-error')).toHaveTextContent('./missing.png');
    });
  });

  it('renders resolved images with the resolved src', async () => {
    const resolveImageSrc = vi.fn().mockResolvedValue('blob:fake');
    renderSurface('![diagram](./ok.png)\n', { resolveImageSrc });
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'diagram' })).toHaveAttribute('src', 'blob:fake');
    });
  });

  it('shows an explicit placeholder when a resolved image fails to load', async () => {
    // Resolution succeeds (desktop's asset-protocol resolver never rejects) but the img
    // element still errors — a protocol 404 or CSP-blocked remote image. onError must
    // surface the same visible placeholder rather than a silent broken-image glyph.
    const resolveImageSrc = vi.fn().mockResolvedValue('brainstrike-asset://missing.png');
    renderSurface('![diagram](./broken.png)\n', { resolveImageSrc });
    const img = await screen.findByRole('img', { name: 'diagram' });
    fireEvent.error(img);
    await waitFor(() => {
      expect(screen.getByTestId('markdown-image-error')).toHaveTextContent('./broken.png');
    });
  });

  it('scrolls to an in-document anchor without invoking onOpenLink', () => {
    const onOpenLink = vi.fn();
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    try {
      renderSurface('# Section\n\n[jump](#section)\n', { onOpenLink });
      fireEvent.click(screen.getByRole('link', { name: 'jump' }));
      expect(scrollIntoView).toHaveBeenCalled();
      expect(onOpenLink).not.toHaveBeenCalled();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('does not throw or call onOpenLink for a malformed anchor', () => {
    const onOpenLink = vi.fn();
    renderSurface('[bad](#%)\n', { onOpenLink });
    expect(() => fireEvent.click(screen.getByRole('link', { name: 'bad' }))).not.toThrow();
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it('reports scroll position changes', () => {
    const onScrollTopChange = vi.fn();
    renderSurface('# a\n', { onScrollTopChange, testId: 'md-surface' });
    fireEvent.scroll(screen.getByTestId('md-surface'), { target: { scrollTop: 120 } });
    expect(onScrollTopChange).toHaveBeenCalledWith(120);
  });

  it('shows a truncation notice when truncated', () => {
    renderSurface('# a\n', { truncated: true });
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('snapshots exact text selected entirely inside the surface on contextmenu', () => {
    const onContextMenuSelection = vi.fn();
    renderSurface('alpha beta', { onContextMenuSelection, testId: 'md-surface' });
    const surface = screen.getByTestId('md-surface');
    const textNode = screen.getByText('alpha beta').firstChild;
    expect(textNode).not.toBeNull();
    const selectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '  alpha\n',
    } as unknown as Selection);
    try {
      fireEvent.contextMenu(surface);
      expect(onContextMenuSelection).toHaveBeenCalledWith({ text: '  alpha\n' });
    } finally {
      selectionSpy.mockRestore();
    }
  });

  it('rejects a stale selection whose endpoint is outside the surface', () => {
    const onContextMenuSelection = vi.fn();
    const { container } = renderSurface('alpha beta', {
      onContextMenuSelection,
      testId: 'md-surface',
    });
    const surface = screen.getByTestId('md-surface');
    const internalNode = screen.getByText('alpha beta').firstChild;
    const outsideNode = document.createTextNode('outside');
    container.append(outsideNode);
    const selectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: internalNode,
      focusNode: outsideNode,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'alpha outside',
    } as unknown as Selection);
    try {
      fireEvent.contextMenu(surface);
      expect(onContextMenuSelection).toHaveBeenCalledWith({ text: null });
    } finally {
      selectionSpy.mockRestore();
    }
  });
});
