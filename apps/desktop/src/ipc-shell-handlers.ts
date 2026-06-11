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
  shell: ShellLike;
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

export function createShellIpcHandlers({ shell }: ShellIpcDependencies) {
  return {
    openPath: async (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return { ok: false, error: 'openPath requires a non-empty absolute path string' };
      }
      try {
        const errorMessage = await shell.openPath(absolutePath);
        return errorMessage.length > 0 ? { ok: false, error: errorMessage } : { ok: true };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },
    showItemInFolder: (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return Promise.resolve({
          ok: false,
          error: 'showItemInFolder requires a non-empty absolute path string',
        });
      }
      try {
        shell.showItemInFolder(absolutePath);
        return Promise.resolve({ ok: true });
      } catch (error) {
        return Promise.resolve({ ok: false, error: toErrorMessage(error) });
      }
    },
  };
}
