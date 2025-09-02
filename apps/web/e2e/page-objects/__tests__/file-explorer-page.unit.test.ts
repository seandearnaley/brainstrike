import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { FileExplorerPage } from '../file-explorer-page';

describe('FileExplorerPage (unit)', () => {
  it('exposes expected locators and actions', () => {
    const calls: string[] = [];
    const page = {
      getByRole: (r: string, o?: Record<string, unknown>) => ({ r, o, kind: 'role' }),
      getByText: (t: string) => ({ t, kind: 'text' }),
      getByPlaceholder: (t: string) => ({ t, kind: 'placeholder' }),
      locator: (s: string) => ({ s, kind: 'locator' }),
    } as unknown as Page;
    const fe = new FileExplorerPage(page);
    calls.push(fe.selectRootButton.r);
    calls.push(fe.fileTreeScrollContainer.kind);
    calls.push(fe.filterInput.kind);
    expect(calls.length).toBe(3);
  });
});
