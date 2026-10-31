/**
 * The packaged app's third-party notices (BST-2358): one plain-text file that
 * names every third-party package whose code ships, with the license text the
 * package carries. Each way code reaches the app is read from what ships:
 * - the renderer bundle: Vite's `build.license` report of its node_modules inputs;
 * - the Node bundles: the node_modules inputs in esbuild's metafiles;
 * - the node_modules electron-builder packs: this app's production dependencies,
 *   resolved as Node resolves them.
 * THIRD-PARTY-NOTICES.md keeps the components no package carries (the Python
 * runtime). write-third-party-notices.mjs joins them after both bundles build.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** The file electron-builder ships in the app's resources (package.json `extraResources`). */
export const THIRD_PARTY_NOTICES_FILE_NAME = 'THIRD-PARTY-NOTICES.txt';
/** Vite's report, relative to the renderer's outDir (vite.config.mts `build.license`). */
export const RENDERER_LICENSE_REPORT = 'third-party-licenses.renderer.json';
/** build-main.mjs's report of the packages the Node bundles inline, in dist/. */
export const NODE_LICENSE_REPORT = 'third-party-licenses.node.json';

/** Vite's rule for a package's license file, so every section reads the same file. */
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)/iu;

/** @typedef {{ name: string, version: string, identifier?: string, text?: string }} PackageNotice */
/**
 * @typedef {{
 *   name: string,
 *   version?: string,
 *   license?: unknown,
 *   dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>,
 * }} PackageManifest
 */

/**
 * The root of the node_modules package a path belongs to, or undefined for
 * first-party code (the app and the workspace packages it bundles from source).
 */
/**
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function nodeModulesPackageDir(filePath) {
  const segments = path.resolve(filePath).split(path.sep);
  const index = segments.lastIndexOf('node_modules');
  const packageSegment = segments[index + 1];
  if (index === -1 || packageSegment === undefined) {
    return;
  }
  const width = packageSegment.startsWith('@') ? 2 : 1;
  return segments.slice(0, index + 1 + width).join(path.sep);
}

/**
 * @param {string} packageDir
 * @returns {PackageManifest}
 */
function readManifest(packageDir) {
  return JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
}

/**
 * A package's notice, in the shape of Vite's license report.
 * @param {string} packageDir
 * @returns {PackageNotice}
 */
export function packageNotice(packageDir) {
  const manifest = readManifest(packageDir);
  const licenseFile = readdirSync(packageDir, { withFileTypes: true }).find(
    (entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)
  );
  return {
    name: manifest.name,
    version: manifest.version ?? '0.0.0',
    ...(typeof manifest.license === 'string' ? { identifier: manifest.license.trim() } : {}),
    ...(licenseFile === undefined
      ? {}
      : { text: readFileSync(path.join(packageDir, licenseFile.name), 'utf8').trim() }),
  };
}

/**
 * The notices of the node_modules packages among a bundle's input files.
 * @param {readonly string[]} inputFiles
 * @returns {PackageNotice[]}
 */
export function bundledPackageNotices(inputFiles) {
  /** @type {Set<string>} */
  const packageDirs = new Set();
  for (const file of inputFiles) {
    const packageDir = nodeModulesPackageDir(file);
    if (packageDir !== undefined) {
      packageDirs.add(packageDir);
    }
  }
  return [...packageDirs].map(packageNotice);
}

/**
 * Node's lookup: the nearest node_modules/<name> from `fromDir` upward.
 * @param {string} fromDir
 * @param {string} name
 * @returns {string | undefined}
 */
function resolveInstalledPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) {
      return realpathSync(candidate);
    }
    if (path.dirname(dir) === dir) {
      return;
    }
  }
}

/**
 * The third-party packages installed for the app's production dependencies,
 * which electron-builder packs. An installed peer ships too; an optional
 * dependency or peer this platform does not install does not. A dependency that
 * is not installed fails the build, as it would fail the app.
 * @param {string} appRoot
 * @returns {PackageNotice[]}
 */
export function productionPackageNotices(appRoot) {
  /** @type {PackageNotice[]} */
  const notices = [];
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {readonly (readonly ['dependencies' | 'optionalDependencies' | 'peerDependencies', boolean])[]} */
  const fields = [
    ['dependencies', true],
    ['optionalDependencies', false],
    ['peerDependencies', false],
  ];
  /**
   * @param {string} packageDir
   * @param {PackageManifest} manifest
   */
  const visit = (packageDir, manifest) => {
    for (const [field, required] of fields) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const dependencyDir = resolveInstalledPackage(packageDir, name);
        if (dependencyDir === undefined) {
          if (required) {
            throw new Error(`${manifest.name} depends on ${name}, which is not installed.`);
          }
          continue;
        }
        if (visited.has(dependencyDir)) {
          continue;
        }
        visited.add(dependencyDir);
        if (nodeModulesPackageDir(dependencyDir) !== undefined) {
          notices.push(packageNotice(dependencyDir));
        }
        visit(dependencyDir, readManifest(dependencyDir));
      }
    }
  };
  visit(appRoot, readManifest(appRoot));
  return notices;
}

const RULE = '-'.repeat(80);

/**
 * The notices file: the hand-kept notices, then each package once, by name.
 * @param {{ appVersion: string, handKeptNotices: string, packages: readonly PackageNotice[] }} input
 * @returns {string}
 */
export function renderThirdPartyNotices({ appVersion, handKeptNotices, packages }) {
  /** @type {Map<string, PackageNotice>} */
  const unique = new Map();
  for (const notice of packages) {
    const key = `${notice.name}@${notice.version}`;
    if (!unique.has(key)) {
      unique.set(key, notice);
    }
  }
  const sorted = [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, notice]) => notice);
  const sections = sorted.map((notice) =>
    [
      RULE,
      `${notice.name} ${notice.version}`,
      `License: ${notice.identifier ?? 'not declared'}`,
      '',
      notice.text ??
        (notice.identifier === undefined
          ? 'The package ships no license text and declares no license.'
          : 'The package ships no license text; its package.json declares the license above.'),
    ].join('\n')
  );
  return [
    handKeptNotices.trim(),
    '',
    '## npm packages',
    '',
    `Brainstrike ${appVersion} includes the ${sorted.length} npm packages below, each with`,
    "its version, its declared license and the license text it ships. Electron's",
    "license (LICENSE.electron.txt) and Chromium's notices (LICENSES.chromium.html)",
    "ship with the app's Electron runtime.",
    '',
    ...sections,
    '',
  ].join('\n');
}
