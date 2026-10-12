import type { RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { buildHostNativeTools, nativeRuntimeFor } from './_host-native-tools';
import { requireToolExecute } from './_tool-test-helpers';

type RunSkillScript = typeof import('../../assistant-server/run-skill-script-tool').runSkillScript;

const desktopResolverMock = vi.hoisted(() => vi.fn(async () => '/bundled/python3'));
const bundledResolverMock = vi.hoisted(() => vi.fn(async () => '/bundled/python3'));
const runSkillScriptMock = vi.hoisted(() =>
  vi.fn<RunSkillScript>(
    async () => ({ stub: true }) as unknown as Awaited<ReturnType<RunSkillScript>>
  )
);

vi.mock('../../python-runtime/resolve-python-binary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../python-runtime/resolve-python-binary')>()),
  resolvePythonBinary: bundledResolverMock,
}));

vi.mock('../../python-runtime', () => ({
  resolveDesktopPythonExecutable: desktopResolverMock,
}));

vi.mock('../../assistant-server/run-skill-script-tool', () => ({
  runSkillScript: runSkillScriptMock,
}));

const runtimeData = {
  workspaceRoots: [{ displayName: 'Site A', path: '/tmp/root-a', rootId: 'root-a' }],
} as RuntimeData;

const input = {
  cwd: '.',
  root: 'root-a',
  runtime: 'python3',
  scriptPath: 'scripts/x.py',
  skillName: 'site-design',
};

function passedResolver(): ((signal?: AbortSignal) => Promise<string>) | undefined {
  const options = runSkillScriptMock.mock.calls[0]?.[3] as
    | { resolvePythonExecutable?: (signal?: AbortSignal) => Promise<string> }
    | undefined;
  return options?.resolvePythonExecutable;
}

/**
 * BST-1061 regression guard: the production default for the `python3`
 * skill-script runtime is the bundled-CPython resolver. If this wiring is
 * dropped, python3 fails at runtime with "no resolver injected" while every
 * test that injects its own resolver stays green — exactly the silent gap
 * this file exists to close.
 */
describe('run_skill_script bundled-Python wiring', () => {
  beforeEach(() => {
    runSkillScriptMock.mockClear();
    bundledResolverMock.mockClear();
  });

  it("defaults resolvePythonExecutable to the bundled CPython the host's launch app paths name", async () => {
    // Main admitted skills for the run; the launching desktop's facts name the runtime.
    const tools = buildHostNativeTools(runtimeData, {
      appPaths: { isPackaged: true, resourcesPath: '/resources', userDataPath: '/user-data' },
      ids: [NATIVE_TOOL_ID.runSkillScript],
      native: nativeRuntimeFor(runtimeData, { skills: [] }),
    });
    const executeTool = requireToolExecute(tools, NATIVE_TOOL_ID.runSkillScript);
    await executeTool(input);
    expect(runSkillScriptMock).toHaveBeenCalledTimes(1);
    const resolvePythonExecutable = passedResolver();
    if (!resolvePythonExecutable) {
      throw new Error('runSkillScript received no bundled-Python resolver');
    }
    await expect(resolvePythonExecutable()).resolves.toBe('/bundled/python3');
    expect(bundledResolverMock).toHaveBeenCalledExactlyOnceWith({
      resourcesDir: '/resources/python-runtime',
      signal: undefined,
      userDataDir: '/user-data',
    });
  });
});

/**
 * LEGACY-ONLY (BST-1980 C2 deletes this with `assistant-tools.ts`): Main's
 * legacy builder let a caller override its default resolver. The host takes
 * the resolver as a required `runSkillScriptExecutor` argument, so it has no
 * default-versus-override precedence.
 */
describe('legacy run_skill_script resolver override', () => {
  beforeEach(() => {
    runSkillScriptMock.mockClear();
    desktopResolverMock.mockClear();
  });

  it('prefers an injected resolver over the desktop default', async () => {
    const injected = vi.fn(async () => '/injected/python3');
    const tools = buildDesktopAssistantTools(runtimeData, {
      resolvePythonExecutable: injected,
      skillScriptResolver: { resolveScriptExecution: vi.fn() },
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    await executeTool(input);
    const options = runSkillScriptMock.mock.calls[0]?.[3] as
      | { resolvePythonExecutable?: () => Promise<string> }
      | undefined;
    expect(options?.resolvePythonExecutable).toBe(injected);
  });
});
