import { AdaptersContext } from '@brainstrike/file-explorer-hooks';
import type { MarkdownPreviewCapabilities } from '@brainstrike/file-explorer-ui';
import { useContext, useMemo } from 'react';
import { openExternalLink } from './open-external-link';
import { resolvePlatformBridge } from './platform-bridge';

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
    const bridge = resolvePlatformBridge();
    return {
      // Shared with the assistant panel's link seam so the protocol allowlist
      // has exactly one definition in the renderer.
      openExternalLink,
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
