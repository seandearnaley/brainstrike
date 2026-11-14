import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { loadWorkspaceRootsFromCatalog } from '@brainstrike/assistant-service/node-workspace-services';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { desktopHostToolServices } from './desktop-host-tool-runtime';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import type { DesktopPlatformCapabilities } from './main-platform';

/** Supplied by the existing settings owner, never parsed from client configuration. */
export type DesktopCliOwnerIntentReader = NonNullable<DesktopAdmissionReads['cliOwnerIntent']>;

/** Main's tool services for host threads. */
export interface DesktopHostToolServices {
  readonly modelCatalog: Pick<ModelCatalogCapability, 'read'>;
  readonly workspaceRoots: WorkspaceRootPort;
}

/**
 * The facts a host-composed run admission reads from Main (BST-1930 stage e): the model
 * catalog and the live roots. The host acquires the run's workspace itself
 * (ADR-0029 stage 4), from the folders its root registry holds.
 */
function desktopAdmissionReads(
  dependencies: DesktopHostToolServices,
  readCliOwnerIntent: DesktopCliOwnerIntentReader | undefined
): Omit<DesktopAdmissionReads, 'acquireWorkspace'> {
  return {
    catalogModel: async ({ model, provider }) => {
      const row = (await dependencies.modelCatalog.read()).models.find(
        (candidate) => candidate.id === model && candidate.providerId === provider
      );
      return row ? { isEnabled: row.isEnabled, providerId: row.providerId } : null;
    },
    ...(readCliOwnerIntent ? { cliOwnerIntent: readCliOwnerIntent } : {}),
    // A scratch folder is its own thread's (ADR-0034): a run bound to it acquires it through its
    // binding, and a run with no folder of its own never sees another thread's.
    liveWorkspaceRoots: async () =>
      await loadWorkspaceRootsFromCatalog(dependencies.workspaceRoots, { omitKind: 'scratch' }),
  };
}

/** Lazy borrows: Root/New Thread never waits for credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopHostToolServices,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader
): Omit<DesktopPlatformCapabilities, 'mcp'> {
  return {
    admission: desktopAdmissionReads(dependencies, readCliOwnerIntent),
    hostTools: desktopHostToolServices,
    resolveWorkspaceRoot: async (rootId) => {
      const root = (await loadWorkspaceRootsFromCatalog(dependencies.workspaceRoots)).find(
        (candidate) => candidate.rootId === rootId
      );
      if (!root) {
        throw new Error('The workspace root is no longer mounted');
      }
      return root.path;
    },
  };
}
