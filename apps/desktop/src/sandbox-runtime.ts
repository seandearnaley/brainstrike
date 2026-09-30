import { app } from 'electron';
import { resolveDesktopSeccompApplyPath } from './sandbox-runtime-path';

/** Host-owned capability, injected into tools rather than reading Electron there. */
export function resolveDesktopSandboxHelperPath(): string | undefined {
  return resolveDesktopSeccompApplyPath(app.isPackaged, process.resourcesPath);
}
