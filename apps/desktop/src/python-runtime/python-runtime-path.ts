import path from 'node:path';

export interface ResolvePythonRuntimeResourcesDirOptions {
  readonly isPackaged: boolean;
  readonly mainModulePath: string;
  readonly resourcesPath: string;
}

/** Resolve the checked-in or electron-builder-packaged Python runtime resources. */
export function resolvePythonRuntimeResourcesDir(
  options: ResolvePythonRuntimeResourcesDirOptions
): string {
  if (options.isPackaged) {
    return path.join(options.resourcesPath, 'python-runtime');
  }

  const mainOutputDir = path.dirname(options.mainModulePath);
  if (
    path.basename(options.mainModulePath) !== 'main.js' ||
    path.basename(mainOutputDir) !== 'dist'
  ) {
    throw new Error(
      `Bundled Python runtime: Expected development main entry to be dist/main.js, received "${options.mainModulePath}"`
    );
  }

  return path.join(path.dirname(mainOutputDir), 'resources', 'python-runtime');
}
