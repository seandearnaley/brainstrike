import {
  type ActionRegistry,
  type ActionServices,
  type CapabilityKey,
  createActionRegistry,
  createClipboardService,
} from '@brainstrike/context-actions';
// Subpath imports keep the heavy db-explorer/file-explorer-ui root barrels out
// of this always-mounted module so their lazy-loaded graphs stay code-split.
import { collectionActions } from '@brainstrike/db-explorer/context-actions';
import { fileEntryActions } from '@brainstrike/file-explorer-ui/context-actions';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('ContextActionRegistry');

interface PlatformBridge {
  openPath: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
  showItemInFolder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
}

function resolvePlatformBridge(): PlatformBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { platform?: Partial<PlatformBridge> }).platform;
  if (!bridge) {
    return null;
  }
  if (typeof bridge.showItemInFolder !== 'function' || typeof bridge.openPath !== 'function') {
    // A partially-formed bridge is a wiring bug, not a missing capability —
    // log loudly instead of silently downgrading to web behavior.
    logger.error('window.platform bridge is malformed; shell actions disabled', {
      hasOpenPath: typeof bridge.openPath === 'function',
      hasShowItemInFolder: typeof bridge.showItemInFolder === 'function',
    });
    return null;
  }
  return bridge as PlatformBridge;
}

export function createAppActionRegistry(): ActionRegistry {
  const services: ActionServices = { clipboard: createClipboardService() };
  const capabilities = new Set<CapabilityKey>(['clipboard']);

  const platformBridge = resolvePlatformBridge();
  if (platformBridge) {
    services.platformFs = {
      openPath: async (absolutePath) => {
        const result = await platformBridge.openPath(absolutePath);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'Open failed' };
      },
      showItemInFolder: async (absolutePath) => {
        const result = await platformBridge.showItemInFolder(absolutePath);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'Reveal failed' };
      },
    };
    capabilities.add('fs.reveal');
    capabilities.add('fs.openPath');
  }

  return createActionRegistry({
    actions: [...fileEntryActions, ...collectionActions],
    capabilities,
    services,
  });
}
