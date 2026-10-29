import './scroll-area-max-height.browser.css';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ScrollArea } from '../scroll-area';

afterEach(cleanup);

test('a scroll area capped by max-height scrolls its last row into view', () => {
  render(
    <ScrollArea className="max-h-[200px]">
      {Array.from({ length: 40 }, (_, index) => `Row ${index}`).map((row) => (
        <div key={row} style={{ height: 40 }}>
          {row}
        </div>
      ))}
    </ScrollArea>
  );
  const last = screen.getByText('Row 39');
  const viewport = last.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const root = last.closest<HTMLElement>('[data-slot="scroll-area"]');
  if (!(viewport && root)) {
    throw new Error('The row is not inside a scroll area viewport');
  }

  viewport.scrollTop = viewport.scrollHeight;

  expect(viewport.clientHeight).toBe(200);
  const rootBox = root.getBoundingClientRect();
  const rowBox = last.getBoundingClientRect();
  expect(rowBox.top).toBeGreaterThanOrEqual(rootBox.top);
  expect(rowBox.bottom).toBeLessThanOrEqual(rootBox.bottom);
});
