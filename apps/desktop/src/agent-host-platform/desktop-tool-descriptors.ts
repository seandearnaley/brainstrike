/**
 * The tools an admission offers a host run, described from the catalog and the
 * admitted state alone. A descriptor names a tool; the host's shared native
 * tools carry its schema and executor (b74a3a77c).
 */
import { createSanitizedToolNameMap } from '@brainstrike/agent/tool-runtime';
import {
  DESKTOP_NATIVE_TOOLS,
  isDesktopNativeToolId,
  NATIVE_TOOL_ID,
  resolveToolRiskCategory,
  SKILL_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import type { PlatformSelectionSchema } from './platform-wire';

export type DesktopToolDescriptor = (typeof PlatformSelectionSchema)['Encoded']['tools'][string];

/** What an admission decided that changes which tools exist. */
export interface DesktopToolAdmission {
  /**
   * BST-2360: this host runs code inside the OS fence. run_python runs nowhere
   * else, so a host without one (Windows) leaves it out of the run instead of
   * asking the person to approve a call that cannot run.
   */
  readonly codeFence: boolean;
  readonly enabledNativeToolIds: readonly string[];
  /** The run's scanned workspace skills: the skill tools and runSkillScript exist only with them. */
  readonly skills: boolean;
}

function admitted(id: string, admission: DesktopToolAdmission): boolean {
  if (id === NATIVE_TOOL_ID.runPython) {
    return admission.codeFence;
  }
  if (id === NATIVE_TOOL_ID.runSkillScript) {
    return admission.skills;
  }
  return true;
}

function describe(id: string): DesktopToolDescriptor {
  const definition = NATIVE_TOOL_REGISTRIES.byId[id as keyof typeof NATIVE_TOOL_REGISTRIES.byId];
  return {
    // A skill tool's wire text is its compact provider description.
    description:
      definition.kind === 'skill' ? definition.providerDescription : definition.description,
    identity: id,
    permissionToolId: id,
    risk: resolveToolRiskCategory(definition.defaults),
  };
}

/**
 * The admission's tools keyed by their provider names: the enabled native
 * tools its rules keep, then the skill tools when the run scanned skills.
 */
export function desktopToolDescriptors(
  admission: DesktopToolAdmission
): Record<string, DesktopToolDescriptor> {
  if (admission.enabledNativeToolIds.some((id) => !isDesktopNativeToolId(id))) {
    throw new Error('Enabled native tool preferences contain unknown tool IDs.');
  }
  const enabled = new Set(admission.enabledNativeToolIds);
  const ids = [
    ...DESKTOP_NATIVE_TOOLS.map((tool) => tool.id).filter(
      (id) => enabled.has(id) && admitted(id, admission)
    ),
    ...(admission.skills ? SKILL_NATIVE_TOOL_IDS : []),
  ];
  return Object.fromEntries(
    [...createSanitizedToolNameMap(ids)].map(([name, id]) => [name, describe(id)] as const)
  );
}
