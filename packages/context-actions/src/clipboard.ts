import type { ActionOutcome, ClipboardService } from './types';

interface ClipboardBridgeResult {
  error?: string;
  ok?: boolean;
}

interface ElectronClipboardBridge {
  writeText?: (text: string) => Promise<ClipboardBridgeResult>;
}

type ElectronClipboardWrite = (text: string) => Promise<ClipboardBridgeResult>;

function resolveElectronClipboardWrite(): ElectronClipboardWrite | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { clipboard?: ElectronClipboardBridge }).clipboard;
  const writeText = bridge?.writeText;
  return typeof writeText === 'function' ? writeText : null;
}

async function writeViaElectronBridge(
  electronWriteText: ElectronClipboardWrite,
  text: string
): Promise<ActionOutcome> {
  try {
    const result = await electronWriteText(text);
    if (result?.ok === true) {
      return { ok: true };
    }
    const bridgeError =
      typeof result?.error === 'string' && result.error.length > 0 ? result.error : null;
    return {
      ok: false,
      error: bridgeError ?? 'Desktop clipboard bridge rejected the write',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Desktop clipboard bridge threw',
    };
  }
}

async function writeViaNavigatorClipboard(text: string): Promise<ActionOutcome> {
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

export function createClipboardService(): ClipboardService {
  return {
    async writeText(text: string): Promise<ActionOutcome> {
      const electronWriteText = resolveElectronClipboardWrite();
      if (electronWriteText) {
        // A present-but-failing bridge is a bug to surface, not to mask with
        // the web API (no silent fallbacks).
        return await writeViaElectronBridge(electronWriteText, text);
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        return await writeViaNavigatorClipboard(text);
      }
      return { ok: false, error: 'No clipboard available in this environment' };
    },
  };
}
