import path from 'node:path';
import { resolveDevelopmentMainOutputDir } from '../main-entry-path';

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

  const mainOutputDir = resolveDevelopmentMainOutputDir(
    options.mainModulePath,
    'Bundled Python runtime'
  );
  return path.join(path.dirname(mainOutputDir), 'resources', 'python-runtime');
}
