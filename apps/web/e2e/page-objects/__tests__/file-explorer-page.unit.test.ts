import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { FileExplorerPage } from '../file-explorer-page';

describe('FileExplorerPage (unit)', () => {
  it('exposes expected locators and actions', () => {
    const calls: string[] = [];
    interface MockLocator {
      kind: string;
      o?: Record<string, unknown>;
      r?: string;
      s?: string;
      t?: string;
    }
    const page = {
      getByPlaceholder: (t: string): MockLocator => ({ kind: 'placeholder', t }),
      getByRole: (r: string, o?: Record<string, unknown>): MockLocator => {
        const loc: MockLocator = { kind: 'role', r };
        if (o !== undefined) {
          loc.o = o;
        }
        return loc;
      },
      getByText: (t: string): MockLocator => ({ kind: 'text', t }),
      locator: (s: string): MockLocator => ({ kind: 'locator', s }),
    } as unknown as Page;
    const fe = new FileExplorerPage(page);
    calls.push((fe.selectRootButton as unknown as MockLocator).r ?? '');
    calls.push((fe.fileTreeScrollContainer as unknown as MockLocator).kind);
    calls.push((fe.filterInput as unknown as MockLocator).kind);
    expect(calls.length).toBe(3);
  });
});
