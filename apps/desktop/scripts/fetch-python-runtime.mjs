#!/usr/bin/env node
// BST-1061: build-time fetch of the pinned python-build-standalone CPython
// tarballs into resources/python-runtime/, verified against the checksums in
// manifest.json. Runs from the desktop `build` script — deliberately NOT
// `postinstall` (Electron 42 removed its own postinstall for supply-chain
// reasons; this repo matches that posture). A hash or size mismatch deletes
// the download and fails the build loudly; there is no skip flag.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { derivePythonRuntimeArchive } from './derive-python-runtime.mjs';

const defaultResourcesDir = path.resolve(import.meta.dirname, '../resources/python-runtime');
// PR #2205 review: the original call had no AbortSignal/timeout at all, so a
// GitHub Releases stall hung to whatever timeout wrapped this whole script
// (a CI job timeout, if any) instead of failing fast with a clear message.
// 25MB over any non-broken connection finishes in well under this.
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`python-runtime: download of ${url} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function renderAssetUrl(manifest, target) {
  return manifest.assetUrlTemplate
    .replaceAll('{releaseTag}', manifest.releaseTag)
    .replaceAll('{pythonVersion}', manifest.pythonVersion)
    .replaceAll('{target}', target)
    .replaceAll('{variant}', manifest.variant);
}

async function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function verifyArchive({ entry, filePath, label }) {
  const stats = await fsPromises.stat(filePath);
  if (stats.size !== entry.bytes) {
    throw new Error(
      `${label}: expected ${entry.bytes} bytes but found ${stats.size}. Refusing to keep it.`
    );
  }
  const actual = await hashFileSha256(filePath);
  if (actual !== entry.sha256) {
    throw new Error(
      `${label}: sha256 mismatch (expected ${entry.sha256}, got ${actual}). Refusing to keep it.`
    );
  }
}

async function archiveAlreadyVerifies({ destPath, entry }) {
  try {
    await verifyArchive({ entry, filePath: destPath, label: destPath });
    return true;
  } catch {
    return false;
  }
}

function loadManifestTargets(manifest, manifestPath) {
  if (
    !Array.isArray(manifest.supportedTargets) ||
    manifest.supportedTargets.length === 0 ||
    typeof manifest.assetUrlTemplate !== 'string' ||
    typeof manifest.targets !== 'object' ||
    manifest.targets === null
  ) {
    throw new Error(`Malformed python-runtime manifest at ${manifestPath}.`);
  }
  return manifest.supportedTargets.map((target) => {
    const entry = manifest.targets[target];
    if (
      typeof entry?.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry?.bytes) ||
      entry.bytes <= 0
    ) {
      throw new Error(
        `Malformed python-runtime manifest at ${manifestPath}: bad entry for "${target}".`
      );
    }
    if (entry.derived !== undefined) {
      const derived = entry.derived;
      if (
        target !== 'x86_64-unknown-linux-gnu' ||
        derived?.variant !== 'no-dbm-v1' ||
        typeof derived.archiveFileName !== 'string' ||
        !/^cpython-[a-zA-Z0-9+._-]+\.tar\.gz$/.test(derived.archiveFileName) ||
        !/^[0-9a-f]{64}$/.test(derived.sha256 ?? '') ||
        !Number.isSafeInteger(derived.bytes) ||
        derived.bytes <= 0
      ) {
        throw new Error(`Malformed python-runtime derived archive for "${target}".`);
      }
    }
    return { entry, target };
  });
}

async function prepareDerivedArchive({ entry, resourcesDir, sourcePath, log }) {
  if (!entry.derived) {
    return;
  }
  const derived = entry.derived;
  const destPath = path.join(resourcesDir, derived.archiveFileName);
  if (destPath === sourcePath) {
    throw new Error('python-runtime: derived archive must not overwrite its upstream source.');
  }
  if (await archiveAlreadyVerifies({ destPath, entry: derived })) {
    log(`python-runtime: ${derived.archiveFileName} already verified; skipping derivation.`);
    return;
  }
  const tempPath = `${destPath}.derive-${process.pid}`;
  try {
    await derivePythonRuntimeArchive(sourcePath, tempPath);
    await verifyArchive({ entry: derived, filePath: tempPath, label: 'python-runtime no-dbm-v1' });
    await fsPromises.rename(tempPath, destPath);
  } finally {
    await fsPromises.rm(tempPath, { force: true });
  }
  log(
    `python-runtime: verified and installed ${derived.archiveFileName} (${derived.bytes} bytes).`
  );
}

export async function fetchPythonRuntime({
  fetchImpl = fetch,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  log = (message) => console.error(message),
  resourcesDir = defaultResourcesDir,
} = {}) {
  const manifestPath = path.join(resourcesDir, 'manifest.json');
  const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  for (const { entry, target } of loadManifestTargets(manifest, manifestPath)) {
    const url = renderAssetUrl(manifest, target);
    const fileName = new URL(url).pathname.split('/').at(-1);
    if (!fileName) {
      throw new Error(`python-runtime asset URL has no file name: ${url}`);
    }
    const destPath = path.join(resourcesDir, fileName);
    if (await archiveAlreadyVerifies({ destPath, entry })) {
      log(`python-runtime: ${fileName} already present and verified; skipping download.`);
      await prepareDerivedArchive({ entry, log, resourcesDir, sourcePath: destPath });
      continue;
    }
    log(`python-runtime: fetching ${url}`);
    const response = await fetchWithTimeout(fetchImpl, url, fetchTimeoutMs);
    if (!(response.ok && response.body)) {
      throw new Error(`python-runtime: download of ${url} failed with HTTP ${response.status}.`);
    }
    const tempPath = `${destPath}.download-${process.pid}`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
      await verifyArchive({ entry, filePath: tempPath, label: `python-runtime download ${url}` });
      await fsPromises.rename(tempPath, destPath);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true });
      throw error;
    }
    log(`python-runtime: verified and installed ${fileName} (${entry.bytes} bytes).`);
    await prepareDerivedArchive({ entry, log, resourcesDir, sourcePath: destPath });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fetchPythonRuntime().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
