import { describe, expect, it } from 'vitest';
import { fakeDir } from '../../__tests__/support/fake-handles';
import { queryVaultPermission, requestVaultPermission } from '../permissions';
import type { VaultDirectoryHandleLike } from '../types';

describe('vault permissions', () => {
  it('queries without prompting', async () => {
    const granted = fakeDir('a');
    granted.permissionState = 'granted';
    const prompt = fakeDir('b');
    prompt.permissionState = 'prompt';

    await expect(queryVaultPermission(granted)).resolves.toBe('granted');
    await expect(queryVaultPermission(prompt)).resolves.toBe('prompt');
  });

  it('requestVaultPermission surfaces the user decision', async () => {
    const dir = fakeDir('a');
    dir.permissionState = 'prompt';
    dir.requestOutcome = 'granted';
    await expect(requestVaultPermission(dir)).resolves.toBe('granted');
    expect(dir.permissionState).toBe('granted');

    const denied = fakeDir('b');
    denied.permissionState = 'prompt';
    denied.requestOutcome = 'denied';
    await expect(requestVaultPermission(denied)).resolves.toBe('denied');
  });

  it('throws when a handle lacks the permission API instead of assuming access', async () => {
    const bare: VaultDirectoryHandleLike = {
      getDirectoryHandle: () => Promise.reject(new Error('unused')),
      getFileHandle: () => Promise.reject(new Error('unused')),
      isSameEntry: () => Promise.resolve(false),
      kind: 'directory',
      name: 'no-permission-api',
      values: fakeDir('x').values.bind(fakeDir('x')),
    };

    await expect(queryVaultPermission(bare)).rejects.toThrow(/permission/i);
    await expect(requestVaultPermission(bare)).rejects.toThrow(/permission/i);
  });
});
