/**
 * Persona discovery IPC handlers (desktop main). Lists built-in + user-defined
 * personas — INCLUDING invalid user files with their parse/validation error —
 * for the Settings → Subagents panel. Mirrors ipc-user-commands-handlers:
 * injected fs + DB for unit tests, SecureRoot-backed real disk in production.
 */

import { homedir } from 'node:os';
import {
  type AssistantPersonaListItem,
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
} from '@brainstrike/assistant-contract';
import {
  scanUserPersonas,
  type UserPersonaScanEntry,
} from './assistant-server/user-personas-loader';
import {
  createNodeFsScanDeps,
  resolveScanRoots,
  type UserCommandsListDeps,
} from './ipc-user-commands-handlers';

/** Same deps shape as the commands list handler (fs + DB + homedir). */
export type UserPersonasListDeps = UserCommandsListDeps;

function toListItem(entry: UserPersonaScanEntry): AssistantPersonaListItem {
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
    source: 'built-in',
    status: 'ok',
  }));
  const roots = await resolveScanRoots(deps.getDatabase);
  const scan = scanUserPersonas({ homeDir: deps.homedir(), roots }, deps.fs);
  return { personas: [...builtIns, ...scan.entries.map(toListItem)] };
}

/**
 * Production entry point: real DB host, home dir, and SecureRoot disk fs. The
 * DB loader is imported lazily so this module stays cheap at registration time.
 */
export function createUserPersonasListHandler(): () => Promise<AssistantPersonasListResult> {
  return async () => {
    const filesystem = createNodeFsScanDeps();
    try {
      return await listUserPersonas({
        fs: filesystem,
        getDatabase: async () => {
          const { getDatabase } = await import('./db-main');
          return getDatabase();
        },
        homedir,
      });
    } finally {
      filesystem.dispose();
    }
  };
}
