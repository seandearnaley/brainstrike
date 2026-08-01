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

const defaultResourcesDir = path.resolve(import.meta.dirname, '../resources/python-runtime');

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
    return { entry, target };
  });
}

export async function fetchPythonRuntime({
  fetchImpl = fetch,
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
      continue;
    }
    log(`python-runtime: fetching ${url}`);
    const response = await fetchImpl(url);
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
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fetchPythonRuntime().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
