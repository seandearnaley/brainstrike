import type { StructuredFileDiff } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../diff-view';
import {
  buildSlicedTextDiff,
  createSlicedLineNumberFormatter,
  serializeHunkRanges,
} from '../diff-view/diff-view-slice';

const ORIGINAL = 'const answer = 41;\nconsole.log(answer);\n';
const MODIFIED = 'const answer = 42;\nconsole.log(answer);\n';

/** A 60-line file with a single change at line 42, for the real-line-number gutter assertion. */
function buildSixtyLineDocs(): { modified: string; original: string } {
  const originalLines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  const modifiedLines = [...originalLines];
  modifiedLines[41] = 'line 42 CHANGED';
  return { modified: `${modifiedLines.join('\n')}\n`, original: `${originalLines.join('\n')}\n` };
}

/**
 * ~330 KiB of plausible source — over `RENDER_SIDE_SIZE_THRESHOLD_BYTES`
 * (256 KiB) but well under `RENDER_SIDE_LINE_THRESHOLD` (20,000 lines), so
 * it lands squarely in the 256 KiB–2 MiB band the engine still returns as
 * `full` content.
 */
const LARGE_DOC_LINE_COUNT = 6000;

function largeDocLine(lineNumber: number): string {
  return `const value_${String(lineNumber).padStart(6, '0')} = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa';`;
}

/**
 * A ~330 KiB document plus a copy with `editedLines` (1-based) replaced, and
 * the hunk ranges git would report for exactly those edits.
 */
function buildLargeDocs(editedLines: readonly number[]): {
  hunks: StructuredFileDiff['hunks'];
  modified: string;
  original: string;
} {
  const originalLines = Array.from({ length: LARGE_DOC_LINE_COUNT }, (_, index) =>
    largeDocLine(index + 1)
  );
  const modifiedLines = [...originalLines];
  for (const line of editedLines) {
    modifiedLines[line - 1] = `const value_${String(line).padStart(6, '0')} = 'CHANGED_${line}';`;
  }
  // git's default 3 lines of context around a single-line change.
  const hunks = editedLines.map((line) => ({
    newLines: 7,
    newStart: line - 3,
    oldLines: 7,
    oldStart: line - 3,
  }));
  return {
    hunks,
    modified: `${modifiedLines.join('\n')}\n`,
    original: `${originalLines.join('\n')}\n`,
  };
}

/** Trimmed text of every gutter entry currently in the DOM. */
function readGutterNumbers(surface: HTMLElement): string[] {
  return Array.from(surface.querySelectorAll('.cm-gutterElement')).map(
    (element) => element.textContent?.trim() ?? ''
  );
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

  it('disables native spellcheck/autocorrect/autocapitalize on the mounted content DOM', async () => {
    render(<DiffView modified={MODIFIED} original={ORIGINAL} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    // `.cm-content` is the actual `contenteditable` element the browser's
    // native spellchecker runs against — not `.cm-editor` (the outer wrapper).
    const contentElements = surface.querySelectorAll('.cm-content');
    expect(contentElements.length).toBeGreaterThan(0);
    for (const content of contentElements) {
      expect(content).toHaveAttribute('spellcheck', 'false');
      expect(content).toHaveAttribute('autocorrect', 'off');
      expect(content).toHaveAttribute('autocapitalize', 'off');
    }
  });

  it('applies the same render-side size threshold to the legacy string-prop path', async () => {
    const original = 'small original\n';
    // 20,001 lines — one over the render-side line threshold, same as the
    // structured-mode fixture — the freeze risk (MergeView's synchronous
    // main-thread diff) is identical on both paths.
    const modified = `${Array.from({ length: 20_001 }, (_, index) => `line ${index}`).join('\n')}\n`;

    render(<DiffView modified={modified} original={original} testId="diff" />);

    expect(await screen.findByTestId('diff-too-large-note')).toHaveTextContent(
      'File too large to diff inline — showing content without change highlighting'
    );
    const surface = await screen.findByTestId('diff');
    expect(surface.querySelectorAll('.cm-editor').length).toBe(1);
    expect(surface).toHaveTextContent('line 0');
    expect(screen.queryByRole('button', { name: /switch to/iu })).toBeNull();
    expect(surface).not.toHaveAttribute('data-mode');
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
    // Well under the render-side size/line thresholds — the normal
    // MergeView diff renders, not the too-large fallback.
    expect(screen.queryByTestId('diff-too-large-note')).toBeNull();
  });

  it('skips the inline diff and shows the new side read-only when structured "full" content is over the render-side line threshold', async () => {
    const original = 'small original\n';
    // 20,001 lines — one over the render-side line threshold.
    const modified = `${Array.from({ length: 20_001 }, (_, index) => `line ${index}`).join('\n')}\n`;
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    expect(await screen.findByTestId('diff-too-large-note')).toHaveTextContent(
      'File too large to diff inline — showing content without change highlighting'
    );
    const surface = await screen.findByTestId('diff');
    // A single read-only view, not a MergeView (no a/b pair).
    expect(surface.querySelectorAll('.cm-editor').length).toBe(1);
    // The new side is shown (this isn't a deletion) — asserting near the
    // start of the doc, since CodeMirror virtualizes very large documents
    // and won't necessarily render far-scrolled-down lines in the DOM.
    expect(surface).toHaveTextContent('line 0');
    // No split/unified toggle for a fallback that never diffs.
    expect(screen.queryByRole('button', { name: /switch to/iu })).toBeNull();
    expect(surface).not.toHaveAttribute('data-mode');
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

  it('tints hunk lines correctly when hunkText uses CRLF line endings', async () => {
    // CodeMirror's document model normalizes `\r\n` to a single logical line
    // break — decoration positions computed by naively splitting on `'\n'`
    // alone (leaving a trailing `\r` per line) drift out of sync with that
    // and silently drop every decoration on CRLF input.
    const diff = makeStructuredDiff({
      content: {
        hunkText: '@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n',
        hunkTextTruncated: false,
        kind: 'hunks-only',
        reason: 'over-cap-old',
      },
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    expect(await screen.findByTestId('diff-over-cap-note')).toBeTruthy();
    expect(surface).toHaveTextContent('+new');
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

  it('renders a binary placeholder inside the labelled diff region, with zero mounted editors and no data-mode', async () => {
    const diff = makeStructuredDiff({ content: { kind: 'binary' } });

    render(
      <DiffView ariaLabel="Diff for logo.png" source={{ diff, kind: 'structured' }} testId="diff" />
    );

    const note = await screen.findByTestId('diff-binary-note');
    expect(note).toHaveTextContent('Binary file — no text diff');
    // The accessible label lives on the labelled `<section>` region wrapping
    // the placeholder, not on the placeholder itself — an `aria-label` on
    // the inner div would OVERRIDE its own visible text as the accessible
    // name, and `role="status"` would wrongly make static content a live
    // region.
    expect(note).not.toHaveAttribute('role');
    expect(note).not.toHaveAttribute('aria-label');
    const region = screen.getByRole('region', { name: 'Diff for logo.png' });
    expect(region).toContainElement(note);
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
    expect(screen.queryByRole('button', { name: /switch to/iu })).toBeNull();
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

    await user.click(screen.getByRole('button', { name: /bump/u }));
    await user.click(screen.getByRole('button', { name: /bump/u }));

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

    await user.click(screen.getByRole('button', { name: /bump/u }));

    const editorAfter = surface.querySelector('.cm-editor');
    expect(editorAfter).toBe(editorBefore);
  });

  it('slices an over-threshold "full" diff to its changed region and still diffs it, with real line numbers', async () => {
    // The exact case W6 regressed: a text file in the 256 KiB–2 MiB band
    // that the engine returns as `full`, with one small edit. Before
    // slicing this rendered a single read-only side with NO change
    // visibility at all.
    const { hunks, modified, original } = buildLargeDocs([3000]);
    expect(modified.length).toBeGreaterThan(256 * 1024);
    expect(modified.length).toBeLessThan(2 * 1024 * 1024);
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
      hunks,
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    expect(await screen.findByTestId('diff-sliced-note')).toHaveTextContent(
      'File too large to diff in full — showing changed regions with surrounding context'
    );
    // Not the no-change-visibility fallback.
    expect(screen.queryByTestId('diff-too-large-note')).toBeNull();
    // A real two-document MergeView (a/b pair), not a single read-only side.
    expect(surface.querySelectorAll('.cm-editor').length).toBeGreaterThanOrEqual(2);
    // The edit itself is visible — the whole point of the fix.
    expect(surface).toHaveTextContent('CHANGED_3000');
    // ...highlighted as a change, on both sides.
    expect(surface.querySelector('.cm-changedLine')).not.toBeNull();
    // Real ABSOLUTE line numbers, not the slice's own 1..n counting.
    const gutterNumbers = readGutterNumbers(surface);
    expect(gutterNumbers).toContain('3000');
    // Line 1 was elided, so a vanilla `lineNumbers()` gutter's '1' must not
    // appear — this is what proves the numbers are mapped, not fabricated.
    expect(gutterNumbers).not.toContain('1');
    // Proof the whole document was NOT mounted: content far from the hunk
    // is absent entirely (CodeMirror virtualization can't explain this —
    // the sliced doc is ~15 lines, all rendered).
    expect(surface).not.toHaveTextContent('value_000001');
    // A sliced diff is still a real two-document diff, so the mode toggle stays.
    expect(screen.queryByRole('button', { name: /switch to/iu })).not.toBeNull();
  });

  it('marks elided regions in the gutter without fabricating a line number for them', async () => {
    const { hunks, modified, original } = buildLargeDocs([1000, 5000]);
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
      hunks,
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    const surface = await screen.findByTestId('diff');
    expect(await screen.findByTestId('diff-sliced-note')).toBeTruthy();
    expect(surface).toHaveTextContent('CHANGED_1000');
    const gutterNumbers = readGutterNumbers(surface);
    expect(gutterNumbers).toContain('1000');
    // Gap markers are visible in BOTH the document and the gutter, and the
    // gutter entry is the marker itself — never an invented number.
    expect(gutterNumbers).toContain('⋯');
    expect(surface).toHaveTextContent('⋯');
    // NOTE: the second region (around line 5000) is deliberately NOT
    // asserted here. CodeMirror measures a zero-height editor under jsdom
    // and renders only its first viewport-worth of lines, so a far-down
    // region is absent from the DOM for reasons that have nothing to do
    // with slicing. Multi-region slicing is asserted directly against
    // `buildSlicedTextDiff` below, where nothing is virtualized.
  });

  it('falls back to the single read-only side when an over-threshold "full" diff has NO hunk ranges to slice around', async () => {
    // `StructuredFileDiff.hunks` is empty whenever no git unified diff was
    // computed — untracked whole-file additions and every journal-sourced
    // diff. There is then genuinely no way to locate the changes without
    // diffing the whole document, so the view must say so rather than
    // invent a region.
    const { modified, original } = buildLargeDocs([3000]);
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
      hunks: [],
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    expect(await screen.findByTestId('diff-too-large-note')).toHaveTextContent(
      'File too large to diff inline — showing content without change highlighting'
    );
    expect(screen.queryByTestId('diff-sliced-note')).toBeNull();
    const surface = await screen.findByTestId('diff');
    expect(surface.querySelectorAll('.cm-editor').length).toBe(1);
    expect(screen.queryByRole('button', { name: /switch to/iu })).toBeNull();
  });

  it('falls back to the single read-only side when the slice is itself still too large to diff', async () => {
    // One hunk covering the entire file slices to (almost) the entire file.
    // Mounting THAT would reintroduce the O(n·d) main-thread freeze the
    // thresholds exist to prevent, so the slice must be rejected.
    const { modified, original } = buildLargeDocs([3000]);
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
      hunks: [
        {
          newLines: LARGE_DOC_LINE_COUNT,
          newStart: 1,
          oldLines: LARGE_DOC_LINE_COUNT,
          oldStart: 1,
        },
      ],
    });

    render(<DiffView source={{ diff, kind: 'structured' }} testId="diff" />);

    expect(await screen.findByTestId('diff-too-large-note')).toBeTruthy();
    expect(screen.queryByTestId('diff-sliced-note')).toBeNull();
    const surface = await screen.findByTestId('diff');
    expect(surface.querySelectorAll('.cm-editor').length).toBe(1);
  });

  it('keeps the same CodeMirror DOM node across a parent re-render of a sliced diff (the memo is identity-stable)', async () => {
    const { hunks, modified, original } = buildLargeDocs([3000]);
    const diff = makeStructuredDiff({
      content: { kind: 'full', newContent: modified, oldContent: original },
      hunks,
    });

    function SlicedProbe() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((value) => value + 1)} type="button">
            bump {tick}
          </button>
          {/* Fresh `source` literal every render, same as the multi-file
              surface. The sliced-diff memo is the one OBJECT in the build
              effect's dependency array, so this is the control that it does
              not reintroduce the rebuild-on-every-render bug. */}
          <DiffView language="plain" source={{ diff, kind: 'structured' }} testId="diff" />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<SlicedProbe />);

    const surface = await screen.findByTestId('diff');
    expect(await screen.findByTestId('diff-sliced-note')).toBeTruthy();
    const editorBefore = surface.querySelector('.cm-editor');
    expect(editorBefore).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /bump/u }));
    await user.click(screen.getByRole('button', { name: /bump/u }));

    expect(surface.querySelector('.cm-editor')).toBe(editorBefore);
  });

  it('throws when neither `source` nor legacy `original`/`modified` props are given', () => {
    // Suppress React's expected error-boundary console noise for this assertion.
    vi.spyOn(console, 'error').mockImplementation(() => {
      // intentionally empty
    });
    expect(() => {
      // @ts-expect-error — `DiffViewProps` now enforces `source` XOR
      // `original`+`modified` at compile time; this exercises the runtime
      // backstop in `resolveDiffView` for anything that reaches the
      // component past that (an untyped caller, or a type escape).
      render(<DiffView testId="diff" />);
    }).toThrow();
  });
});

/**
 * Direct coverage for the slicing itself. The component tests above can only
 * assert what CodeMirror actually paints, and under jsdom every editor
 * measures zero-height and renders one viewport-worth of lines — which is
 * why multi-region behavior is pinned here instead.
 */
describe('buildSlicedTextDiff', () => {
  /** Lines 1..n as `line <n>`, with the given 1-based lines replaced. */
  function numberedDoc(lineCount: number, edits: ReadonlyMap<number, string> = new Map()): string {
    return `${Array.from(
      { length: lineCount },
      (_, index) => edits.get(index + 1) ?? `line ${index + 1}`
    ).join('\n')}\n`;
  }

  it('emits one region per scattered hunk, separated by gap markers, with absolute line maps', () => {
    const original = numberedDoc(300);
    const modified = numberedDoc(300, new Map([[100, 'line 100 CHANGED']]));
    const hunksKey = serializeHunkRanges([
      { newLines: 7, newStart: 97, oldLines: 7, oldStart: 97 },
      { newLines: 7, newStart: 247, oldLines: 7, oldStart: 247 },
    ]);

    const sliced = buildSlicedTextDiff(original, modified, hunksKey);

    expect(sliced).not.toBeNull();
    const lines = sliced?.modified.split('\n') ?? [];
    const map = sliced?.modifiedLineMap ?? [];
    // Leading gap (the file does not start at line 91), region one, gap,
    // region two, trailing gap (the file does not end at line 259).
    expect(lines[0]).toBe('⋯');
    expect(map[0]).toBe(0);
    expect(lines).toContain('line 100 CHANGED');
    expect(lines).toContain('line 250');
    // Region one is lines 91..109, region two 241..259 — the far region is
    // present, which is the whole point of per-hunk (not span) slicing.
    expect(map).toContain(91);
    expect(map).toContain(109);
    expect(map).toContain(241);
    expect(map).toContain(259);
    // ...and everything between the two regions is elided, not emitted.
    expect(map).not.toContain(150);
    expect(lines).not.toContain('line 150');
    // Exactly one map entry per emitted line, on both sides — the invariant
    // the gutter formatter depends on.
    expect(map.length).toBe(lines.length);
    expect(sliced?.originalLineMap.length).toBe(sliced?.original.split('\n').length);
    // The two sides elide at the SAME group boundaries — equal gap-marker
    // counts, so the regions correspond to each other. (Equal total line
    // counts is NOT an invariant: a hunk can add or remove lines.)
    const gapCount = (entries: readonly number[]): number =>
      entries.filter((entry) => entry === 0).length;
    expect(gapCount(sliced?.originalLineMap ?? [])).toBe(gapCount(map));
  });

  it('merges hunks whose context ranges touch into a single region (no gap marker between them)', () => {
    const original = numberedDoc(300);
    const modified = numberedDoc(300, new Map([[100, 'a']]));
    const hunksKey = serializeHunkRanges([
      { newLines: 1, newStart: 100, oldLines: 1, oldStart: 100 },
      { newLines: 1, newStart: 105, oldLines: 1, oldStart: 105 },
    ]);

    const sliced = buildSlicedTextDiff(original, modified, hunksKey);

    const map = sliced?.modifiedLineMap ?? [];
    // 94..111 contiguous — one leading and one trailing gap marker only.
    expect(map.filter((entry) => entry === 0).length).toBe(2);
    for (let line = 94; line <= 111; line += 1) {
      expect(map).toContain(line);
    }
  });

  it('emits the final line of a document that has no trailing newline', () => {
    // The forward cursor terminates on "no more line breaks" as well as on
    // "the break was the last character"; the first case is the only way the
    // last line gets emitted at all when the file is not newline-terminated.
    const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    const modified = original.replace('line 40', 'line 40 CHANGED');
    const hunksKey = serializeHunkRanges([
      { newLines: 1, newStart: 40, oldLines: 1, oldStart: 40 },
    ]);

    const sliced = buildSlicedTextDiff(original, modified, hunksKey);

    expect(sliced?.modified.split('\n').at(-1)).toBe('line 40 CHANGED');
    expect(sliced?.modifiedLineMap.at(-1)).toBe(40);
    // Nothing follows line 40, so there is no TRAILING elision to mark —
    // only the leading one, for lines 1..33.
    expect(sliced?.modifiedLineMap.filter((entry) => entry === 0).length).toBe(1);
    expect(sliced?.modifiedLineMap[0]).toBe(0);
  });

  it('keeps CRLF line endings byte-faithful and counts lines the way git does', () => {
    // Line boundaries are '\n' only, so a '\r' stays attached to its line
    // rather than being normalized away or shifting the numbering.
    const original = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\r\n')}\r\n`;
    const modified = original.replace('line 20', 'line 20 CHANGED');
    const hunksKey = serializeHunkRanges([
      { newLines: 1, newStart: 20, oldLines: 1, oldStart: 20 },
    ]);

    const sliced = buildSlicedTextDiff(original, modified, hunksKey);

    expect(sliced?.modified.split('\n')).toContain('line 20 CHANGED\r');
    // Line 20 is really line 20 — a CRLF-aware split would have kept the
    // same count here, but a '\r'-stripping one would not stay byte-faithful.
    const changedIndex = sliced?.modified.split('\n').indexOf('line 20 CHANGED\r') ?? -1;
    expect(sliced?.modifiedLineMap[changedIndex]).toBe(20);
  });

  it('returns null when there are no hunk ranges to slice around', () => {
    // The honest empty-hunks state: binary content, untracked whole-file
    // additions, and every journal-sourced diff. Nothing to locate.
    expect(buildSlicedTextDiff(numberedDoc(300), numberedDoc(300), '')).toBeNull();
  });

  it('throws on a malformed serialized hunk range rather than dropping the hunk', () => {
    // Silently skipping an unparseable entry would silently hide a change.
    expect(() => buildSlicedTextDiff('a\n', 'b\n', '1,2,3')).toThrow(/malformed serialized hunk/u);
    expect(() => buildSlicedTextDiff('a\n', 'b\n', '1,2,3,x')).toThrow(
      /malformed serialized hunk/u
    );
  });

  it('clamps a pure insertion at the very start of the file (oldStart 0) into range', () => {
    const original = numberedDoc(300);
    const modified = `inserted\n${numberedDoc(300)}`;
    const hunksKey = serializeHunkRanges([{ newLines: 1, newStart: 1, oldLines: 0, oldStart: 0 }]);

    const sliced = buildSlicedTextDiff(original, modified, hunksKey);

    expect(sliced?.modified.split('\n')[0]).toBe('inserted');
    expect(sliced?.modifiedLineMap[0]).toBe(1);
    // The old side starts at its real line 1 — `oldStart: 0` (git's "insert
    // before the first line") is clamped into range rather than emitted as a
    // fabricated line 0, and no leading gap marker is invented above it.
    expect(sliced?.originalLineMap[0]).toBe(1);
    expect(sliced?.original.split('\n')[0]).toBe('line 1');
  });
});

describe('createSlicedLineNumberFormatter', () => {
  it('maps document lines to absolute file lines and gap lines to the marker', () => {
    const format = createSlicedLineNumberFormatter([0, 91, 92, 0]);

    expect(format(1)).toBe('⋯');
    expect(format(2)).toBe('91');
    expect(format(3)).toBe('92');
    expect(format(4)).toBe('⋯');
  });

  it('answers CodeMirror’s out-of-document width probe with the widest real label', () => {
    // `@codemirror/view` calls `formatNumber` with 9/99/999/… to size the
    // gutter’s invisible spacer. That is not a line, and must neither throw
    // nor be reported as one.
    const format = createSlicedLineNumberFormatter([0, 9991, 9992]);

    expect(format(99)).toBe('9991');
  });
});
