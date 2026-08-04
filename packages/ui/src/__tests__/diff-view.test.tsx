import type { StructuredFileDiff } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../diff-view';
import { parseUnifiedDiff } from '../diff-view/parse-unified-diff';

const ORIGINAL = 'const answer = 41;\nconsole.log(answer);\n';
const MODIFIED = 'const answer = 42;\nconsole.log(answer);\n';

/** A 60-line file with a single change at line 42, for the real-line-number gutter assertion. */
function buildSixtyLineDocs(): { modified: string; original: string } {
  const originalLines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  const modifiedLines = [...originalLines];
  modifiedLines[41] = 'line 42 CHANGED';
  return { modified: `${modifiedLines.join('\n')}\n`, original: `${originalLines.join('\n')}\n` };
}

function makeStructuredDiff(overrides: Partial<StructuredFileDiff> = {}): StructuredFileDiff {
  return {
    additions: null,
    content: { kind: 'binary' },
    deletions: null,
    hunks: [],
    path: 'src/example.ts',
    status: 'modified',
    ...overrides,
  };
}

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

describe('DiffView structured mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a structured "full" diff with real line numbers in the gutter', async () => {
    const { original, modified } = buildSixtyLineDocs();
    const diff = makeStructuredDiff({
      additions: 1,
      content: { kind: 'full', newContent: modified, oldContent: original },
      deletions: 1,
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    expect(surface.querySelectorAll('.cm-editor').length).toBeGreaterThanOrEqual(2);
    // Real line numbers require full documents fed to the vanilla `lineNumbers()`
    // gutter — a single-hunk reconstruction could never produce '42' here.
    // Array membership (not a substring join) so this can't false-positive on
    // e.g. a gutter that happens to render '142' or '421' elsewhere.
    const gutterLineNumbers = Array.from(surface.querySelectorAll('.cm-gutterElement')).map(
      (element) => element.textContent?.trim() ?? ''
    );
    expect(gutterLineNumbers).toContain('42');
  });

  it('shows the +/− stat summary beside the filename when additions/deletions are non-null', async () => {
    const { original, modified } = buildSixtyLineDocs();
    const diff = makeStructuredDiff({
      additions: 3,
      content: { kind: 'full', newContent: modified, oldContent: original },
      deletions: 2,
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    expect(await screen.findByTestId('diff-stat-summary')).toHaveTextContent('+3 −2');
  });

  it('renders a read-only unified view naming the over-cap side for hunks-only content, with no fabricated line numbers', async () => {
    const diff = makeStructuredDiff({
      content: {
        hunkText: '@@ -1,2 +1,2 @@\n-old\n+new\n',
        hunkTextTruncated: false,
        kind: 'hunks-only',
        reason: 'over-cap-old',
      },
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const note = await screen.findByTestId('diff-over-cap-note');
    expect(note).toHaveTextContent('old side too large to render in full');
    const surface = await screen.findByTestId('diff');
    // A single read-only view, not a MergeView (no a/b pair).
    expect(surface.querySelectorAll('.cm-editor').length).toBe(1);
    expect(surface).toHaveTextContent('+new');
    // `hunkText` isn't a real file — its lines don't map to any correct
    // absolute position, so this view must NOT render a lineNumbers() gutter
    // (fabricated positions right next to the gutter Task 6 made authoritative).
    expect(surface.querySelectorAll('.cm-gutterElement').length).toBe(0);
    // Decoration choice: tint hunk lines by their leading +/- marker,
    // reusing the same theme classes the full-document view uses, since a
    // language grammar can't run over raw diff text either.
    expect(surface.querySelector('.cm-insertedLine')).not.toBeNull();
    expect(surface.querySelector('.cm-deletedChunk')).not.toBeNull();
  });

  it('names both sides for over-cap-both and shows the truncated badge when hunkTextTruncated', async () => {
    const diff = makeStructuredDiff({
      content: {
        hunkText: '@@ -1,2 +1,2 @@\n-old\n+new\n',
        hunkTextTruncated: true,
        kind: 'hunks-only',
        reason: 'over-cap-both',
      },
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    expect(await screen.findByTestId('diff-over-cap-note')).toHaveTextContent(
      'both sides too large to render in full'
    );
    expect(await screen.findByTestId('diff-truncated-note')).toHaveTextContent('diff truncated');
  });

  it('names diff-overflow distinctly from the over-cap-* reasons', async () => {
    const diff = makeStructuredDiff({
      content: {
        hunkText: '@@ -1,2 +1,2 @@\n-old\n+new\n',
        hunkTextTruncated: false,
        kind: 'hunks-only',
        reason: 'diff-overflow',
      },
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    expect(await screen.findByTestId('diff-over-cap-note')).toHaveTextContent(
      'diff too large to render in full'
    );
  });

  it('renders a binary placeholder with zero mounted editors, no data-mode, and an accessible label', async () => {
    const diff = makeStructuredDiff({ content: { kind: 'binary' } });

    render(
      <DiffView ariaLabel="Diff for logo.png" source={{ diff, kind: 'structured' }} testId="diff" />
    );

    const note = await screen.findByTestId('diff-binary-note');
    expect(note).toHaveTextContent('Binary file — no text diff');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveAttribute('aria-label', 'Diff for logo.png');
    const surface = await screen.findByTestId('diff');
    expect(surface.querySelectorAll('.cm-editor').length).toBe(0);
    // `split`/`unified` don't apply to a placeholder with no editor at all.
    expect(surface).not.toHaveAttribute('data-mode');
  });

  it('omits data-mode for hunks-only content (no split/unified to toggle between)', async () => {
    const diff = makeStructuredDiff({
      content: {
        hunkText: '@@ -1,2 +1,2 @@\n-old\n+new\n',
        hunkTextTruncated: false,
        kind: 'hunks-only',
        reason: 'over-cap-new',
      },
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    expect(surface).not.toHaveAttribute('data-mode');
    // No mode toggle button either.
    expect(screen.queryByRole('button', { name: /switch to/i })).toBeNull();
  });

  it('shows a status chip in structured mode, even when additions/deletions are both null', async () => {
    const diff = makeStructuredDiff({
      additions: null,
      content: { kind: 'binary' },
      deletions: null,
      status: 'renamed',
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    expect(await screen.findByTestId('diff-status-chip')).toHaveTextContent('Renamed');
    // The both-null case must not ALSO claim a (fabricated) stat summary.
    expect(screen.queryByTestId('diff-stat-summary')).toBeNull();
  });

  it('exposes a screen-reader-friendly expansion of the +/− stat summary', async () => {
    const { original, modified } = buildSixtyLineDocs();
    const diff = makeStructuredDiff({
      additions: 1,
      content: { kind: 'full', newContent: modified, oldContent: original },
      deletions: 2,
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const summary = await screen.findByTestId('diff-stat-summary');
    expect(summary).toHaveTextContent('1 addition, 2 deletions');
  });

  it('falls back to the structured diff path for language resolution when `filename` is omitted', async () => {
    const { original, modified } = buildSixtyLineDocs();
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
      path: 'src/fallback-example.py',
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    expect(surface).toHaveAttribute('data-language', 'Python');
    expect(surface).toHaveTextContent('src/fallback-example.py');
  });

  it('keeps the same CodeMirror DOM node across a parent re-render with a freshly-allocated structured `source` literal (no flicker)', async () => {
    const { original, modified } = buildSixtyLineDocs();
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
    });

    function StructuredProbe() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((value) => value + 1)} type="button">
            bump {tick}
          </button>
          {/* A fresh `source` object literal every render — this is the exact
              pattern the multi-file surface uses when passing a per-file diff
              down from parent state. `language="plain"` pins out the
              progressive async language-upgrade rebuild (an unrelated,
              expected one-time rebuild once the grammar loads) so this probe
              isolates ONLY the source-identity behavior under test. */}
          <DiffView language="plain" source={{ diff, kind: 'structured' }} testId="diff" />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<StructuredProbe />);

    const surface = await screen.findByTestId('diff');
    const editorBefore = surface.querySelector('.cm-editor');
    expect(editorBefore).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /bump/ }));
    await user.click(screen.getByRole('button', { name: /bump/ }));

    const editorAfter = surface.querySelector('.cm-editor');
    expect(editorAfter).toBe(editorBefore);
  });

  it('control: keeps the same CodeMirror DOM node across a parent re-render with fresh legacy string props (already-passing baseline)', async () => {
    function LegacyProbe() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((value) => value + 1)} type="button">
            bump {tick}
          </button>
          <DiffView modified={`${MODIFIED}`} original={`${ORIGINAL}`} testId="diff" />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<LegacyProbe />);

    const surface = await screen.findByTestId('diff');
    const editorBefore = surface.querySelector('.cm-editor');
    expect(editorBefore).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /bump/ }));

    const editorAfter = surface.querySelector('.cm-editor');
    expect(editorAfter).toBe(editorBefore);
  });

  it('throws when neither `source` nor legacy `original`/`modified` props are given', () => {
    // Suppress React's expected error-boundary console noise for this assertion.
    vi.spyOn(console, 'error').mockImplementation(() => {
      // intentionally empty
    });
    expect(() => {
      // @ts-expect-error — `DiffViewProps` now enforces `source` XOR
      // `original`+`modified` at compile time; this exercises the runtime
      // backstop in `resolveDiffPresentation` for anything that reaches the
      // component past that (an untyped caller, or a type escape).
      render(<DiffView testId="diff" />);
    }).toThrow();
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
