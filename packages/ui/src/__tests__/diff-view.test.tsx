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

  it('does not leak the git-service "…(output truncated)" marker into either side', () => {
    // The git-service appends a literal "\n…(output truncated)" marker (no diff
    // prefix) when it bounds a >1MB diff.
    const unified = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,2 +1,2 @@',
      '-const a = 1;',
      '+const a = 2;',
      ' tail();',
      '…(output truncated)',
    ].join('\n');

    const parsed = parseUnifiedDiff(unified);
    expect(parsed.hasHunks).toBe(true);
    expect(parsed.original).not.toContain('output truncated');
    expect(parsed.modified).not.toContain('output truncated');
    expect(parsed.original).toBe('const a = 1;\ntail();');
    expect(parsed.modified).toBe('const a = 2;\ntail();');
  });

  it('parses changed lines whose content begins with -- / ++ as +/- hunk lines, not file headers', () => {
    // A deleted line "-- old marker" becomes raw "--- old marker"; an added line
    // "++ new marker" becomes raw "+++ new marker". These must NOT be mistaken
    // for `--- ` / `+++ ` file headers (which would drop the rest of the hunk).
    const unified = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,3 +1,3 @@',
      '--- old marker',
      '+++ new marker',
      ' kept line',
      '',
    ].join('\n');

    const parsed = parseUnifiedDiff(unified);
    expect(parsed.original).toBe('-- old marker\nkept line');
    expect(parsed.modified).toBe('++ new marker\nkept line');
  });

  it('preserves a genuine non-final blank context line so sides stay aligned', () => {
    // Some producers emit an unprefixed empty line for a blank context row.
    const unified = ['@@ -1,3 +1,3 @@', ' a', '', '-b', '+c', ''].join('\n');

    const parsed = parseUnifiedDiff(unified);
    // The blank context row is kept on both sides; the trailing artifact is dropped.
    expect(parsed.original).toBe('a\n\nb');
    expect(parsed.modified).toBe('a\n\nc');
  });
});
