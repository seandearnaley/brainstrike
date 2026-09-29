import { registerToolGuardDeadlineSignal } from '@brainstrike/agent';
import { DESKTOP_NATIVE_TOOL_IDS, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_TOOL_EXECUTORS,
  type NativeToolExecutorMap,
} from '../../assistant-server/native-tool-executors';
import { EXECUTION_TOOL_EXECUTORS } from '../../assistant-server/native-tool-executors-execution';

const runExecuteCommandWithShellCorrelation = vi.fn().mockResolvedValue({});
vi.mock('../../assistant-server/execute-command-correlation', () => ({
  runExecuteCommandWithShellCorrelation: (...args: unknown[]) =>
    runExecuteCommandWithShellCorrelation(...args),
}));

const runSkillScript = vi.fn().mockResolvedValue({});
vi.mock('../../assistant-server/run-skill-script-tool', () => ({
  runSkillScript: (...args: unknown[]) => runSkillScript(...args),
}));

/**
 * The executor map is the adapter half of the native-tool contract
 * (BST-1646 step c): exactly one entry per `brainstrike.*` definition. The
 * mapped type makes a missing or stray entry a compile error; this pins the
 * same fact at runtime so a `satisfies Partial<…>` group can never hide one.
 */
describe('NATIVE_TOOL_EXECUTORS', () => {
  it('has exactly one executor per desktop catalog id', () => {
    expect(Object.keys(NATIVE_TOOL_EXECUTORS).sort()).toEqual([...DESKTOP_NATIVE_TOOL_IDS].sort());
    for (const toolId of DESKTOP_NATIVE_TOOL_IDS) {
      expect(typeof NATIVE_TOOL_EXECUTORS[toolId], toolId).toBe('function');
    }
  });

  it('is exhaustive at compile time: dropping one entry is a type error', () => {
    const { [NATIVE_TOOL_ID.grepSearch]: _dropped, ...withoutGrep } = NATIVE_TOOL_EXECUTORS;
    // @ts-expect-error — a map without brainstrike.grepSearch is not a NativeToolExecutorMap
    const incomplete: NativeToolExecutorMap = withoutGrep;
    expect(Object.keys(incomplete)).toHaveLength(DESKTOP_NATIVE_TOOL_IDS.length - 1);
  });
});

/**
 * BST-1777 Task 5: executeCommand and runSkillScript must cancel their
 * underlying process when the per-tool execution guard gives up, not only
 * when the run's own abort signal fires — otherwise the model is told the
 * call failed while the child process (and any orphaned retry race) keeps
 * running.
 */
describe('native execution executors honour the guard deadline', () => {
  beforeEach(() => {
    runExecuteCommandWithShellCorrelation.mockClear();
    runSkillScript.mockClear();
  });

  const buildContext = () => ({
    dependencies: {
      skillScriptResolver: {
        resolveScriptExecution: vi.fn().mockResolvedValue({
          command: 'python3',
          policy: 'trusted',
          scriptPath: '/tmp/script.py',
          sourceTier: 'workspace',
        }),
      },
    },
    isLocalProvider: false,
    readFileCursorRegistry: {} as never,
    resolveActiveDomainCharBudget: () => 1000,
    resolvedDomainCharBudget: 1000,
    runtimeData: undefined,
  });

  it('executeCommand aborts on the guard deadline even though the run signal never fires', async () => {
    const runController = new AbortController();
    const guardController = new AbortController();
    const context = { abortSignal: runController.signal, toolCallId: 'call-x' };
    const release = registerToolGuardDeadlineSignal([{}, context], guardController.signal);

    try {
      const entry = EXECUTION_TOOL_EXECUTORS[NATIVE_TOOL_ID.executeCommand](buildContext()) as
        | { execute: (input: unknown, options: unknown) => Promise<unknown> }
        | undefined;
      if (!entry) {
        throw new Error('executeCommand executor did not build');
      }
      await entry.execute({ command: 'echo hi' }, context);

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

  it('runSkillScript aborts on the guard deadline even though the run signal never fires', async () => {
    const runController = new AbortController();
    const guardController = new AbortController();
    const context = { abortSignal: runController.signal, toolCallId: 'call-y' };
    const release = registerToolGuardDeadlineSignal([{}, context], guardController.signal);

    try {
      const entry = EXECUTION_TOOL_EXECUTORS[NATIVE_TOOL_ID.runSkillScript](buildContext()) as
        | { execute: (input: unknown, options: unknown) => Promise<unknown> }
        | undefined;
      if (!entry) {
        throw new Error('runSkillScript executor did not build');
      }
      await entry.execute(
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
});
