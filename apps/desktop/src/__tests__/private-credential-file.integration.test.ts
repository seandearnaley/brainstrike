import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  readPrivateCredentialFile,
  writePrivateCredentialFile,
} from '../agent-host-platform/private-credential-file.js';

const execute = promisify(execFile);
const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-private-desktop-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it('reads only missing paths as undefined and creates only on mutation', async () => {
  const root = await fixture();
  const path = join(root, '$(); credential.json');
  expect(await readPrivateCredentialFile(path)).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
  expect(
    await readPrivateCredentialFile(join(root, 'missing-parent', 'file.json'))
  ).toBeUndefined();
  await writePrivateCredentialFile(path, 'fake first');
  expect(await readPrivateCredentialFile(path)).toBe('fake first');
  await writePrivateCredentialFile(path, 'fake second');
  expect(await readPrivateCredentialFile(path)).toBe('fake second');
  expect(await readdir(root)).toEqual(['$(); credential.json']);
});

it('rejects a nonprivate file without changing its bytes', async () => {
  const root = await fixture();
  const path = join(root, 'public.json');
  await writeFile(path, 'fake public', { mode: 0o644 });
  await expect(readPrivateCredentialFile(path)).rejects.toThrow();
  await expect(writePrivateCredentialFile(path, 'fake rejected')).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('fake public');
  expect(await readdir(root)).toEqual(['public.json']);
});

it('refuses a credential symlink, including dangling links, and preserves its target', async () => {
  const root = await fixture();
  const target = join(root, 'target.json');
  await writePrivateCredentialFile(target, 'fake retained');
  for (const [name, destination] of [
    ['link.json', target],
    ['dangling.json', join(root, 'absent.json')],
  ] as const) {
    const path = join(root, name);
    await symlink(destination, path, 'file');
    await expect(readPrivateCredentialFile(path)).rejects.toThrow();
    await expect(writePrivateCredentialFile(path, 'fake rejected')).rejects.toThrow();
  }
  expect(await readPrivateCredentialFile(target)).toBe('fake retained');
  expect((await readdir(root)).sort()).toEqual(['dangling.json', 'link.json', 'target.json']);
});

it('rejects nonregular files, invalid absolute paths and failed parent traversal', async () => {
  const root = await fixture();
  const directory = join(root, 'directory');
  await mkdir(directory);
  await expect(readPrivateCredentialFile(directory)).rejects.toThrow();
  await expect(writePrivateCredentialFile(directory, 'fake rejected')).rejects.toThrow();
  for (const path of ['relative.json', `${root}\0.json`]) {
    await expect(readPrivateCredentialFile(path)).rejects.toThrow(TypeError);
    await expect(writePrivateCredentialFile(path, 'fake rejected')).rejects.toThrow(TypeError);
  }
  const regular = join(root, 'regular.json');
  await writePrivateCredentialFile(regular, 'fake retained');
  await expect(readPrivateCredentialFile(join(regular, 'child.json'))).rejects.toThrow();
  await expect(
    writePrivateCredentialFile(join(root, 'absent-parent', 'child.json'), 'fake rejected')
  ).rejects.toThrow();
  expect(await readPrivateCredentialFile(regular)).toBe('fake retained');
});

it.skipIf(process.platform === 'win32')('requires exact POSIX 0600 permissions', async () => {
  const root = await fixture();
  const path = join(root, 'credential.json');
  await writePrivateCredentialFile(path, 'fake retained');
  for (const mode of [0o644, 0o400, 0o700]) {
    await chmod(path, mode);
    await expect(readPrivateCredentialFile(path)).rejects.toThrow();
  }
});

it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
  const root = await fixture();
  const path = join(root, 'fifo');
  await execute('mkfifo', [path]);
  await expect(readPrivateCredentialFile(path)).rejects.toThrow();
  await expect(writePrivateCredentialFile(path, 'fake rejected')).rejects.toThrow();
});
