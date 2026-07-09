import fsPromises from 'node:fs/promises';
import path from 'node:path';

export interface ShellIpcResult {
  error?: string;
  ok: boolean;
}

interface ShellLike {
  openExternal: (url: string) => Promise<void>;
  openPath: (target: string) => Promise<string>;
  showItemInFolder: (target: string) => void;
}

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function validateExternalUrl(
  value: unknown
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { error: 'URL must be a non-empty string', ok: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'Invalid URL', ok: false };
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return { error: `Blocked protocol: ${parsed.protocol}`, ok: false };
  }
  return { ok: true, url: parsed.toString() };
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
    return { error: 'Shell target path must be a file or directory', ok: false };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    return {
      error:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? 'Shell target path does not exist'
          : 'Shell target path is not accessible',
      ok: false,
    };
  }
}

export function createShellIpcHandlers({
  lstatPath = fsPromises.lstat,
  shell,
  statPath = fsPromises.stat,
}: ShellIpcDependencies) {
  return {
    openExternal: async (url: unknown): Promise<ShellIpcResult> => {
      const validated = validateExternalUrl(url);
      if (!validated.ok) {
        return { error: validated.error, ok: false };
      }
      try {
        await shell.openExternal(validated.url);
        return { ok: true };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
    openPath: async (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return { error: 'openPath requires a non-empty absolute path string', ok: false };
      }
      const targetError = await validateShellTarget(absolutePath, statPath, {
        allowSymlink: false,
      });
      if (targetError) {
        return targetError;
      }
      try {
        const errorMessage = await shell.openPath(absolutePath);
        return errorMessage.length > 0 ? { error: errorMessage, ok: false } : { ok: true };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
    showItemInFolder: async (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return {
          error: 'showItemInFolder requires a non-empty absolute path string',
          ok: false,
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
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
