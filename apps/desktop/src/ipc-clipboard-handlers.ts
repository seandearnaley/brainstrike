export interface ClipboardIpcResult {
  error?: string;
  ok: boolean;
}

interface ClipboardLike {
  writeText: (text: string) => void;
}

interface ClipboardIpcDependencies {
  clipboard: ClipboardLike;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createClipboardIpcHandlers({ clipboard }: ClipboardIpcDependencies) {
  return {
    writeText: (rawText: unknown): ClipboardIpcResult => {
      if (typeof rawText !== 'string') {
        return { ok: false, error: 'clipboard writeText requires a string payload' };
      }
      try {
        clipboard.writeText(rawText);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },
  };
}
