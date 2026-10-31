/**
 * How a diff reads in real Chromium: changed words are a fill of the line's
 * own hue, never the coloured 2px underline `@codemirror/merge`'s base theme
 * draws under them, and a side-by-side diff taller than its box scrolls
 * inside it rather than being cut off at the bottom.
 */
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DiffView } from '../diff-view';
import './diff-view-line-comments.browser.css';

const ORIGINAL = 'const host = "localhost";\nconst port = 3000;\n';
const MODIFIED = 'const host = "127.0.0.1";\nconst port = 8080;\n';

test.each(['split', 'unified'] as const)(
  '%s diff marks changed words without an underline',
  async (mode) => {
    render(
      <div style={{ height: 300 }}>
        <DiffView defaultMode={mode} modified={MODIFIED} original={ORIGINAL} testId="diff" />
      </div>
    );
    await expect
      .poll(() => document.querySelectorAll('[data-testid="diff"] .cm-changedText').length)
      .toBeGreaterThan(0);
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-testid="diff"] .cm-changedText, [data-testid="diff"] .cm-deletedText'
    )) {
      const style = getComputedStyle(element);
      expect(style.backgroundImage).toBe('none');
      expect(style.textDecorationLine).toBe('none');
    }
  }
);

test('a side-by-side diff taller than its box scrolls to its end inside the box', async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
  const original = `${lines.join('\n')}\n`;
  // Every line changes, so no unchanged run collapses the document.
  const modified = `${lines.map((line) => `${line}!`).join('\n')}\n`;
  render(
    <div style={{ display: 'flex', flexDirection: 'column', height: 300 }}>
      <DiffView modified={modified} original={original} testId="diff" />
    </div>
  );
  const box = document.querySelector<HTMLElement>('[data-testid="diff"] section');
  await expect
    .poll(() => document.querySelector('[data-testid="diff"] .cm-mergeView'))
    .not.toBeNull();
  const scroller = document.querySelector<HTMLElement>('[data-testid="diff"] .cm-mergeView');
  if (!(box && scroller)) {
    throw new Error('diff did not mount');
  }
  // The split view, not its clipping host, owns the vertical scroll.
  expect(scroller.clientHeight).toBeLessThanOrEqual(box.clientHeight);
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  scroller.scrollTop = scroller.scrollHeight;
  expect(scroller.scrollTop + scroller.clientHeight).toBe(scroller.scrollHeight);
});
