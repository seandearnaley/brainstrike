#!/usr/bin/env node
// BST-1061: build-time fetch of the pinned python-build-standalone CPython
// tarballs into resources/python-runtime/, verified against the checksums in
// manifest.json. Runs from the desktop `build` script — deliberately NOT
// `postinstall` (Electron 42 removed its own postinstall for supply-chain
// reasons; this repo matches that posture). A hash or size mismatch deletes
// the download and fails the build loudly; there is no skip flag.
//
// BST-1627: on darwin the verified archives are ALSO unpacked here, at build
// time, into resources/python-runtime/unpacked/<electron arch>/ — the tree
// build.mac.extraResources copies into the bundle. The tarball itself must
// never ship: Apple's notarization service scans inside archives and rejects
// python-build-standalone's ad-hoc-signed Mach-O files, whereas loose files
// in the bundle are re-signed by osx-sign with the Developer ID identity. A
// sentinel next to python/ records the archive sha256 so the runtime resolver
// can prove the tree matches the manifest without re-hashing 66 MB.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Mirrors PYTHON_RUNTIME_SENTINEL_FILE_NAME in src/python-runtime/resolve-python-binary.ts. */
export const PYTHON_RUNTIME_SENTINEL_FILE_NAME = '.brainstrike-python-runtime-ok';
/**
 * Absolute on purpose: this binary unpacks interpreter code that later runs
 * inside the fence, so it must not be resolvable via a caller-controlled PATH.
 */
const TAR_BINARY = '/usr/bin/tar';
const ELECTRON_ARCH_BY_TARGET = new Map([
  ['aarch64-apple-darwin', 'arm64'],
  ['x86_64-apple-darwin', 'x64'],
]);

/** The electron-builder `${arch}` name whose unpack directory a manifest target feeds. */
export function electronArchForTarget(target) {
  const arch = ELECTRON_ARCH_BY_TARGET.get(target);
  if (!arch) {
    throw new Error(
      `python-runtime: no electron-builder arch is mapped for manifest target "${target}".`
    );
  }
  return arch;
}

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
    return { entry, target };
  });
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
  }
}

async function readSentinel(installDir) {
  try {
    return (
      await fsPromises.readFile(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), 'utf8')
    ).trim();
  } catch {
    return;
  }
}

/**
 * A matching sentinel alone is not proof the tree is intact (Codex review on
 * PR #2958): the ignored unpacked/ tree can lose files after the sentinel was
 * written, and a release build must never package that silently. Only a
 * tree whose sentinel matches AND whose interpreter is executable is reused.
 */
async function isUnpackedTreeUsable(installDir, expectedSha256) {
  if ((await readSentinel(installDir)) !== expectedSha256) {
    return false;
  }
  try {
    await fsPromises.access(path.join(installDir, 'python', 'bin', 'python3'), fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * python-build-standalone bundles pip, and pip vendors distlib's WINDOWS
 * launcher stubs (`t32.exe`, `w64-arm.exe`, ...). They are PE executables with
 * no purpose in a macOS bundle, but @electron/osx-sign walks Contents/ with an
 * `isBinaryFile` heuristic that flags them, so each one becomes a `codesign`
 * call with its own round-trip to Apple's timestamp server. That is how
 * BST-1627's first rebuild died: `t32.exe: The timestamp service is not
 * available`. Removing them at unpack time makes the signed tree contain only
 * files that are actually signable, and removes 6 pointless timestamp
 * round-trips from every release build.
 *
 * Returns the repo-relative paths removed, so the caller can report them.
 */
export async function pruneForeignExecutables(treeDir) {
  const removed = [];
  const walk = async (dir) => {
    for (const item of await fsPromises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile() && item.name.toLowerCase().endsWith('.exe')) {
        await fsPromises.rm(full);
        removed.push(path.relative(treeDir, full));
      }
    }
  };
  await walk(treeDir);
  return removed.sort();
}

async function unpackOne({ archivePath, entry, installDir, log }) {
  // Re-verify right before extraction: the fetch step verified the download,
  // but the file on disk is what actually gets unpacked and signed.
  await verifyArchive({ entry, filePath: archivePath, label: archivePath });
  const stagingDir = `${installDir}.staging-${process.pid}`;
  await fsPromises.rm(stagingDir, { force: true, recursive: true });
  await fsPromises.mkdir(stagingDir, { recursive: true });
  try {
    await execFileAsync(TAR_BINARY, ['-xzf', archivePath, '-C', stagingDir]);
    const stagedBinary = path.join(stagingDir, 'python', 'bin', 'python3');
    try {
      await fsPromises.access(stagedBinary, fsConstants.X_OK);
    } catch {
      throw new Error(
        `python-runtime: ${path.basename(archivePath)} did not contain an executable at python/bin/python3.`
      );
    }
    const pruned = await pruneForeignExecutables(stagingDir);
    if (pruned.length > 0) {
      log(`python-runtime: pruned ${pruned.length} non-macOS executable(s): ${pruned.join(', ')}`);
    }
    await fsPromises.writeFile(
      path.join(stagingDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME),
      `${entry.sha256}\n`,
      { mode: 0o644 }
    );
    await fsPromises.rm(installDir, { force: true, recursive: true });
    await fsPromises.rename(stagingDir, installDir);
    log(`python-runtime: unpacked ${path.basename(archivePath)} into ${installDir}.`);
  } finally {
    await fsPromises.rm(stagingDir, { force: true, recursive: true });
  }
}

/**
 * Unpack every supported target's verified archive into
 * `<resourcesDir>/unpacked/<electron arch>/`. Idempotent: a tree whose
 * sentinel already records the manifest's sha256 AND whose interpreter is
 * executable is left untouched; any other state (no tree, older archive,
 * partial or damaged unpack) is replaced wholesale.
 */
export async function unpackPythonRuntime({
  log = (message) => console.error(message),
  resourcesDir = defaultResourcesDir,
} = {}) {
  const manifestPath = path.join(resourcesDir, 'manifest.json');
  const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  for (const { entry, target } of loadManifestTargets(manifest, manifestPath)) {
    const fileName = new URL(renderAssetUrl(manifest, target)).pathname.split('/').at(-1);
    const archivePath = path.join(resourcesDir, fileName);
    const installDir = path.join(resourcesDir, 'unpacked', electronArchForTarget(target));
    if (await isUnpackedTreeUsable(installDir, entry.sha256)) {
      log(`python-runtime: ${installDir} already unpacked from ${fileName}; skipping.`);
      continue;
    }
    await unpackOne({ archivePath, entry, installDir, log });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fetchPythonRuntime()
    .then(() => {
      // The unpack feeds build.mac.extraResources only; other platforms have
      // no /usr/bin/tar contract and no consumer for the tree. Say so rather
      // than silently doing nothing.
      if (process.platform !== 'darwin') {
        console.error(
          `python-runtime: skipping build-time unpack on ${process.platform} (only the macOS bundle ships the interpreter).`
        );
        return;
      }
      return unpackPythonRuntime();
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
