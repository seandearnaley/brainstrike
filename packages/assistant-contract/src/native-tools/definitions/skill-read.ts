import { z } from 'zod';
import { defineNativeTool } from '../define.js';

// Agent Skills tool (https://agentskills.io). This is Mastra's OWN canonical
// tool id (`skill_read`, deliberately NOT `brainstrike.*`-namespaced) created
// via `createSkillTools` and folded into the runtime tool map BEFORE
// guards/hooks/plan-mode/permission — so it needs registry risk entries like
// every native tool. READ-ONLY: it reads skill content the user installed on
// disk; skill scripts run through typed `brainstrike.runSkillScript` and its
// 'execute' approval gate. Explicit 'read' keeps it free under the default
// policy and available in plan mode (an investigation tool).
export const skillRead = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 120,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Read a bundled file from an activated skill directory (references/, scripts/, or assets/), optionally sliced by startLine/endLine. Read-only and containment-checked to the skill directory',
  discovery: { namespace: 'skills' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    endLine: 'Ending line number (1-indexed, inclusive); omit to read to the end.',
    path: 'Path relative to the skill root, e.g. "references/forms.md" or "scripts/fill.py".',
    skillName: 'The skill name (or directory path when two skills share a name).',
    startLine: 'Starting line number (1-indexed); omit to read from the beginning.',
  },
  id: 'skill_read',
  // The provider contract `skill-tools.ts` imposes over Mastra's own schema.
  inputSchema: z.object({
    endLine: z.number().optional(),
    path: z.string(),
    skillName: z.string(),
    startLine: z.number().optional(),
  }),
  kind: 'skill',
  providerDescription: 'Read a skill reference, script, or asset by relative path.',
  returns:
    'The file content (or the requested line slice); binary files report their size instead of raw bytes; oversized output is truncated with a line-range hint.',
});
