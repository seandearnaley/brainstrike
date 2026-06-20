import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../diff-view';
import { parseUnifiedDiff } from '../diff-view/parse-unified-diff';

const ORIGINAL = 'const answer = 41;\nconsole.log(answer);\n';
const MODIFIED = 'const answer = 42;\nconsole.log(answer);\n';

describe('DiffView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a side-by-side merge view by default with resolved language metadata', async () => {
    render(
      <DiffView filename="src/example.ts" modified={MODIFIED} original={ORIGINAL} testId="diff" />
    );

    const surface = await screen.findByTestId('diff');
    expect(surface).toHaveAttribute('data-mode', 'split');
    expect(surface).toHaveAttribute('data-language', 'TypeScript');
    // The split MergeView renders TWO editors (original + modified).
    expect(surface.querySelectorAll('.cm-editor').length).toBeGreaterThanOrEqual(2);
    expect(surface).toHaveTextContent('const answer = 42;');
  });

  it('toggles to an inline unified view and back', async () => {
    const user = userEvent.setup();
    render(<DiffView modified={MODIFIED} original={ORIGINAL} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    expect(surface).toHaveAttribute('data-mode', 'split');

    await user.click(screen.getByRole('button', { name: 'Switch to inline diff' }));
    expect(surface).toHaveAttribute('data-mode', 'unified');
    // Unified mode renders a single editor.
    expect(surface.querySelectorAll('.cm-editor').length).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Switch to side-by-side diff' }));
    expect(surface).toHaveAttribute('data-mode', 'split');
  });

  it('shows a truncation note when the diff is truncated', async () => {
    render(<DiffView modified={MODIFIED} original={ORIGINAL} testId="diff" truncated={true} />);

    expect(await screen.findByTestId('diff-truncated-note')).toHaveTextContent('diff truncated');
  });

  it('exposes the toggle as an accessible pressed-state button', async () => {
    render(<DiffView modified={MODIFIED} original={ORIGINAL} testId="diff" />);

    const toggle = await screen.findByRole('button', { name: 'Switch to inline diff' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('parseUnifiedDiff', () => {
  it('reconstructs original and modified sides from a git unified diff', () => {
    const unified = [
      'diff --git a/src/example.ts b/src/example.ts',
      'index 1111111..2222222 100644',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,2 +1,2 @@',
      '-const answer = 41;',
      '+const answer = 42;',
      ' console.log(answer);',
      '',
    ].join('\n');

    const parsed = parseUnifiedDiff(unified);
    expect(parsed.hasHunks).toBe(true);
    expect(parsed.original).toBe('const answer = 41;\nconsole.log(answer);');
    expect(parsed.modified).toBe('const answer = 42;\nconsole.log(answer);');
  });

  it('reports hasHunks=false for an empty / binary diff', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n'
    );
    expect(parsed.hasHunks).toBe(false);
    expect(parsed.original).toBe('');
    expect(parsed.modified).toBe('');
  });

  it('handles a pure addition hunk (new file)', () => {
    const unified = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
      '',
    ].join('\n');

    const parsed = parseUnifiedDiff(unified);
    expect(parsed.original).toBe('');
    expect(parsed.modified).toBe('line one\nline two');
  });
});
