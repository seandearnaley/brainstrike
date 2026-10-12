import type { RuntimeData } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { requireToolExecute } from './_tool-test-helpers';

type RunSkillScript = typeof import('../../assistant-server/run-skill-script-tool').runSkillScript;

const desktopResolverMock = vi.hoisted(() => vi.fn(async () => '/bundled/python3'));
const runSkillScriptMock = vi.hoisted(() =>
  vi.fn<RunSkillScript>(
    async () => ({ stub: true }) as unknown as Awaited<ReturnType<RunSkillScript>>
  )
);

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
    desktopResolverMock.mockClear();
  });

  it('defaults resolvePythonExecutable to the desktop bundled-CPython capability', async () => {
    const tools = buildDesktopAssistantTools(runtimeData, {
      skillScriptResolver: { resolveScriptExecution: vi.fn() },
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    await executeTool(input);
    expect(runSkillScriptMock).toHaveBeenCalledTimes(1);
    const options = runSkillScriptMock.mock.calls[0]?.[3] as
      | { resolvePythonExecutable?: () => Promise<string> }
      | undefined;
    expect(options?.resolvePythonExecutable).toBe(desktopResolverMock);
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
