import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trashEveryScratchFolder, trashScratchFolder } from '../scratch-folder-trash';

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

  it("names the system's reason when the Trash refuses the folder", async () => {
    const canonical = realpathSync(path.join(userData, 'scratch', 'quiet-otter'));
    const trash = vi.fn(async () => {
      throw new Error('Failed to move item to the trash');
    });

    await expect(trashScratchFolder(userData, canonical, trash)).rejects.toMatchObject({
      failure: {
        code: 'workspace.trash-failed',
        message: `${canonical} was not moved to the Trash: Failed to move item to the trash`,
      },
    });
  });

  it('moves nothing for a relative path', async () => {
    const trash = vi.fn(async () => undefined);

    await expect(
      trashScratchFolder(userData, path.join('scratch', 'quiet-otter'), trash)
    ).rejects.toMatchObject({ failure: { code: 'workspace.scratch-outside' } });
    expect(trash).not.toHaveBeenCalled();
  });
});

// ADR-0034, ADR-0015: Clear Database deletes every scratch thread's row, so once the clear has
// succeeded Main moves every scratch folder to the Trash, through the same guard.
describe('trashEveryScratchFolder', () => {
  it('moves each folder directly inside scratch to the Trash, and nothing else', async () => {
    mkdirSync(path.join(userData, 'scratch', 'brave-heron'));
    writeFileSync(path.join(userData, 'scratch', 'notes.txt'), 'not a folder\n');
    symlinkSync(path.join(userData, 'elsewhere'), path.join(userData, 'scratch', 'linked'));
    const trash = vi.fn(async (_folder: string) => undefined);

    const result = await trashEveryScratchFolder(userData, trash);

    const scratch = realpathSync(path.join(userData, 'scratch'));
    expect(trash.mock.calls.map(([folder]) => folder).sort()).toEqual([
      path.join(scratch, 'brave-heron'),
      path.join(scratch, 'quiet-otter'),
    ]);
    expect([...result.trashed].sort()).toEqual([
      path.join(userData, 'scratch', 'brave-heron'),
      path.join(userData, 'scratch', 'quiet-otter'),
    ]);
    expect(result.retained).toEqual([]);
  });

  it('moves nothing, and fails nothing, when there is no scratch folder', async () => {
    rmSync(path.join(userData, 'scratch'), { force: true, recursive: true });
    const trash = vi.fn(async () => undefined);

    await expect(trashEveryScratchFolder(userData, trash)).resolves.toEqual({
      retained: [],
      trashed: [],
    });
    expect(trash).not.toHaveBeenCalled();
  });

  it('names a folder the Trash refuses, with why, and still moves the rest', async () => {
    mkdirSync(path.join(userData, 'scratch', 'brave-heron'));
    const scratch = realpathSync(path.join(userData, 'scratch'));
    const trash = vi.fn(async (folder: string) => {
      if (folder.endsWith('quiet-otter')) {
        throw new Error('Failed to move item to the trash');
      }
    });

    const result = await trashEveryScratchFolder(userData, trash);

    expect(result).toEqual({
      retained: [
        {
          path: path.join(userData, 'scratch', 'quiet-otter'),
          reason: `${path.join(scratch, 'quiet-otter')} was not moved to the Trash: Failed to move item to the trash`,
        },
      ],
      trashed: [path.join(userData, 'scratch', 'brave-heron')],
    });
  });
});
