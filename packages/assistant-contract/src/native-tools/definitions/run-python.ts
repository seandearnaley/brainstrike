import { defineNativeTool } from '../define.js';
import { RunPythonInputSchema } from '../schemas/schemas-execution.js';

// Arbitrary agent-authored Python. Sandboxed (OS fence, no network, writes
// confined to a per-call scratch dir), but still 'execute': the fence bounds
// the blast radius, it does not make running attacker-influenceable code a
// read. 'execute' also keeps it out of plan mode — plan-mode-tool-gate.ts
// pins that with brainstrike.runPython as its fixture (BST-1073).
export const runPython = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 190,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'execute',
  },
  description:
    'Run Python in an OS sandbox for computation, parsing, and data wrangling. Network only to allowedDomains you name, each run needing explicit per-call user approval (omit for none); writes only to a scratch dir deleted afterwards; reads unrestricted. print() to return values. Requires approval',
  discovery: { family: 'Python', namespace: 'execution' },
  id: 'brainstrike.runPython',
  inputSchema: RunPythonInputSchema,
  kind: 'desktop',
  returns:
    'A discriminated result: completed (exitCode, stdout, stderr, per-stream omitted byte counts), timed_out, killed, cancelled (partial output), network_denied (deniedDomains — rewrite offline), declined (the user did not approve the run), or unavailable (no sandbox on this machine).',
  surfaces: ['desktop'],
});
