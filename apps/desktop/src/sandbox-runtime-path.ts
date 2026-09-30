import path from 'node:path';

/** Native helpers must be OS-visible, never Electron's virtual ASAR paths. */
export function resolveDesktopSeccompApplyPath(
  isPackaged: boolean,
  resourcesPath: string,
  platform: string = process.platform,
  arch: string = process.arch
): string | undefined {
  if (!isPackaged || platform !== 'linux') {
    return;
  }
  if (!(path.isAbsolute(resourcesPath) && ['x64', 'arm64'].includes(arch))) {
    throw new Error(
      'Packaged Linux seccomp requires an absolute resources path and supported architecture.'
    );
  }
  return path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    'sandbox-runtime',
    'vendor',
    'seccomp',
    arch,
    'apply-seccomp'
  );
}
