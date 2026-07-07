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
        return { error: 'clipboard writeText requires a string payload', ok: false };
      }
      try {
        clipboard.writeText(rawText);
        return { ok: true };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
