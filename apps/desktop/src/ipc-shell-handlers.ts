import fsPromises from 'node:fs/promises';
import path from 'node:path';

export interface ShellIpcResult {
  error?: string;
  ok: boolean;
}

interface ShellLike {
  openPath: (target: string) => Promise<string>;
  showItemInFolder: (target: string) => void;
}

interface ShellIpcDependencies {
  lstatPath?: (target: string) => Promise<ShellTargetStats>;
  shell: ShellLike;
  statPath?: (target: string) => Promise<ShellTargetStats>;
}

interface ShellTargetStats {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink?: () => boolean;
}

function validateAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function validateShellTarget(
  absolutePath: string,
  statPath: NonNullable<ShellIpcDependencies['statPath']>,
  options: { allowSymlink: boolean }
): Promise<ShellIpcResult | null> {
  try {
    // Best-effort guard: Electron shell re-resolves the path, so this is not a confinement boundary.
    const stats = await statPath(absolutePath);
    if (
      stats.isFile() ||
      stats.isDirectory() ||
      (options.allowSymlink && stats.isSymbolicLink?.())
    ) {
      return null;
    }
    return { ok: false, error: 'Shell target path must be a file or directory' };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    return {
      ok: false,
      error:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? 'Shell target path does not exist'
          : 'Shell target path is not accessible',
    };
  }
}

export function createShellIpcHandlers({
  lstatPath = fsPromises.lstat,
  shell,
  statPath = fsPromises.stat,
}: ShellIpcDependencies) {
  return {
    openPath: async (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return { ok: false, error: 'openPath requires a non-empty absolute path string' };
      }
      const targetError = await validateShellTarget(absolutePath, statPath, {
        allowSymlink: false,
      });
      if (targetError) {
        return targetError;
      }
      try {
        const errorMessage = await shell.openPath(absolutePath);
        return errorMessage.length > 0 ? { ok: false, error: errorMessage } : { ok: true };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },
    showItemInFolder: async (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return {
          ok: false,
          error: 'showItemInFolder requires a non-empty absolute path string',
        };
      }
      const targetError = await validateShellTarget(absolutePath, lstatPath, {
        allowSymlink: true,
      });
      if (targetError) {
        return targetError;
      }
      try {
        shell.showItemInFolder(absolutePath);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },
  };
}
