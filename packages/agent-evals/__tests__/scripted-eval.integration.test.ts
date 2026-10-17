/**
 * The harness end to end through the real standalone CLI host: task 1 in
 * scripted mode passes, scored from the committed log; the same run with a
 * verifier that exits 1 fails (the mutation check); a replay whose requests
 * the cassette never recorded fails with the refused key.
 */
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { runEvalTask } from '../src/runner.js';
import { type LoadedEvalTask, loadEvalTask } from '../src/task.js';

const TASKS = resolve(import.meta.dirname, '../tasks');

function withVerifier(loaded: LoadedEvalTask, command: readonly string[]): LoadedEvalTask {
  return { ...loaded, task: { ...loaded.task, verify: { command: [...command] } } };
}

test('fix-failing-test passes in scripted mode, with metrics from the committed log', {
  timeout: 300_000,
}, async () => {
  const loaded = await loadEvalTask(join(TASKS, 'fix-failing-test'));
  const result = await runEvalTask(loaded, { batch: 'integration', mode: 'scripted' });
  expect(result).toMatchObject({
    metrics: {
      approvals: 1,
      steps: 3,
      toolCalls: {
        brainstrike_readWorkspaceFile: 1,
        brainstrike_stringReplaceWorkspaceFile: 1,
      },
    },
    mode: 'scripted',
    modelId: 'scripted::fix-failing-test',
    pass: true,
    reason: null,
    task: 'fix-failing-test',
    verdict: 'completed',
    verifierExitCode: 0,
  });
  expect(result.metrics?.wallMs).toBeGreaterThanOrEqual(0);
});

test('the same scripted run fails when its verifier exits 1', { timeout: 300_000 }, async () => {
  const loaded = await loadEvalTask(join(TASKS, 'fix-failing-test'));
  const result = await runEvalTask(withVerifier(loaded, ['node', '-e', 'process.exit(1)']), {
    batch: 'integration',
    mode: 'scripted',
  });
  expect(result).toMatchObject({ pass: false, verdict: 'completed', verifierExitCode: 1 });
  expect(result.reason).toMatch(/^The verifier exited 1/u);
});

test('a replay whose request the cassette never recorded fails, naming the refused key', {
  timeout: 300_000,
}, async () => {
  const loaded = await loadEvalTask(join(TASKS, 'parallel-read'));
  const result = await runEvalTask(
    { ...loaded, task: { ...loaded.task, prompt: 'A prompt this cassette never recorded.' } },
    { batch: 'integration', mode: 'replay' }
  );
  expect(result.pass).toBe(false);
  expect(result.reason).toMatch(
    /^The provider boundary refused 1 provider request\(s\): unrecorded exchange POST OPENAI_BASE_URL\/responses model=gpt-6-luna/u
  );
});
