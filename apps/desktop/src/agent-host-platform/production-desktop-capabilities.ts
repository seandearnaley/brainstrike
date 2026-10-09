import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import { isSupportedProvider } from '@brainstrike/assistant-contract';
import { listEmbeddingModels } from '@brainstrike/assistant-contract/provider-metadata';
import { z } from 'zod';
import type { DesktopAssistantToolDependencies } from '../assistant-server/native-tool-executor-context';
import { loadWorkspaceRootsFromDatabase } from '../assistant-server/workspace-roots';
import type { DesktopWorktreeServices } from '../assistant-server/worktree-tool-dependencies';
import { getDatabase } from '../db-main';
import { desktopHostToolServices } from './desktop-host-tool-runtime';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import type { DesktopWorkspaceBindingAuthority } from './desktop-workspace-binding';
import type { DesktopPlatformCapabilities } from './main-platform';
import { resolveDesktopMemoryVectors } from './memory-vector-selection';

/** Supplied by the existing settings owner, never parsed from client configuration. */
export type DesktopCliOwnerIntentReader = NonNullable<DesktopAdmissionReads['cliOwnerIntent']>;

/** Main's tool services for host threads, resolved per run (the worktree services lazily). */
export type DesktopHostToolServices = DesktopAssistantToolDependencies & DesktopWorktreeServices;

/** Catalog dimensions of the recall embedder: hosted from the registry, local from the DB catalog. */
async function readEmbeddingDimensions(
  db: Awaited<ReturnType<typeof getDatabase>>,
  provider: string,
  modelId: string
): Promise<number> {
  if (provider !== 'local') {
    const model = isSupportedProvider(provider)
      ? listEmbeddingModels(provider).find((candidate) => candidate.id === modelId)
      : undefined;
    if (!model) {
      throw new Error(`Embedding model "${provider}/${modelId}" is not in the provider catalog.`);
    }
    return model.defaultDimension;
  }
  // The same catalog row the legacy local recall embedder read its dimensions from.
  const result = await db.query(
    'SELECT capabilities FROM models WHERE id = $1 AND provider_id = $2 LIMIT 1',
    [modelId, 'local']
  );
  const row = z
    .object({ capabilities: z.union([z.string(), z.record(z.string(), z.unknown())]) })
    .optional()
    .parse(result.rows[0]);
  if (!row) {
    throw new Error(`Local embedding model "${modelId}" is not in the model catalog.`);
  }
  return z
    .object({ defaultDimension: z.number().int().positive() })
    .parse(typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities)
    .defaultDimension;
}

async function readLocalEmbeddingHostDevice(
  read: ((signal: AbortSignal) => Promise<'webgpu' | 'wasm'>) | undefined,
  signal: AbortSignal
): Promise<'webgpu' | 'wasm'> {
  if (!read) {
    throw new Error('Local Memory vectors require the embedding host');
  }
  return await read(signal);
}

/**
 * The facts a host-composed run admission reads from Main (BST-1930 stage e):
 * the model catalog and live roots in Main's database, the live binding
 * authority, the worktree service, the saved policy and the embedding host.
 */
function desktopAdmissionReads(
  dependencies: DesktopHostToolServices,
  readPersistedPolicy: (() => Promise<PermissionToolGateSnapshot | undefined>) | undefined,
  readCliOwnerIntent: DesktopCliOwnerIntentReader | undefined,
  workspaceAuthority: DesktopWorkspaceBindingAuthority | undefined,
  readLocalEmbeddingDevice: ((signal: AbortSignal) => Promise<'webgpu' | 'wasm'>) | undefined
): DesktopAdmissionReads {
  return {
    acquireWorkspace: async (request) => {
      if (!workspaceAuthority) {
        throw new Error('Desktop run has no live workspace binding owner');
      }
      return await workspaceAuthority.acquire(request);
    },
    catalogModel: async ({ model, provider }) => {
      // The UI composite is a selection key. The existing catalog owns the pair.
      const result = await (await getDatabase()).query(
        'SELECT provider_id AS "providerId", is_enabled AS "isEnabled" FROM models WHERE id = $1 AND provider_id = $2',
        [model, provider]
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : z.strictObject({ isEnabled: z.boolean(), providerId: z.string() }).parse(row);
    },
    ...(readCliOwnerIntent ? { cliOwnerIntent: readCliOwnerIntent } : {}),
    /**
     * The auto-observer candidates the model catalog has enabled: provider and
     * model rows enabled and the model an LLM, the gate the memory settings
     * dropdown applies (main's resolveEffectiveObservationalMemorySettings).
     */
    enabledObservers: async (candidates) => {
      const pairs = candidates.map((candidate) => {
        const separator = candidate.indexOf('/');
        return { modelId: candidate.slice(separator + 1), provider: candidate.slice(0, separator) };
      });
      const result = await (await getDatabase()).query(
        `SELECT m.provider_id AS "providerId", m.id AS "modelId"
           FROM models m JOIN providers p ON p.id = m.provider_id
          WHERE p.is_enabled = true AND m.is_enabled = true
            AND (m.capabilities::jsonb)->>'type' = 'llm'
            AND m.provider_id = ANY($1) AND m.id = ANY($2)`,
        [[...new Set(pairs.map((pair) => pair.provider))], pairs.map((pair) => pair.modelId)]
      );
      return z
        .array(z.strictObject({ modelId: z.string(), providerId: z.string() }))
        .parse(result.rows)
        .map((row) => `${row.providerId}/${row.modelId}`);
    },
    liveWorkspaceRoots: async () => await loadWorkspaceRootsFromDatabase(await getDatabase()),
    memoryVectors: async (settings, signal) => {
      const db = await getDatabase();
      return await resolveDesktopMemoryVectors(settings, {
        readDimensions: (provider, modelId) => readEmbeddingDimensions(db, provider, modelId),
        readLocalDevice: () => readLocalEmbeddingHostDevice(readLocalEmbeddingDevice, signal),
      });
    },
    persistedPolicy: async () => await readPersistedPolicy?.(),
    worktreesAvailable: async () => Boolean(dependencies.resolveWorktreeService?.()),
  };
}

/** Lazy borrows: Root/New Thread never waits for indexing or credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopHostToolServices,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader,
  workspaceAuthority?: DesktopWorkspaceBindingAuthority,
  readLocalEmbeddingDevice?: (signal: AbortSignal) => Promise<'webgpu' | 'wasm'>
): Omit<DesktopPlatformCapabilities, 'mcp'> {
  return {
    admission: desktopAdmissionReads(
      dependencies,
      readPersistedPolicy,
      readCliOwnerIntent,
      workspaceAuthority,
      readLocalEmbeddingDevice
    ),
    ...(workspaceAuthority
      ? { validateWorkspaceBinding: workspaceAuthority.validateWorkspaceBinding }
      : {}),
    hostTools: desktopHostToolServices(dependencies),
    ...(dependencies.embeddingHostManager
      ? { localEmbedding: dependencies.embeddingHostManager }
      : {}),
    resolveWorkspaceRoot: async (rootId) => {
      const root = (await loadWorkspaceRootsFromDatabase(await getDatabase())).find(
        (candidate) => candidate.rootId === rootId
      );
      if (!root) {
        throw new Error('The workspace root is no longer mounted');
      }
      return root.path;
    },
  };
}
