/**
 * BST-1777 Task 5: runSkillScript must cancel its underlying process when the
 * per-tool execution guard gives up, not only when the run's own abort signal
 * fires — otherwise the model is told the call failed while the child process
 * (and any orphaned retry race) keeps running.
 */
import { registerToolGuardDeadlineSignal } from '@brainstrike/agent';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import { expect, test, vi } from 'vitest';
import {
  ReadWorkspaceFileCursorRegistry,
  runSkillScriptExecutor,
} from '../src/native-tools/index.js';

const runSkillScript = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('../src/native-tools/run-skill-script-tool.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/native-tools/run-skill-script-tool.js')>()),
  runSkillScript: (...args: unknown[]) => runSkillScript(...args),
}));

test('runSkillScript aborts on the guard deadline even though the run signal never fires', async () => {
  const budget = CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget;
  const tool = runSkillScriptExecutor(
    { resolveScriptExecution: vi.fn() },
    {
      resolvePythonExecutable: vi.fn(),
      windowsCommandEntry: () => '/host/windows-command-entry.mjs',
    }
  )({
    ports: {
      artifactReader: undefined,
      canvas: undefined,
      fileMutations: {
        edits: () => {
          throw new Error('runSkillScript never edits through the tracker');
        },
      },
      taskList: undefined,
    },
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolveActiveDomainCharBudget: () => budget,
    resolvedDomainCharBudget: budget,
    runtimeData: {},
  });
  if (typeof tool?.execute !== 'function') {
    throw new Error('The runSkillScript executor built no executable definition');
  }
  // Core's execution options reduced to what the guard reads.
  const execute = tool.execute as (input: unknown, options: unknown) => Promise<unknown>;
  const runController = new AbortController();
  const guardController = new AbortController();
  const context = { abortSignal: runController.signal, toolCallId: 'call-y' };
  const release = registerToolGuardDeadlineSignal([{}, context], guardController.signal);

  try {
    await execute(
      {
        cwd: '.',
        root: '.',
        runtime: 'python3',
        scriptPath: 'scripts/demo.py',
        skillName: 'demo',
      },
      context
    );

    const [, , , options] = runSkillScript.mock.calls.at(-1) as [
      unknown,
      unknown,
      unknown,
      { signal?: AbortSignal },
    ];
    expect(options.signal?.aborted).toBe(false);
    guardController.abort(new Error('guard'));
    expect(options.signal?.aborted).toBe(true);
    expect(runController.signal.aborted).toBe(false);
  } finally {
    // The deadline registry is module-global and keyed by tool-call id:
    // a failed expectation must not leak this id into later cases.
    release();
  }
});
