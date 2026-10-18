#!/usr/bin/env node
// BST-1061: build-time fetch of the pinned python-build-standalone CPython
// tarballs into resources/python-runtime/, verified against the checksums in
// manifest.json. Prepares the host for start, or a packaging target from
// electron-builder beforePack. Explicit --all prepares every target; deliberately NOT
// `postinstall` (Electron 42 removed its own postinstall for supply-chain
// reasons; this repo matches that posture). A hash or size mismatch deletes
// the download and fails the build loudly; there is no skip flag.
//
// BST-1627: each prepared target's verified archive (Linux: its derived
// no-dbm-v1 archive) is then unpacked HERE, at build time, into
// resources/python-runtime/unpacked/<platform>-<electron arch>/, the tree
// build.{mac,linux}.extraResources copies into the package. No tarball ships:
// Apple's notarization service scans inside archives and rejects
// python-build-standalone's ad-hoc-signed Mach-O files, whereas loose files in
// the bundle are re-signed by osx-sign with the Developer ID identity. A
// sentinel next to python/ records the archive sha256, so the runtime resolver
// proves the tree matches the manifest without the archive.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { extract } from 'tar';
import { derivePythonRuntimeArchive } from './derive-python-runtime.mjs';

/** Mirrors PYTHON_RUNTIME_SENTINEL_FILE_NAME in src/python-runtime/resolve-python-binary.ts. */
export const PYTHON_RUNTIME_SENTINEL_FILE_NAME = '.brainstrike-python-runtime-ok';
const UNPACK_DIR_BY_TARGET = new Map([
  ['aarch64-apple-darwin', 'darwin-arm64'],
  ['x86_64-apple-darwin', 'darwin-x64'],
  ['aarch64-unknown-linux-gnu', 'linux-arm64'],
  ['x86_64-unknown-linux-gnu', 'linux-x64'],
]);

/** The `<platform>-<electron arch>` directory a manifest target unpacks into. */
export function unpackDirForTarget(target) {
  const directory = UNPACK_DIR_BY_TARGET.get(target);
  if (!directory) {
    throw new Error(`python-runtime: no unpack directory is mapped for target "${target}".`);
  }
  return directory;
}

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
 * A matching sentinel alone is not proof the tree is intact (PR #2958 review):
 * the ignored unpacked/ tree can lose files after the sentinel was written, and
 * a release build must never package that silently. Only a tree whose sentinel
 * matches AND whose interpreter is executable is reused.
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
 * no purpose on macOS or Linux, but @electron/osx-sign walks Contents/ with an
 * `isBinaryFile` heuristic that flags them, so each one becomes a `codesign`
 * call with its own round-trip to Apple's timestamp server. That is how
 * BST-1627's first rebuild died: `t32.exe: The timestamp service is not
 * available`. Removing them at unpack time leaves only files that are
 * actually signable or runnable on the target.
 *
 * Returns the tree-relative paths removed, so the caller can report them.
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

/**
 * terminfo names entries after terminals, and `xterm.js` (VS Code's terminal
 * emulator) is a BINARY entry with a JavaScript file name. `turbo boundaries`
 * parses every such file in a package directory, so a local unpack or pack
 * aborted the whole boundaries gate on it, unchecked. The `vscode` entry it
 * aliases stays, and the bundled interpreter never runs on a terminal.
 *
 * Returns the tree-relative paths removed.
 */
export async function pruneSourceNamedTerminfo(treeDir) {
  const removed = [];
  const walk = async (dir) => {
    let items;
    try {
      items = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (/\.[cm]?[jt]sx?$/u.test(item.name)) {
        await fsPromises.rm(full);
        removed.push(path.relative(treeDir, full));
      }
    }
  };
  await walk(path.join(treeDir, 'python', 'share', 'terminfo'));
  return removed.sort();
}

/**
 * Unpacks a target's runtime archive into `<resourcesDir>/unpacked/<dir>/`.
 * Idempotent: a tree whose sentinel already records the archive's sha256 AND
 * whose interpreter is executable is left untouched; any other state (no tree,
 * older archive, partial or damaged unpack) is replaced wholesale. The archive
 * is re-verified right before extraction: what is unpacked and signed is the
 * file on disk, not the download that was verified earlier.
 */
async function unpackRuntimeTree({ entry, log, resourcesDir, target, upstreamFileName }) {
  const archive = entry.derived ?? entry;
  const archiveFileName = entry.derived?.archiveFileName ?? upstreamFileName;
  const archivePath = path.join(resourcesDir, archiveFileName);
  const installDir = path.join(resourcesDir, 'unpacked', unpackDirForTarget(target));
  if (await isUnpackedTreeUsable(installDir, archive.sha256)) {
    log(`python-runtime: ${installDir} already unpacked from ${archiveFileName}; skipping.`);
    return;
  }
  await verifyArchive({ entry: archive, filePath: archivePath, label: archivePath });
  const stagingDir = `${installDir}.staging-${process.pid}`;
  await fsPromises.rm(stagingDir, { force: true, recursive: true });
  await fsPromises.mkdir(stagingDir, { recursive: true });
  try {
    await extract({ cwd: stagingDir, file: archivePath, strict: true });
    try {
      await fsPromises.access(path.join(stagingDir, 'python', 'bin', 'python3'), fsConstants.X_OK);
    } catch {
      throw new Error(
        `python-runtime: ${archiveFileName} did not contain an executable at python/bin/python3.`
      );
    }
    const pruned = await pruneForeignExecutables(stagingDir);
    if (pruned.length > 0) {
      log(`python-runtime: pruned ${pruned.length} Windows executable(s): ${pruned.join(', ')}`);
    }
    const terminfo = await pruneSourceNamedTerminfo(stagingDir);
    if (terminfo.length > 0) {
      log(`python-runtime: pruned source-named terminfo entries: ${terminfo.join(', ')}`);
    }
    await fsPromises.writeFile(
      path.join(stagingDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME),
      `${archive.sha256}\n`,
      { mode: 0o644 }
    );
    await fsPromises.rm(installDir, { force: true, recursive: true });
    await fsPromises.rename(stagingDir, installDir);
    log(`python-runtime: unpacked ${archiveFileName} into ${installDir}.`);
  } finally {
    await fsPromises.rm(stagingDir, { force: true, recursive: true });
  }
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
      await unpackRuntimeTree({ entry, log, resourcesDir, target, upstreamFileName: fileName });
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
    await unpackRuntimeTree({ entry, log, resourcesDir, target, upstreamFileName: fileName });
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
