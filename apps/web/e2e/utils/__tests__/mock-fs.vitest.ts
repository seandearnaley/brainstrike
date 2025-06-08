import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { mockBrowserApis } from '../mock-fs';

describe('mockBrowserApis', () => {
  it('initializes browser APIs without clipboard', async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const page = { addInitScript } as unknown as Page;

    await mockBrowserApis(page, 'root', { foo: null });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalledWith(
      expect.any(Function),
      {
        rootName: 'root',
        tree: { foo: null },
        enableClipboard: false,
      },
    );
  });

  it('passes clipboard option', async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const page = { addInitScript } as unknown as Page;

    await mockBrowserApis(page, 'root', { foo: null }, { clipboard: true });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalledWith(
      expect.any(Function),
      {
        rootName: 'root',
        tree: { foo: null },
        enableClipboard: true,
      },
    );
  });
});
