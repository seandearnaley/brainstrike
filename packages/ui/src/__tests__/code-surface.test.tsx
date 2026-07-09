import { EditorView } from '@codemirror/view';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeSurface } from '../code-surface';

describe('CodeSurface', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts a read-only CodeMirror surface with line numbers and resolved language metadata', async () => {
    render(
      <CodeSurface
        ariaLabel="Source preview"
        path="src/example.ts"
        testId="source-preview"
        value={'export const answer = 42;\nconsole.log(answer);\n'}
      />
    );

    const surface = await screen.findByTestId('source-preview');
    expect(surface).toHaveAttribute('data-language', 'TypeScript');
    expect(surface).toHaveAttribute('data-editable', 'false');
    expect(surface.querySelector('.cm-editor')).toBeInTheDocument();
    expect(surface.querySelector('.cm-lineNumbers')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Source preview' })).toHaveAttribute(
      'contenteditable',
      'false'
    );
    expect(surface).toHaveTextContent('export const answer = 42;');
  });

  it('exposes future editor hooks without making read-only usage editable by default', async () => {
    const onChange = vi.fn();

    render(
      <CodeSurface
        onChange={onChange}
        path="README.md"
        testId="markdown-preview"
        value={'# Brainstrike\n\nLocal-first code context.\n'}
      />
    );

    const surface = await screen.findByTestId('markdown-preview');
    expect(surface).toHaveAttribute('data-language', 'Markdown');
    expect(surface).toHaveAttribute('data-editable', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not report controlled value synchronization as a user edit', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CodeSurface
        editable={true}
        onChange={onChange}
        path="src/example.ts"
        testId="controlled-preview"
        value="const answer = 41;"
      />
    );

    expect(await screen.findByTestId('controlled-preview')).toHaveTextContent('const answer = 41;');

    rerender(
      <CodeSurface
        editable={true}
        onChange={onChange}
        path="src/example.ts"
        testId="controlled-preview"
        value="const answer = 42;"
      />
    );

    expect(await screen.findByTestId('controlled-preview')).toHaveTextContent('const answer = 42;');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores initial scroll position after CodeMirror has measured layout', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);

    const { unmount } = render(
      <CodeSurface
        initialScrollTop={72}
        path="src/example.ts"
        testId="scroll-preview"
        value={Array.from({ length: 100 }, (_, index) => `const line${index} = ${index};`).join(
          '\n'
        )}
      />
    );

    const surface = await screen.findByTestId('scroll-preview');
    const scroller = surface.querySelector<HTMLElement>('.cm-scroller');
    expect(scroller).not.toBeNull();
    expect(requestAnimationFrame).toHaveBeenCalled();
    expect(scroller?.scrollTop).toBe(0);

    for (const animationFrame of animationFrames) {
      animationFrame(performance.now());
    }

    expect(scroller?.scrollTop).toBe(72);

    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('scrolls initialLine into view and lets it win over initialScrollTop', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      }
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    // Spy but call through so a real scroll effect is still dispatched.
    const scrollIntoView = vi.spyOn(EditorView, 'scrollIntoView');

    const { rerender } = render(
      <CodeSurface
        initialLine={50}
        initialScrollTop={72}
        path="src/example.ts"
        testId="line-preview"
        value={Array.from({ length: 100 }, (_, index) => `const line${index} = ${index};`).join(
          '\n'
        )}
      />
    );

    const surface = await screen.findByTestId('line-preview');
    const scroller = surface.querySelector<HTMLElement>('.cm-scroller');
    expect(scroller).not.toBeNull();

    for (const animationFrame of animationFrames) {
      animationFrame(performance.now());
    }

    // The line target scrolled a real position into view...
    expect(scrollIntoView).toHaveBeenCalled();
    const firstArg = scrollIntoView.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe('number');
    expect(firstArg).toBeGreaterThan(0);
    // ...and initialScrollTop was NOT applied (initialLine wins).
    expect(scroller?.scrollTop).toBe(0);

    // A later rerender must not re-apply initialLine (first-render only).
    scrollIntoView.mockClear();
    rerender(
      <CodeSurface
        initialLine={50}
        initialScrollTop={72}
        path="src/example.ts"
        testId="line-preview"
        value={Array.from({ length: 100 }, (_, index) => `const line${index} = ${index};`).join(
          '\n'
        )}
      />
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
