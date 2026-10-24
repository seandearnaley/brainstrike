/**
 * How desktop's Node builds compile workspace packages: from their source.
 *
 * Every workspace export names its source module in `types` (a Just-in-Time
 * package's export is the source itself), so a bundle resolves `@brainstrike/*`
 * to exactly the modules type-check reads and never to a package's `dist`.
 * Packages that other Node runtimes load keep building that `dist` for them.
 * Third-party packages, `electron` and the two native add-ons stay runtime
 * imports, resolved from this app's own node_modules.
 *
 * esbuild plugins typed by JSDoc alone: no esbuild runtime import, so the
 * config stays pure for src/__tests__/build-main-config.test.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** node-gyp builds these; their binaries load from the package at runtime. */
export const NATIVE_WORKSPACE_PACKAGES = [
  '@brainstrike/secure-fs-native',
  '@brainstrike/windows-job-native',
];

/**
 * @typedef {string | { readonly types?: unknown, readonly default?: unknown }} ExportTarget
 * @typedef {Readonly<Record<string, ExportTarget | undefined>>} ExportsMap
 * @typedef {{ directory: string, exports: ExportsMap }} WorkspacePackage
 */

/** @param {string} specifier */
function isNativeWorkspaceImport(specifier) {
  return NATIVE_WORKSPACE_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`)
  );
}

/**
 * Each workspace package's directory and `exports`, by package name.
 * @param {string} packagesRoot
 * @returns {Map<string, WorkspacePackage>}
 */
export function readWorkspacePackages(packagesRoot) {
  /** @type {Map<string, WorkspacePackage>} */
  const packages = new Map();
  for (const directory of readdirSync(packagesRoot)) {
    const manifest = path.join(packagesRoot, directory, 'package.json');
    if (existsSync(manifest)) {
      const { exports, name } = JSON.parse(readFileSync(manifest, 'utf8'));
      packages.set(name, { directory: path.join(packagesRoot, directory), exports: exports ?? {} });
    }
  }
  return packages;
}

/**
 * The export key a subpath matches: its own key, or a `*` pattern with the text it stands for.
 * @param {ExportsMap} exportsMap
 * @param {string} subpath
 * @returns {{ key: string, star?: string } | null}
 */
function matchExport(exportsMap, subpath) {
  if (Object.hasOwn(exportsMap, subpath)) {
    return { key: subpath };
  }
  for (const key of Object.keys(exportsMap)) {
    const star = key.indexOf('*');
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (star !== -1 && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      return { key, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  return null;
}

/**
 * The source module a workspace specifier names. A specifier with no export, or
 * an export with no source, fails the build: there is no `dist` to fall back to.
 * @param {ReadonlyMap<string, WorkspacePackage>} packages
 * @param {string} specifier
 */
export function workspaceSourceModule(packages, specifier) {
  const name = specifier.split('/', 2).join('/');
  const workspacePackage = packages.get(name);
  const subpath = `.${specifier.slice(name.length)}`;
  const match = workspacePackage ? matchExport(workspacePackage.exports, subpath) : null;
  const target = workspacePackage && match ? workspacePackage.exports[match.key] : undefined;
  const source = typeof target === 'string' ? target : (target?.types ?? target?.default);
  if (!(workspacePackage && match && typeof source === 'string')) {
    throw new Error(`${specifier} names no source module in ${name}'s exports`);
  }
  const file = match.star === undefined ? source : source.replace('*', match.star);
  return path.join(workspacePackage.directory, file);
}

/**
 * Bundle workspace packages from source. With `thirdParty: 'external'`, every
 * other bare import stays a runtime import; with `'bundle'`, esbuild inlines it.
 * @param {{ packagesRoot: string, thirdParty: 'bundle' | 'external' }} options
 * @returns {import('esbuild').Plugin}
 */
export function workspaceSourceBundling({ packagesRoot, thirdParty }) {
  return {
    name: 'workspace-source-bundling',
    setup(build) {
      const packages = readWorkspacePackages(packagesRoot);
      build.onResolve({ filter: /^[^./#]/ }, (args) => {
        if (path.isAbsolute(args.path)) {
          return;
        }
        if (isNativeWorkspaceImport(args.path)) {
          return { external: true, path: args.path };
        }
        if (args.path.startsWith('@brainstrike/')) {
          return { path: workspaceSourceModule(packages, args.path) };
        }
        return thirdParty === 'external' ? { external: true, path: args.path } : undefined;
      });
    },
  };
}
