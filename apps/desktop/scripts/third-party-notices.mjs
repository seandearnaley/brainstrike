/**
 * The packaged app's third-party notices (BST-2358): one plain-text file that
 * names every third-party package whose code ships, with the license texts the
 * package carries. Each way code reaches the app is read from what ships:
 * - the renderer and its workers: the node_modules modules in Vite's bundles
 *   (vite.config.mts reports them);
 * - the Node bundles: the node_modules inputs in esbuild's metafiles;
 * - the node_modules electron-builder packs: this app's production dependencies,
 *   as pnpm links them.
 * THIRD-PARTY-NOTICES.md keeps the components no package carries (the Python
 * runtime). write-third-party-notices.mjs joins them after both bundles build.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** The file electron-builder ships in the app's resources (package.json `extraResources`). */
export const THIRD_PARTY_NOTICES_FILE_NAME = 'THIRD-PARTY-NOTICES.txt';
/** The renderer's report, relative to its outDir (vite.config.mts). */
export const RENDERER_LICENSE_REPORT = 'third-party-licenses.renderer.json';
/** build-main.mjs's report of the packages the Node bundles inline, in dist/. */
export const NODE_LICENSE_REPORT = 'third-party-licenses.node.json';

/** A package's license files: LICENSE, LICENCE or COPYING, with any suffix. */
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)/iu;

/** @typedef {{ name: string, version: string, identifier?: string, text?: string }} PackageNotice */
/**
 * @typedef {{
 *   name: string,
 *   version?: string,
 *   license?: unknown,
 *   licenses?: unknown,
 *   dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>,
 * }} PackageManifest
 */

/**
 * The root of the node_modules package a path belongs to, or undefined for
 * first-party code (the app and the workspace packages it bundles from source).
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
 * The license a manifest declares: an SPDX expression, or the legacy
 * `license: { type }` and `licenses: [{ type }]` forms.
 * @param {PackageManifest} manifest
 * @returns {string | undefined}
 */
function declaredLicense(manifest) {
  if (typeof manifest.license === 'string') {
    return manifest.license.trim();
  }
  const types = [manifest.license, ...(Array.isArray(manifest.licenses) ? manifest.licenses : [])]
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'type' in entry ? entry.type : undefined
    )
    .filter((type) => typeof type === 'string');
  return types.length === 0 ? undefined : types.join(' OR ');
}

/**
 * A package's notice: its declared license and every license file it ships, in
 * name order (a dual-licensed package ships one per license).
 * @param {string} packageDir
 * @returns {PackageNotice}
 */
export function packageNotice(packageDir) {
  const manifest = readManifest(packageDir);
  const identifier = declaredLicense(manifest);
  const texts = readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(path.join(packageDir, name), 'utf8').trim());
  return {
    name: manifest.name,
    version: manifest.version ?? '0.0.0',
    ...(identifier === undefined ? {} : { identifier }),
    ...(texts.length === 0 ? {} : { text: texts.join('\n\n') }),
  };
}

/**
 * The notices of the node_modules packages among a bundle's input files.
 * @param {Iterable<string>} inputFiles
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
 * @param {string} candidate
 * @returns {string | undefined}
 */
function installedPackageAt(candidate) {
  return existsSync(path.join(candidate, 'package.json')) ? realpathSync(candidate) : undefined;
}

/**
 * Where pnpm links a package's dependencies and peers: the package's own
 * node_modules, then the node_modules of its store entry, beside it. Nothing
 * further up the tree was linked for this package.
 * @param {string} packageDir
 * @param {string} name
 * @returns {string | undefined}
 */
function linkedPackage(packageDir, name) {
  const segments = packageDir.split(path.sep);
  const storeModules = segments.slice(0, segments.lastIndexOf('node_modules') + 1).join(path.sep);
  return (
    installedPackageAt(path.join(packageDir, 'node_modules', name)) ??
    (storeModules === '' ? undefined : installedPackageAt(path.join(storeModules, name)))
  );
}

/**
 * The third-party packages installed for the app's production dependencies,
 * which electron-builder packs. A peer pnpm linked for a package ships too; an
 * optional dependency or peer it did not link does not. A dependency that is not
 * linked fails the build, as it would fail the app.
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
        const dependencyDir = linkedPackage(packageDir, name);
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
 * The notices file: the hand-kept notices, then each package once, by name. A
 * development build has no renderer bundle, and the file says so.
 * @param {{
 *   appVersion: string,
 *   handKeptNotices: string,
 *   packages: readonly PackageNotice[],
 *   rendererBundled: boolean,
 * }} input
 * @returns {string}
 */
export function renderThirdPartyNotices({
  appVersion,
  handKeptNotices,
  packages,
  rendererBundled,
}) {
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
    "its version, its declared license and the license texts it ships. Electron's",
    "license (LICENSE.electron.txt) and Chromium's notices (LICENSES.chromium.html)",
    "ship with the app's Electron runtime.",
    ...(rendererBundled
      ? []
      : [
          '',
          'This development build has no renderer bundle, so packages only the',
          'renderer bundles are missing. `pnpm build` writes the notices the app ships.',
        ]),
    '',
    ...sections,
    '',
  ].join('\n');
}
