import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { ExecuteCommandInputSchema } from '../schemas/schemas-execution.ts';

// Arbitrary shell execution — THE highest-risk native tool. A host with the OS
// fence runs it sandboxed (BST-2328), but a command can still change anything
// in its open folder, and `dangerouslyDisableSandbox` leaves the sandbox, so it
// is pinned to the 'execute' risk bucket and requires approval.
// When the permission engine enforces a policy and `execute` is `'ask'` (the
// default), this tool SUSPENDS for per-call approval before it runs (Mastra's
// per-tool requireApproval); it is omitted from the map only as a fail-safe
// when there is no workflow storage to resume the suspend, or when `execute`
// is `'deny'`. `'allow'`/YOLO runs it unprompted.
export const executeCommand = defineNativeTool({
  activity: { active: 'Running', done: 'Ran', family: 'run', request: 'Run' },
  defaults: {
    category: 'action',
    estimatedTokens: 180,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'execute',
  },
  description:
    'Run a shell command for tests, builds, git, and other tools. Where the result says sandboxed, it can write only in its open folder and TMPDIR, with no network; otherwise it can change anything the user can. Never run destructive commands unless explicitly requested. Requires per-call approval by default. Starts in a chosen open root; kills the process tree on timeout. Returns exitCode, bounded stdout/stderr tail, and durationMs',
  executionBudget: { defaultMs: 120_000, maxMs: 600_000 },
  id: 'brainstrike.executeCommand',
  inputSchema: effectToolInputSchema(ExecuteCommandInputSchema),
  kind: 'desktop',
  returns:
    'exitCode (null when killed by signal), the terminating signal, a budget-bounded tail of stdout and stderr (truncated flag + hint when trimmed), durationMs, timedOut, sandboxed, and the resolved cwd',
  surfaces: ['desktop', 'web'],
});
