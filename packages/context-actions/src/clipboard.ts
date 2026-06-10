import type { ActionOutcome, ClipboardService } from './types';

interface ElectronClipboardBridge {
  writeText?: (text: string) => boolean;
}

function resolveElectronClipboard(): ElectronClipboardBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { clipboard?: ElectronClipboardBridge }).clipboard;
  return typeof bridge?.writeText === 'function' ? bridge : null;
}

export function createClipboardService(): ClipboardService {
  return {
    async writeText(text: string): Promise<ActionOutcome> {
      const electronClipboard = resolveElectronClipboard();
      if (electronClipboard?.writeText) {
        // A present-but-failing bridge is a bug to surface, not to mask with
        // the web API (no silent fallbacks).
        if (electronClipboard.writeText(text)) {
          return { ok: true };
        }
        return { ok: false, error: 'Desktop clipboard bridge rejected the write' };
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(text);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Clipboard write failed',
          };
        }
      }
      return { ok: false, error: 'No clipboard available in this environment' };
    },
  };
}
