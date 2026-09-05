import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { RunSkillScriptInputSchema } from '../schemas/schemas-execution.js';

export const runSkillScript = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 220,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'execute',
  },
  description:
    "Run an enabled Agent Skill's listed script with literal argv in a mounted root/cwd. Resolution and approval required",
  discovery: { family: 'skill scripts', namespace: 'skills' },
  id: 'brainstrike.runSkillScript',
  inputSchema: providerCompatibleInputSchema(RunSkillScriptInputSchema),
  kind: 'desktop',
  returns:
    'Resolved skill identity/source tier, mounted root, exit status, bounded stdout/stderr tail, duration, timeout, and truncation state',
  surfaces: ['desktop'],
});
