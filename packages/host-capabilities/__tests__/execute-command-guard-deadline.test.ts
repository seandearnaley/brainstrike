/**
 * BST-1777 Task 5: executeCommand must cancel its underlying process when the
 * per-tool execution guard gives up, not only when the run's own abort signal
 * fires — otherwise the model is told the call failed while the child process
 * (and any orphaned retry race) keeps running.
 */
import { registerToolGuardDeadlineSignal } from '@brainstrike/agent';
import { expect, test, vi } from 'vitest';
import { executeCommandTool } from './fixtures/execute-command.js';

const runExecuteCommandWithShellCorrelation = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('../src/native-tools/execute-command-correlation.js', () => ({
  runExecuteCommandWithShellCorrelation: (...args: unknown[]) =>
    runExecuteCommandWithShellCorrelation(...args),
}));

test('executeCommand aborts on the guard deadline even though the run signal never fires', async () => {
  const runController = new AbortController();
  const guardController = new AbortController();
  const context = { abortSignal: runController.signal, toolCallId: 'call-x' };
  const release = registerToolGuardDeadlineSignal([{}, context], guardController.signal);

  try {
    await executeCommandTool({}).execute({ command: 'echo hi' }, context);

    const [, , options] = runExecuteCommandWithShellCorrelation.mock.calls.at(-1) as [
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
