import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  existingProfileLocationForCanonicalRoot,
  joinProfileDirectory,
} from '../node-workspace-services.js';

test('round-trips the explicit existing canonical selected profile without choosing a default', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'bs-existing-profile-location-'));
  try {
    const rootPath = await realpath(fixture);
    const directory = joinProfileDirectory(rootPath, 'selected');
    await mkdir(directory, { recursive: true });
    expect(await existingProfileLocationForCanonicalRoot(directory)).toEqual({
      profile: 'selected',
      rootPath,
      source: 'override',
    });
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test('refuses absent, relative, non-profile and presentation-alias paths without creating a profile', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'bs-invalid-profile-location-'));
  try {
    const rootPath = await realpath(fixture);
    const directory = joinProfileDirectory(rootPath, 'selected');
    await mkdir(directory, { recursive: true });
    const alias = path.join(rootPath, 'profile-alias');
    await symlink(directory, alias, 'dir');
    for (const candidate of [
      'relative',
      rootPath,
      joinProfileDirectory(rootPath, 'absent'),
      alias,
    ]) {
      await expect(existingProfileLocationForCanonicalRoot(candidate)).rejects.toThrow();
    }
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
