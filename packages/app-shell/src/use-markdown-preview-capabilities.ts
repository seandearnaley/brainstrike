import { AdaptersContext } from '@brainstrike/file-explorer-hooks';
import type { MarkdownPreviewCapabilities } from '@brainstrike/file-explorer-ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useContext, useMemo } from 'react';

const logger = createLogger('MarkdownPreviewCapabilities');
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

interface PlatformOpenExternalBridge {
  readonly openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

function getPlatformBridge(): PlatformOpenExternalBridge | undefined {
  return (window as { platform?: PlatformOpenExternalBridge }).platform;
}

function validateLinkProtocol(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)
      ? null
      : `Blocked protocol: ${parsed.protocol}`;
  } catch {
    return 'Invalid URL';
  }
}

interface FileHandleResolvingAdapter {
  resolveFileHandleByPath: (path: string) => Promise<FileSystemFileHandle>;
}

function hasFileHandleResolution(adapter: unknown): adapter is FileHandleResolvingAdapter {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as FileHandleResolvingAdapter).resolveFileHandleByPath === 'function'
  );
}

/** Builds the platform-specific markdown preview capabilities. Desktop is
 * detected by the preload `window.platform` bridge (house pattern: capability
 * presence, never isElectron()). Missing pieces produce explicit failures. */
export function useMarkdownPreviewCapabilitiesValue(): MarkdownPreviewCapabilities {
  const adapters = useContext(AdaptersContext);
  const fileSystemAdapter = adapters?.fileSystemAdapter;

  return useMemo<MarkdownPreviewCapabilities>(() => {
    const bridge = getPlatformBridge();
    return {
      openExternalLink: async (url) => {
        const protocolError = validateLinkProtocol(url);
        if (protocolError) {
          logger.warn('Blocked external link', { protocolError, url });
          return { error: protocolError, ok: false };
        }
        if (bridge?.openExternal) {
          return bridge.openExternal(url);
        }
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        return opened ? { ok: true } : { error: 'Popup blocked by the browser', ok: false };
      },
      resolveImageSrc: async (path) => {
        if (bridge) {
          // Desktop: main-process asset protocol validates root containment.
          return `brainstrike-asset://local/asset?path=${encodeURIComponent(path)}`;
        }
        if (fileSystemAdapter && hasFileHandleResolution(fileSystemAdapter)) {
          const handle = await fileSystemAdapter.resolveFileHandleByPath(path);
          const file = await handle.getFile();
          return URL.createObjectURL(file);
        }
        throw new Error('Local image preview unavailable on this platform');
      },
    };
  }, [fileSystemAdapter]);
}
