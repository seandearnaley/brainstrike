import { describe, expect, it } from 'vitest';
import { isBinaryFile, isTextFile } from '../file-utils';

describe('file-utils', () => {
  it('treats svg files as text', () => {
    expect(isTextFile('icon.svg')).toBe(true);
    expect(isBinaryFile('icon.svg')).toBe(false);
  });
});
