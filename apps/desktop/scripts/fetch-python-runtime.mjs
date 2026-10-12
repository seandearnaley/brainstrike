#!/usr/bin/env node
// BST-1061: build-time fetch of the pinned python-build-standalone CPython
// tarballs into resources/python-runtime/, verified against the checksums in
// manifest.json. Prepares the host for start, or a packaging target from
// electron-builder beforePack. Explicit --all prepares every target; deliberately NOT
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

const PLATFORM_TARGETS = {
  darwin: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
  // Windows packaging remains supported without bundled Python.
  win32: [],
};

/** @param {string} platform */
function targetsForPlatform(platform, arch = process.arch) {
  if (platform === 'all') {
    return;
  }
  if (platform === 'linux') {
    const target = { arm64: 'aarch64-unknown-linux-gnu', x64: 'x86_64-unknown-linux-gnu' }[arch];
    if (!target) {
      throw new Error(`Unsupported python-runtime preparation architecture "linux/${arch}".`);
    }
    return [target];
  }
  if (!Object.hasOwn(PLATFORM_TARGETS, platform)) {
    throw new Error(`Unsupported python-runtime preparation platform "${platform}".`);
  }
  return PLATFORM_TARGETS[platform];
}

/**
 * @param {string[]} args
 * @param {string} [hostPlatform]
 * @returns {{ platform: string }}
 */
export function parsePythonRuntimeArgs(args, hostPlatform = process.platform) {
  let platform;
  if (args.length === 0 || (args.length === 1 && args[0] === '--platform=host')) {
    platform = hostPlatform;
  } else if (args.length === 1 && args[0] === '--all') {
    platform = 'all';
  } else if (args.length === 1 && args[0].startsWith('--platform=')) {
    platform = args[0].slice('--platform='.length);
    if (platform === 'all') {
      throw new Error('python-runtime: use --all to prepare every target.');
    }
  } else {
    throw new Error('python-runtime: expected --all or --platform=host|darwin|linux|win32.');
  }
  targetsForPlatform(platform);
  return { platform };
}

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
        !['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'].includes(target) ||
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

async function prepareDerivedArchive({ entry, resourcesDir, sourcePath, log, target }) {
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
    await derivePythonRuntimeArchive(sourcePath, tempPath, target);
    await verifyArchive({ entry: derived, filePath: tempPath, label: 'python-runtime no-dbm-v1' });
    await fsPromises.rename(tempPath, destPath);
  } finally {
    await fsPromises.rm(tempPath, { force: true });
  }
  log(
    `python-runtime: verified and installed ${derived.archiveFileName} (${derived.bytes} bytes).`
  );
}

// electron-builder's documented ${arch} macro selects this generated resource
// directory. Only the target's verified derived payload enters the package.
async function stageLinuxResources({ entry, resourcesDir, target }) {
  const arch = { 'aarch64-unknown-linux-gnu': 'arm64', 'x86_64-unknown-linux-gnu': 'x64' }[target];
  if (!(arch && entry.derived)) {
    return;
  }
  const directory = path.join(resourcesDir, 'linux', arch);
  await fsPromises.rm(directory, { force: true, recursive: true });
  await fsPromises.mkdir(directory, { recursive: true });
  await fsPromises.copyFile(
    path.join(resourcesDir, 'manifest.json'),
    path.join(directory, 'manifest.json')
  );
  await fsPromises.copyFile(
    path.join(resourcesDir, entry.derived.archiveFileName),
    path.join(directory, entry.derived.archiveFileName)
  );
}

/**
 * @typedef {object} FetchPythonRuntimeOptions
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [fetchTimeoutMs]
 * @property {(message: string) => void} [log]
 * @property {string} [resourcesDir]
 * @property {string} [platform] Runtime-validated platform selector, including explicit 'all'.
 * @property {string} [arch] Target architecture; defaults to the host architecture.
 */

/** @param {FetchPythonRuntimeOptions} [options] */
export async function fetchPythonRuntime({
  fetchImpl = fetch,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  log = (message) => console.error(message),
  resourcesDir = defaultResourcesDir,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const requestedTargets = targetsForPlatform(platform, arch);
  const manifestPath = path.join(resourcesDir, 'manifest.json');
  const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  const manifestTargets = loadManifestTargets(manifest, manifestPath);
  if (requestedTargets) {
    for (const target of requestedTargets) {
      if (!manifestTargets.some((candidate) => candidate.target === target)) {
        throw new Error(`python-runtime: manifest is missing requested target "${target}".`);
      }
    }
  }
  const selectedTargets = requestedTargets
    ? manifestTargets.filter(({ target }) => requestedTargets.includes(target))
    : manifestTargets;
  if (selectedTargets.length === 0) {
    log(`python-runtime: no bundled runtime for ${platform}; skipping preparation.`);
  }
  for (const { entry, target } of selectedTargets) {
    const url = renderAssetUrl(manifest, target);
    const fileName = new URL(url).pathname.split('/').at(-1);
    if (!fileName) {
      throw new Error(`python-runtime asset URL has no file name: ${url}`);
    }
    const destPath = path.join(resourcesDir, fileName);
    if (await archiveAlreadyVerifies({ destPath, entry })) {
      log(`python-runtime: ${fileName} already present and verified; skipping download.`);
      await prepareDerivedArchive({ entry, log, resourcesDir, sourcePath: destPath, target });
      await stageLinuxResources({ entry, resourcesDir, target });
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
    await prepareDerivedArchive({ entry, log, resourcesDir, sourcePath: destPath, target });
    await stageLinuxResources({ entry, resourcesDir, target });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  Promise.resolve()
    .then(() => fetchPythonRuntime(parsePythonRuntimeArgs(process.argv.slice(2))))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
