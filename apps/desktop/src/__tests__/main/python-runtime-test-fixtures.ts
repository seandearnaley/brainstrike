import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PYTHON_RUNTIME_SENTINEL_FILE_NAME,
  type PythonRuntimeManifestTarget,
} from '../../python-runtime/resolve-python-binary';

interface ManifestOverrides {
  readonly sha256?: string;
  readonly supportedTargets?: readonly string[];
  readonly targets?: Record<string, PythonRuntimeManifestTarget> | undefined;
}

export const ARCHIVE_SHA256 = 'a'.repeat(64);
export const RELEASE_TAG = '20260728';
export const PYTHON_VERSION = '3.13.14';
export const TRIPLE = 'aarch64-apple-darwin';
export const OTHER_TRIPLE = 'x86_64-apple-darwin';

/** A disposable manifest dir and an empty per-target install dir beneath it. */
export async function createFixtureDirs(
  cleanupPaths: string[],
  unpackDir = 'darwin-arm64'
): Promise<{ installDir: string; manifestDir: string }> {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-runtime-'));
  cleanupPaths.push(fixture);
  const manifestDir = path.join(fixture, 'resources');
  const installDir = path.join(manifestDir, 'unpacked', unpackDir);
  mkdirSync(installDir, { recursive: true });
  return { installDir, manifestDir };
}

export function writeManifest(manifestDir: string, overrides: ManifestOverrides = {}): void {
  const manifest = {
    assetUrlTemplate:
      'https://github.com/astral-sh/python-build-standalone/releases/download/{releaseTag}/cpython-{pythonVersion}+{releaseTag}-{target}-{variant}.tar.gz',
    pythonVersion: PYTHON_VERSION,
    releaseTag: RELEASE_TAG,
    supportedTargets: overrides.supportedTargets ?? [TRIPLE, OTHER_TRIPLE],
    targets:
      'targets' in overrides
        ? overrides.targets
        : {
            [TRIPLE]: { bytes: 25_272_160, sha256: overrides.sha256 ?? ARCHIVE_SHA256 },
            [OTHER_TRIPLE]: { bytes: 1, sha256: 'f'.repeat(64) },
          },
    variant: 'install_only',
  };
  writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest));
}

/**
 * Overwrites top-level fields of a manifest already written by `writeManifest`.
 * `JSON.stringify` omits `undefined`-valued keys, so patching a field to
 * `undefined` drops it from the JSON exactly like `delete` would.
 */
export function patchManifest(manifestDir: string, patch: Record<string, unknown>): string {
  const manifestPath = path.join(manifestDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...patch }));
  return manifestPath;
}

/** Materializes the layout the build-time unpack produces. */
export function plantUnpackedRuntime(installDir: string, sentinelSha256 = ARCHIVE_SHA256): string {
  const binDir = path.join(installDir, 'python', 'bin');
  mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, 'python3');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);
  writeFileSync(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), `${sentinelSha256}\n`);
  return binary;
}
