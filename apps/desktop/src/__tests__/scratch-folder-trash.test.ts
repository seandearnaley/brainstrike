import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trashScratchFolder } from '../scratch-folder-trash';

// ADR-0034 scratch threads: Main moves a deleted thread's scratch folder to the Trash for the
// host, and nothing else: only a folder directly inside `<userData>/scratch`.
let base: string;
let userData: string;

beforeEach(() => {
  // A disposable profile, reached through the OS temp folder's own spelling (a symlink on macOS).
  base = mkdtempSync(path.join(tmpdir(), 'bs-scratch-trash-'));
  userData = path.join(base, 'profile');
  for (const folder of ['scratch/quiet-otter/src', 'settings', 'elsewhere']) {
    mkdirSync(path.join(userData, folder), { recursive: true });
  }
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

describe('trashScratchFolder', () => {
  it('moves a scratch folder to the Trash, named as the host records it', async () => {
    const trash = vi.fn(async () => undefined);
    const canonical = realpathSync(path.join(userData, 'scratch', 'quiet-otter'));

    await trashScratchFolder(userData, canonical, trash);

    expect(trash).toHaveBeenCalledWith(canonical);
  });

  it.each([
    ['the scratch folder itself', ['scratch']],
    ['the profile', []],
    ['a folder inside a scratch folder', ['scratch', 'quiet-otter', 'src']],
    ['a folder that climbs out', ['scratch', '..', 'settings']],
    ['a folder that is not there', ['scratch', 'brave-heron']],
    ['a link inside scratch to a folder elsewhere', ['scratch', 'linked']],
  ])('moves nothing for %s', async (_name, segments) => {
    symlinkSync(path.join(userData, 'elsewhere'), path.join(userData, 'scratch', 'linked'));
    const trash = vi.fn(async () => undefined);

    await expect(
      trashScratchFolder(userData, path.join(userData, ...segments), trash)
    ).rejects.toMatchObject({ failure: { code: 'workspace.scratch-outside' } });
    expect(trash).not.toHaveBeenCalled();
  });

  it('moves nothing for a relative path', async () => {
    const trash = vi.fn(async () => undefined);

    await expect(
      trashScratchFolder(userData, path.join('scratch', 'quiet-otter'), trash)
    ).rejects.toMatchObject({ failure: { code: 'workspace.scratch-outside' } });
    expect(trash).not.toHaveBeenCalled();
  });
});
