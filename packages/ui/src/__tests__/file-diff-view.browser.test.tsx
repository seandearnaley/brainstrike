import './diff-review.browser.css';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { FileDiffView } from '../diff-view';
import { ThemeProvider } from '../theme-provider';

afterEach(cleanup);

function file(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `const line${index + 1} = ${index + 1};\n`
  ).join('');
}

function Diff({
  after,
  before,
}: {
  readonly after: string | null;
  readonly before: string | null;
}) {
  return (
    <ThemeProvider defaultMode="light">
      <div style={{ height: 400, width: 700 }}>
        <FileDiffView
          after={after}
          ariaLabel="Proposed change"
          before={before}
          path="src/lines.ts"
        />
      </div>
    </ThemeProvider>
  );
}

/** The numbered lines the diff draws, in order: each line's number and kind. */
function drawnLines(): { readonly kind: string | undefined; readonly line: number }[] {
  return [...document.querySelectorAll('diffs-container')].flatMap((host) =>
    [
      ...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]') ??
        []),
    ].map((cell) => ({
      kind: cell.dataset['lineType'],
      line: Number(cell.dataset['columnNumber']),
    }))
  );
}

test('a one-line change in a long file shows that line by its own number, not the whole file', async () => {
  const before = file(200);
  render(<Diff after={before.replace('line100 = 100;', 'line100 = 1000;')} before={before} />);
  await expect.element(page.getByText('const line100 = 1000;')).toBeVisible();
  const lines = drawnLines();
  expect(lines).toContainEqual({ kind: 'change-deletion', line: 100 });
  expect(lines).toContainEqual({ kind: 'change-addition', line: 100 });
  expect(lines.length).toBeLessThan(12);
  expect(page.getByText('const line1 = 1;', { exact: true }).query()).toBeNull();
});

test('the unchanged lines before a change expand in place', async () => {
  const before = file(200);
  render(<Diff after={before.replace('line100 = 100;', 'line100 = 1000;')} before={before} />);
  await expect.element(page.getByText('const line100 = 1000;')).toBeVisible();
  const expand = document
    .querySelector('diffs-container')
    ?.shadowRoot?.querySelector<HTMLElement>('[data-expand-button]');
  if (!expand) {
    throw new Error('Expected a control that expands the unchanged lines');
  }
  await page.elementLocator(expand).click();
  await expect.element(page.getByText('const line1 = 1;', { exact: true })).toBeVisible();
  expect(drawnLines().map(({ line }) => line)).toContain(1);
});

test('a new file is all additions', async () => {
  render(<Diff after={file(3)} before={null} />);
  await expect.element(page.getByText('const line3 = 3;')).toBeVisible();
  expect(drawnLines()).toEqual([1, 2, 3].map((line) => ({ kind: 'change-addition', line })));
});

test('a deleted file is all deletions', async () => {
  render(<Diff after={null} before={file(3)} />);
  await expect.element(page.getByText('const line3 = 3;')).toBeVisible();
  expect(drawnLines()).toEqual([1, 2, 3].map((line) => ({ kind: 'change-deletion', line })));
});

test('a very large new file draws only the lines in view', async () => {
  render(<Diff after={file(50_000)} before={null} />);
  await expect.element(page.getByText('const line1 = 1;', { exact: true })).toBeVisible();
  expect(drawnLines().length).toBeLessThan(200);
});

test('a short change sizes its box to its lines, and a long one stops at the cap', async () => {
  const capped = (after: string) => (
    <ThemeProvider defaultMode="light">
      <div style={{ width: 700 }}>
        <FileDiffView
          after={after}
          ariaLabel="Proposed change"
          before={null}
          className="max-h-[288px]"
          path="src/lines.ts"
          testId="capped"
        />
      </div>
    </ThemeProvider>
  );
  const box = () => document.querySelector('[data-testid="capped"]')?.getBoundingClientRect();
  const { rerender } = render(capped(file(3)));
  await expect.element(page.getByText('const line3 = 3;')).toBeVisible();
  const short = box()?.height ?? 0;
  expect(short).toBeGreaterThan(0);
  expect(short).toBeLessThan(150);

  rerender(capped(file(500)));
  await expect.poll(() => box()?.height).toBe(288);
});

test('a rewrite of thousands of lines says so at once instead of diffing them', async () => {
  const before = file(5000);
  const started = performance.now();
  render(<Diff after={before.replaceAll('const', 'let')} before={before} />);
  await expect.element(page.getByText('Too many lines changed to show.')).toBeVisible();
  expect(performance.now() - started).toBeLessThan(2000);
  expect(drawnLines()).toEqual([]);
});
