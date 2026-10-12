import { type RuntimeData, registerToolGuardDeadlineSignal } from '@brainstrike/agent';
import {
  DESKTOP_NATIVE_TOOL_IDS,
  NATIVE_TOOL_ID,
  SKILL_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import { SHARED_NATIVE_TOOL_EXECUTORS } from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  desktopHostToolExecutors,
  type HostAppPaths,
  isHostExecutedNativeToolId,
} from '../../agent-host-platform/host-executed-tools';
import type { NativeToolExecutorMap } from '../../assistant-server/native-tool-executors';
import { NATIVE_TOOL_EXECUTORS } from '../../assistant-server/native-tool-executors';
import {
  buildHostNativeTools,
  nativeRuntimeFor,
  unexpectedMainRequest,
} from './_host-native-tools';
import { requireToolExecute } from './_tool-test-helpers';

const runExecuteCommandWithShellCorrelation = vi.fn().mockResolvedValue({});
vi.mock('../../assistant-server/execute-command-correlation', () => ({
  runExecuteCommandWithShellCorrelation: (...args: unknown[]) =>
    runExecuteCommandWithShellCorrelation(...args),
}));

const runSkillScript = vi.fn().mockResolvedValue({});
vi.mock('../../assistant-server/run-skill-script-tool', () => ({
  runSkillScript: (...args: unknown[]) => runSkillScript(...args),
}));

const runtime: RuntimeData = {};
/** A launching desktop's facts: with them the host builds run_python and runSkillScript. */
const APP_PATHS: HostAppPaths = {
  isPackaged: true,
  resourcesPath: '/resources',
  userDataPath: '/user-data',
};
/** Main admitted skills for the run (none needed here: the script runner is mocked). */
const NATIVE_WITH_SKILLS = nativeRuntimeFor(runtime, { skills: [] });

/**
 * The host's executor fold is the adapter half of the native-tool contract:
 * every `brainstrike.*` definition a desktop run can admit is executed by the
 * agent host and has exactly one executor there (shared or Desktop's own), so
 * no admitted descriptor can reach a host without a way to run it.
 */
describe('host-executed native tools', () => {
  it('has exactly one host executor per desktop catalog id, beside the skill tools', () => {
    const executors = {
      ...SHARED_NATIVE_TOOL_EXECUTORS,
      ...desktopHostToolExecutors(
        unexpectedMainRequest,
        'host-thread',
        NATIVE_WITH_SKILLS,
        APP_PATHS
      ),
    };
    expect(Object.keys(executors).sort()).toEqual(
      [...DESKTOP_NATIVE_TOOL_IDS, ...SKILL_NATIVE_TOOL_IDS].sort()
    );
    for (const toolId of DESKTOP_NATIVE_TOOL_IDS) {
      expect(isHostExecutedNativeToolId(toolId), toolId).toBe(true);
      expect(typeof (executors as Record<string, unknown>)[toolId], toolId).toBe('function');
    }
  });
});

/**
 * LEGACY-ONLY (BST-1980 C2 deletes this with `native-tool-executors.ts`): the
 * legacy map's compile-time exhaustiveness. The host's fold is a plain record,
 * pinned at runtime by the case above.
 */
describe('legacy NATIVE_TOOL_EXECUTORS', () => {
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

  it('executeCommand aborts on the guard deadline even though the run signal never fires', async () => {
    const runController = new AbortController();
    const guardController = new AbortController();
    const context = { abortSignal: runController.signal, toolCallId: 'call-x' };
    const release = registerToolGuardDeadlineSignal([{}, context], guardController.signal);

    try {
      const execute = requireToolExecute(
        buildHostNativeTools(runtime, { ids: [NATIVE_TOOL_ID.executeCommand] }),
        NATIVE_TOOL_ID.executeCommand
      );
      await execute({ command: 'echo hi' }, context);

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
      const execute = requireToolExecute(
        buildHostNativeTools(runtime, {
          appPaths: APP_PATHS,
          ids: [NATIVE_TOOL_ID.runSkillScript],
          native: NATIVE_WITH_SKILLS,
        }),
        NATIVE_TOOL_ID.runSkillScript
      );
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
});
