import { z } from 'zod';
import { defineNativeTool } from '../define.js';

// Agent Skills tools (https://agentskills.io). These are Mastra's OWN
// canonical tool ids (`skill`/`skill_read`/`skill_search`, deliberately NOT
// `brainstrike.*`-namespaced) created via `createSkillTools` and folded into
// the runtime tool map BEFORE guards/hooks/plan-mode/permission — so they
// need registry risk entries like every native tool. All three are
// READ-ONLY: they load, search, and read skill content the user installed on
// disk; skill scripts run through typed `brainstrike.runSkillScript` and
// its 'execute' approval gate. Explicit 'read' keeps these tools free under the
// default policy and available in plan mode (investigation tools).
export const skill = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 90,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    "Activate an Agent Skill by name: loads the skill's full SKILL.md instructions into the conversation, plus a listing of its bundled references/scripts/assets. Read-only; activate proactively when a task matches a skill's description",
  discovery: { namespace: 'skills' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    name: 'The skill name from the available-skills list (or its directory path when two skills share a name).',
  },
  id: 'skill',
  // The provider contract `skill-tools.ts` imposes over Mastra's own schema.
  inputSchema: z.object({ name: z.string() }),
  kind: 'skill',
  providerDescription: 'Activate a skill by name or path.',
  returns:
    'The skill instructions (SKILL.md body) followed by listings of its references/, scripts/, and assets/ files; oversized instructions are truncated with an honest note.',
});
