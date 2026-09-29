import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface ManifestOverrides {
  readonly sha256?: string;
  readonly supportedTargets?: readonly string[];
  readonly targets?: Record<string, { bytes: number; sha256: string }> | undefined;
}

export const ARCHIVE_CONTENT = 'not-a-real-tarball-but-hashable';
export const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE_CONTENT).digest('hex');
export const RELEASE_TAG = '20260728';
export const PYTHON_VERSION = '3.13.14';
export const TRIPLE = 'aarch64-apple-darwin';
export const ARCHIVE_FILE_NAME = `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${TRIPLE}-install_only.tar.gz`;

export async function createFixtureDirs(
  cleanupPaths: string[]
): Promise<{ resourcesDir: string; userDataDir: string }> {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-runtime-'));
  cleanupPaths.push(fixture);
  const resourcesDir = path.join(fixture, 'resources');
  const userDataDir = path.join(fixture, 'user-data');
  mkdirSync(resourcesDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  return { resourcesDir, userDataDir };
}

export function writeManifest(resourcesDir: string, overrides: ManifestOverrides = {}): void {
  const manifest = {
    assetUrlTemplate:
      'https://github.com/astral-sh/python-build-standalone/releases/download/{releaseTag}/cpython-{pythonVersion}+{releaseTag}-{target}-{variant}.tar.gz',
    pythonVersion: PYTHON_VERSION,
    releaseTag: RELEASE_TAG,
    supportedTargets: overrides.supportedTargets ?? [TRIPLE, 'x86_64-apple-darwin'],
    targets:
      'targets' in overrides
        ? overrides.targets
        : {
            [TRIPLE]: { bytes: ARCHIVE_CONTENT.length, sha256: overrides.sha256 ?? ARCHIVE_SHA256 },
            'x86_64-apple-darwin': { bytes: 1, sha256: 'f'.repeat(64) },
          },
    variant: 'install_only',
  };
  writeFileSync(path.join(resourcesDir, 'manifest.json'), JSON.stringify(manifest));
}

export function writeArchive(resourcesDir: string): void {
  writeFileSync(path.join(resourcesDir, ARCHIVE_FILE_NAME), ARCHIVE_CONTENT);
}

export function installDirFor(userDataDir: string): string {
  return path.join(
    userDataDir,
    'python-runtime',
    `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${TRIPLE}`
  );
}

/** Materializes the layout tar would produce, so the mock stays a pure spawn stub. */
export function plantUnpackedRuntime(targetDir: string): string {
  const binDir = path.join(targetDir, 'python', 'bin');
  mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, 'python3');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);
  return binary;
}
