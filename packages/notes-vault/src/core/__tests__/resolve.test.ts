import { describe, expect, it } from 'vitest';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { getDirectoryHandleAt, getFileHandleAt } from '../resolve';

describe('handle resolution', () => {
  const root = fakeDir('vault', [
    fakeDir('assets', [fakeNote('pic.png', { content: 'binary' })]),
    fakeDir('a', [fakeDir('b', [fakeNote('deep.md')])]),
  ]);

  it('walks directory segments', async () => {
    const dir = await getDirectoryHandleAt(root, ['a', 'b']);
    expect(dir.name).toBe('b');
    await expect(getDirectoryHandleAt(root, [])).resolves.toBe(root);
  });

  it('resolves a file by segments', async () => {
    const file = await getFileHandleAt(root, ['assets', 'pic.png']);
    expect(file.name).toBe('pic.png');
  });

  it('rejects on missing paths and empty file segments', async () => {
    await expect(getFileHandleAt(root, ['assets', 'missing.png'])).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    await expect(getFileHandleAt(root, [])).rejects.toThrow(/empty/i);
  });
});
