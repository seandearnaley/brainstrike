/**
 * Persona discovery IPC handlers (desktop main). Lists built-in + user-defined
 * personas — INCLUDING invalid user files with their parse/validation error —
 * for the Settings → Subagents panel. Mirrors ipc-user-commands-handlers:
 * injected fs + DB for unit tests, SecureRoot-backed real disk in production.
 */

import { homedir } from 'node:os';
import {
  type AssistantPersonaAvailability,
  type AssistantPersonaDefinition,
  type AssistantPersonaListItem,
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
  personaScope,
} from '@brainstrike/assistant-contract';
import { createNodeFsScanDeps } from './assistant-server/node-fs-scan-deps';
import {
  scanUserPersonas,
  type UserPersonaScanEntry,
} from './assistant-server/user-personas-loader';
import { resolveScanRoots, type UserCommandsListDeps } from './ipc-user-commands-handlers';

/** Same deps shape as the commands list handler (fs + DB + homedir). */
export interface UserPersonasListDeps extends UserCommandsListDeps {
  readonly inspectAvailability?: (
    persona: AssistantPersonaDefinition
  ) => Promise<AssistantPersonaAvailability>;
}

function toListItem(entry: UserPersonaScanEntry): AssistantPersonaListItem {
  if (entry.status === 'shadowed') {
    // No persona was built, so id/label fall back to the filename — and the
    // row names the WINNER, which is what the author needs to act.
    return {
      absPath: entry.absPath,
      description: '',
      id: entry.fileName,
      label: entry.fileName,
      shadowedBy: entry.shadowedBy,
      source: 'user',
      status: 'shadowed',
      ...(entry.sourceRootId ? { sourceRootId: entry.sourceRootId } : {}),
    };
  }
  if (entry.status === 'invalid') {
    return {
      absPath: entry.absPath,
      description: '',
      error: entry.error,
      id: entry.fileName,
      label: entry.fileName,
      source: 'user',
      status: 'invalid',
      ...(entry.sourceRootId ? { sourceRootId: entry.sourceRootId } : {}),
    };
  }
  const pin = entry.persona.model;
  return {
    absPath: entry.absPath,
    description: entry.persona.description,
    id: entry.persona.id,
    label: entry.persona.label,
    source: 'user',
    status: 'ok',
    ...personaScope(entry.persona),
    ...(pin ? { modelPin: `${pin.provider}::${pin.modelId}` } : {}),
    ...(entry.sourceRootId ? { sourceRootId: entry.sourceRootId } : {}),
  };
}

export async function listUserPersonas(
  deps: UserPersonasListDeps
): Promise<AssistantPersonasListResult> {
  const builtIns: AssistantPersonaListItem[] = BUILT_IN_PERSONAS.map((persona) => ({
    description: persona.description,
    id: persona.id,
    label: persona.label,
    ...personaScope(persona),
    source: 'built-in',
    status: 'ok',
  }));
  const roots = await resolveScanRoots(deps.getDatabase);
  const scan = scanUserPersonas({ homeDir: deps.homedir(), roots }, deps.fs);
  const definitions = new Map(
    [...BUILT_IN_PERSONAS, ...scan.personas].map((persona) => [persona.id, persona])
  );
  // Shadowed files ride `entries` like every other outcome (the skill-scan
  // convention), so nothing needs a separate list to stay visible.
  return {
    personas: await Promise.all(
      [...builtIns, ...scan.entries.map(toListItem)].map(async (item) => {
        if (item.status !== 'ok' || !deps.inspectAvailability) {
          return item;
        }
        const persona = definitions.get(item.id);
        if (!persona) {
          throw new Error('A loadable persona has no validated definition.');
        }
        return { ...item, availability: await deps.inspectAvailability(persona) };
      })
    ),
    ...(scan.incompleteDirs.length > 0 ? { incompleteDirs: [...scan.incompleteDirs] } : {}),
  };
}

/**
 * Production entry point: real DB host, home dir, and SecureRoot disk fs. The
 * DB loader is imported lazily so this module stays cheap at registration time.
 */
export function createUserPersonasListHandler(): () => Promise<AssistantPersonasListResult> {
  return async () => {
    const filesystem = createNodeFsScanDeps();
    try {
      const [
        { getDatabase },
        { mcpToolRegistry },
        { resolveProviderCredential },
        { inspectPersonaAvailability },
      ] = await Promise.all([
        import('./db-main'),
        import('@brainstrike/agent'),
        import('./assistant-server/provider-credentials'),
        import('./assistant-server/persona-availability'),
      ]);
      const database = await getDatabase();
      if (!database) {
        throw new Error('Persona availability requires the host model catalog.');
      }
      const { rows: models } = await database.query<{ id: string; providerId: string }>(
        'SELECT id, provider_id AS "providerId" FROM models'
      );
      const mcpTools = new Map(
        Object.values(mcpToolRegistry.getAllTools())
          .flat()
          .map((tool) => [tool.id, tool.enabled])
      );
      const credentials = new Map<string, ReturnType<typeof resolveProviderCredential>>();
      return await listUserPersonas({
        fs: filesystem,
        getDatabase: async () => database,
        homedir,
        inspectAvailability: (persona) =>
          inspectPersonaAvailability(persona, {
            mcpTools,
            models,
            readCredential: (provider) => {
              let credential = credentials.get(provider);
              if (!credential) {
                credential = resolveProviderCredential(provider);
                credentials.set(provider, credential);
              }
              return credential;
            },
          }),
      });
    } finally {
      filesystem.dispose();
    }
  };
}
