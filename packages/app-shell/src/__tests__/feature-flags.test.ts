import { describe, expect, it } from 'vitest';
import { isFileExplorerV2Enabled } from '../feature-flags';

describe('feature flags', () => {
  it('parses VITE_FILE_EXPLORER_V2 from process.env', () => {
    const old = process.env.VITE_FILE_EXPLORER_V2;
    process.env.VITE_FILE_EXPLORER_V2 = '1';
    expect(isFileExplorerV2Enabled()).toBe(true);
    process.env.VITE_FILE_EXPLORER_V2 = 'true';
    expect(isFileExplorerV2Enabled()).toBe(true);
    process.env.VITE_FILE_EXPLORER_V2 = '0';
    expect(isFileExplorerV2Enabled()).toBe(false);
    if (old === undefined) {
      // Restore to undefined state without delete operator
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error allow cleanup for test env
      process.env.VITE_FILE_EXPLORER_V2 = undefined;
    } else {
      process.env.VITE_FILE_EXPLORER_V2 = old;
    }
  });
});
