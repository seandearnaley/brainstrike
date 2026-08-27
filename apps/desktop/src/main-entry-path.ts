import path from 'node:path';

/** Validate the emitted development main entry and return its flat dist directory. */
export function resolveDevelopmentMainOutputDir(mainModulePath: string, context: string): string {
  const mainOutputDir = path.dirname(mainModulePath);
  if (path.basename(mainModulePath) !== 'main.js' || path.basename(mainOutputDir) !== 'dist') {
    throw new Error(
      `${context}: Expected development main entry to be dist/main.js, received "${mainModulePath}"`
    );
  }
  return mainOutputDir;
}
