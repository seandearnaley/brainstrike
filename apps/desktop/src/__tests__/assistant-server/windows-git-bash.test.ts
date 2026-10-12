import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { resolveWindowsGitBash } from '../../assistant-server/windows-git-bash';

afterEach(() => vi.restoreAllMocks());

function installed(files: readonly string[]): void {
  vi.spyOn(fs, 'stat').mockImplementation(async (file) => {
    if (files.includes(String(file))) {
      return { isFile: () => true } as Stats;
    }
    throw Object.assign(new Error('File absent'), { code: 'ENOENT' });
  });
}

test('selects installed Git Bash even when WSL bash precedes it on PATH', async () => {
  installed([
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ]);
  await expect(
    resolveWindowsGitBash({ PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' })
  ).resolves.toBe('C:\\Program Files\\Git\\bin\\bash.exe');
});

test('resolves a portable Git installation from its quoted cmd path', async () => {
  installed(['D:\\Portable Git\\cmd\\git.exe', 'D:\\Portable Git\\bin\\bash.exe']);
  await expect(
    resolveWindowsGitBash({ PATH: 'C:\\Windows\\System32;"D:\\Portable Git\\cmd"' })
  ).resolves.toBe('D:\\Portable Git\\bin\\bash.exe');
});

test('resolves a per-user Git installation', async () => {
  installed(['C:\\Local\\Programs\\Git\\cmd\\git.exe', 'C:\\Local\\Programs\\Git\\bin\\bash.exe']);
  await expect(resolveWindowsGitBash({ LOCALAPPDATA: 'C:\\Local' })).resolves.toBe(
    'C:\\Local\\Programs\\Git\\bin\\bash.exe'
  );
});

test('refuses WSL or a standalone bash without a Git installation', async () => {
  installed(['C:\\Windows\\System32\\bash.exe', 'D:\\Other\\bin\\bash.exe']);
  await expect(
    resolveWindowsGitBash({ PATH: 'C:\\Windows\\System32;D:\\Other\\bin;.\\bin' })
  ).rejects.toThrow('requires Git for Windows');
});
