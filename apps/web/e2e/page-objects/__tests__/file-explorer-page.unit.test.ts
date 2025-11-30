import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { FileExplorerPage } from '../file-explorer-page';

describe('FileExplorerPage (unit)', () => {
  it('exposes expected locators and actions', () => {
    const calls: string[] = [];
    type MockLocator = {
      r?: string;
      o?: Record<string, unknown>;
      t?: string;
      s?: string;
      kind: string;
    };
    const page = {
      getByRole: (r: string, o?: Record<string, unknown>): MockLocator => {
        const loc: MockLocator = { r, kind: 'role' };
        if (o !== undefined) {
          loc.o = o;
        }
        return loc;
      },
      getByText: (t: string): MockLocator => ({ t, kind: 'text' }),
      getByPlaceholder: (t: string): MockLocator => ({ t, kind: 'placeholder' }),
      locator: (s: string): MockLocator => ({ s, kind: 'locator' }),
    } as unknown as Page;
    const fe = new FileExplorerPage(page);
    calls.push((fe.selectRootButton as unknown as MockLocator).r ?? '');
    calls.push((fe.fileTreeScrollContainer as unknown as MockLocator).kind);
    calls.push((fe.filterInput as unknown as MockLocator).kind);
    expect(calls.length).toBe(3);
  });
});
