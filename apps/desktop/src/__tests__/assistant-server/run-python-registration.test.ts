import type { RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import { requireTool } from './_tool-test-helpers';

const fenceSupport = vi.hoisted(() => ({
  factory: vi.fn(() => undefined),
  isSupported: vi.fn(() => true),
}));
const helperPath = vi.hoisted(() =>
  vi.fn(() => '/resources/app.asar.unpacked/seccomp/apply-seccomp')
);
const bundledPython = vi.hoisted(() => vi.fn(async () => '/bundled/python3'));
vi.mock('../../sandbox-runtime-path', () => ({ resolveDesktopSeccompApplyPath: helperPath }));
vi.mock('../../python-runtime/resolve-python-binary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../python-runtime/resolve-python-binary')>()),
  resolvePythonBinary: bundledPython,
}));
vi.mock('@brainstrike/agent/fence-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/agent/fence-executor')>()),
  createFenceExecutorFactory: fenceSupport.factory,
  isFenceSupported: fenceSupport.isSupported,
}));

interface RegisteredRunPythonTool {
  execute: (input: unknown, options: unknown) => Promise<unknown>;
  id?: unknown;
  inputSchema?: unknown;
}

const runtimeData = {
  workspaceRoots: [{ displayName: 'Site A', path: '/tmp/root-a', rootId: 'root-a' }],
} as RuntimeData;

/** The agent host's run_python, resolved from the launching desktop's app paths. */
function toolsFor(overrides: Partial<RuntimeData> = {}) {
  return buildHostNativeTools(
    { ...runtimeData, ...overrides },
    {
      appPaths: { isPackaged: true, resourcesPath: '/resources', userDataPath: '/user-data' },
      ids: [NATIVE_TOOL_ID.runPython],
    }
  );
}

function requireRunPythonTool(tools: ReturnType<typeof toolsFor>): RegisteredRunPythonTool {
  const tool = requireTool(tools, NATIVE_TOOL_ID.runPython) as unknown as RegisteredRunPythonTool;
  if (typeof tool.execute !== 'function') {
    throw new Error('expected run_python to have an execute implementation');
  }
  return tool;
}

/**
 * Desktop's run_python: the shared executor (host-capabilities
 * `run-python-executor.test.ts`) over the bundled CPython and packaged seccomp
 * helper its launch app paths name.
 */
describe('desktop run_python wiring', () => {
  it('registers run_python for a normal provider', () => {
    expect(toolsFor()).toHaveProperty(NATIVE_TOOL_ID.runPython);
  });

  it('injects the bundled interpreter and the desktop physical helper into the fence', async () => {
    fenceSupport.factory.mockClear();
    const tool = requireRunPythonTool(toolsFor());
    await tool.execute({ code: 'print(1)' }, undefined);
    expect(fenceSupport.factory).toHaveBeenCalledExactlyOnceWith({
      interpreters: {
        python: {
          command: '/bundled/python3',
          // BST-1627: no bytecode beside the shipped (on macOS, signed) tree.
          env: { PYTHONDONTWRITEBYTECODE: '1' },
          scriptExtension: 'py',
        },
      },
      linuxSeccompApplyPath: '/resources/app.asar.unpacked/seccomp/apply-seccomp',
    });
  });
});
