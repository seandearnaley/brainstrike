/**
 * The Agent Skills activation and read tools (`skill`, `skill_read`,
 * `skill_search`) over a caller-supplied engine. Every host binds the skills
 * its run admitted and reads their files through its own secure fs.
 */
import { createAssistantSkillTools, type ScannedWorkspaceSkills } from '@brainstrike/agent';
import type { NativeToolExecutor } from './host-tools.ts';

/** `skill`, `skill_read` and `skill_search` over one engine. */
export function skillToolExecutors(
  skills: ScannedWorkspaceSkills
): Readonly<Record<'skill' | 'skill_read' | 'skill_search', NativeToolExecutor>> {
  const tools = createAssistantSkillTools(skills);
  return {
    skill: () => tools.skill,
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_read: () => tools.skill_read,
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_search: () => tools.skill_search,
  };
}
