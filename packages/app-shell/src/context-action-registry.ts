import {
  type ActionRegistry,
  type ActionServices,
  type AnyContextAction,
  type CapabilityKey,
  createActionRegistry,
  createClipboardService,
} from '@brainstrike/context-actions';
// Subpath imports keep the heavy db-explorer/file-explorer-ui root barrels out
// of this always-mounted module so their lazy-loaded graphs stay code-split.
import { collectionActions } from '@brainstrike/db-explorer/context-actions';
import {
  fileEntryActions,
  workspaceRootActions,
} from '@brainstrike/file-explorer-ui/context-actions';
import { assistantThreadActions } from './assistant-thread-context-actions';
import { changesActions } from './changes/changes-context-actions';
import { resolvePlatformBridge } from './platform-bridge';

/**
 * The shared building blocks for every action-driven surface in the app: the
 * raw context-action list, the capability set inferred from the bridges that
 * exist, and the services those actions run against. The context-action
 * registry (right-click menus) and the ⌘K command registry are BOTH projections
 * of these parts — a single source of truth, so a capability or bridge is wired
 * exactly once. Capability gating is data-driven (a bridge's presence adds a
 * capability); there is no isElectron branch.
 */
export interface AppActionRegistryParts {
  readonly actions: readonly AnyContextAction[];
  readonly capabilities: ReadonlySet<CapabilityKey>;
  readonly services: ActionServices;
}

export function buildAppActionRegistryParts(): AppActionRegistryParts {
  const services: ActionServices = { clipboard: createClipboardService() };
  const capabilities = new Set<CapabilityKey>(['clipboard']);

  const platformBridge = resolvePlatformBridge();
  if (platformBridge) {
    services.platformFs = {
      openPath: async (absolutePath) => {
        const result = await platformBridge.openPath(absolutePath);
        return result.ok ? { ok: true } : { error: result.error ?? 'Open failed', ok: false };
      },
      showItemInFolder: async (absolutePath) => {
        const result = await platformBridge.showItemInFolder(absolutePath);
        return result.ok ? { ok: true } : { error: result.error ?? 'Reveal failed', ok: false };
      },
    };
    capabilities.add('fs.reveal');
    capabilities.add('fs.openPath');
  }

  return {
    actions: [
      ...fileEntryActions,
      ...workspaceRootActions,
      ...collectionActions,
      ...assistantThreadActions,
      ...changesActions,
    ],
    capabilities,
    services,
  };
}

export function createAppActionRegistry(): ActionRegistry {
  const { actions, capabilities, services } = buildAppActionRegistryParts();
  return createActionRegistry({ actions, capabilities, services });
}
