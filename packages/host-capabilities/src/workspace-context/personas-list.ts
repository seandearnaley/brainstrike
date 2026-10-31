/**
 * Persona discovery for the Settings → Subagents panel: built-in and
 * user-defined personas, INCLUDING invalid user files with their
 * parse/validation error and files a higher tier shadows. Injected fs and roots
 * for unit tests, SecureRoot-backed real disk in production.
 */

import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import {
  type AssistantPersonaAvailability,
  type AssistantPersonaDefinition,
  type AssistantPersonaListItem,
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
  personaScope,
} from '@brainstrike/assistant-contract';
import {
  scanUserPersonas,
  type UserPersonaScanDeps,
  type UserPersonaScanEntry,
} from '@brainstrike/assistant-service/node-workspace-services';

export interface UserPersonasListDeps {
  /** Injected fs surface (real disk in production, in-memory in tests). */
  readonly fs: UserPersonaScanDeps;
  /** The user's home directory (for `~/.brainstrike` / `~/.claude`). */
  readonly homedir: () => string;
  readonly inspectAvailability?: (
    persona: AssistantPersonaDefinition
  ) => Promise<AssistantPersonaAvailability>;
  /** ADR-0032: the roots whose project personas load, the ones the person trusted. */
  readonly roots: readonly RuntimeWorkspaceRoot[];
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
  const roots = deps.roots.map((root) => ({
    absPath: root.path,
    displayName: root.displayName,
    id: root.rootId,
  }));
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
