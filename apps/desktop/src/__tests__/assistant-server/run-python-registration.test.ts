import type { RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  type CodeExecutionHost,
  runPythonExecutor,
} from '../../assistant-server/native-tool-executors-python';
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

/** run_python over an injected code-execution host, as the host's fold builds it. */
function toolsWithHost(host: CodeExecutionHost) {
  return buildHostNativeTools(runtimeData, {
    executors: { [NATIVE_TOOL_ID.runPython]: runPythonExecutor(host) },
    ids: [NATIVE_TOOL_ID.runPython],
  });
}

function requireRunPythonTool(tools: ReturnType<typeof toolsFor>): RegisteredRunPythonTool {
  const tool = requireTool(tools, NATIVE_TOOL_ID.runPython) as unknown as RegisteredRunPythonTool;
  if (typeof tool.execute !== 'function') {
    throw new Error('expected run_python to have an execute implementation');
  }
  return tool;
}

/**
 * BST-1067 registration guards, as the agent host owns consent since #3784
 * (BST-2063). Approval of the run is the host's approval card and each
 * networked call's consent is the host's network card, pinned in
 * `packages/agent-host/__tests__/network-consent.integration.test.ts` and
 * `approval-execution-context.integration.test.ts`; the shared tool refuses
 * unconsented domains in `packages/agent/src/__tests__/run-python-tool.spec.ts`.
 * These pin what the desktop registration adds: its own executor is the shared
 * producer, and nothing it wires lets a networked call run without the host's
 * decision (BST-2077).
 */
describe('run_python registration', () => {
  it('registers run_python for a normal provider', () => {
    expect(toolsFor()).toHaveProperty(NATIVE_TOOL_ID.runPython);
  });

  it('registers the shared producer: its id, Effect-authored input schema and execute', () => {
    const tool = requireRunPythonTool(toolsFor());
    expect(tool.id).toBe(NATIVE_TOOL_ID.runPython);
    expect(validateToolInputValue(tool.inputSchema, { code: 'print(1)' }).success).toBe(true);
    expect(typeof tool.execute).toBe('function');
  });

  it('refuses a networked call without the host decision before resolving Python or a sandbox', async () => {
    bundledPython.mockClear();
    fenceSupport.factory.mockClear();
    const tool = requireRunPythonTool(toolsFor());
    // A direct invocation carries no host decision, so even an allowing posture
    // never runs networked code unprompted.
    await expect(
      tool.execute({ allowedDomains: ['pypi.org'], code: 'print(1)' }, undefined)
    ).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'network_confirmation_unavailable',
    });
    expect(bundledPython).not.toHaveBeenCalled();
    expect(fenceSupport.factory).not.toHaveBeenCalled();
  });

  it("settles the host's network denial as network_denied without running", async () => {
    bundledPython.mockClear();
    const tool = requireRunPythonTool(toolsFor());
    await expect(
      tool.execute(
        { allowedDomains: ['example.com'], code: 'print(1)' },
        { resumeData: { action: 'deny' } }
      )
    ).resolves.toEqual({ deniedDomains: ['example.com'], kind: 'network_denied' });
    expect(bundledPython).not.toHaveBeenCalled();
  });

  it('rejects unrestricted egress at the schema: a bare "*" never parses', () => {
    // Gate B makes domains EXPRESSIBLE, but unrestricted egress stays
    // inexpressible: the seam's policyDomainSchema (single source) rejects a
    // bare "*" and single-label wildcards before execute() ever runs.
    // Read through the producer-neutral accessor: the grammar is Effect
    // Schema (ADR-0004) and `safeParse` is zod-only, so naming it here would
    // make this guard pass on which library authored the schema rather than on
    // whether a bare "*" is rejected.
    const tool = requireRunPythonTool(toolsFor());
    const accepts = (allowedDomains: readonly string[]) =>
      validateToolInputValue(tool.inputSchema, { allowedDomains, code: 'print(1)' }).success;

    expect(accepts(['*'])).toBe(false);
    expect(accepts(['*.com'])).toBe(false);
    // A concrete domain request parses; consent to it is the host's network card.
    expect(accepts(['pypi.org'])).toBe(true);
  });
});

describe('run_python sandbox availability wiring', () => {
  it('maps invalid injected helper paths to the typed unavailable result', async () => {
    const actual = await vi.importActual<typeof import('../../sandbox-runtime-path')>(
      '../../sandbox-runtime-path'
    );
    fenceSupport.factory.mockClear();
    const tool = requireRunPythonTool(
      toolsWithHost({
        resolvePythonExecutable: vi.fn(async () => '/injected/python3'),
        resolveSeccompApplyPath: () =>
          actual.resolveDesktopSeccompApplyPath(true, 'relative', 'linux', 'x64'),
      })
    );
    await expect(tool.execute({ code: 'print(1)' }, undefined)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'sandbox_unsupported_runtime',
    });
    expect(fenceSupport.factory).not.toHaveBeenCalled();
  });

  it('uses injected host capabilities without reading Electron application state', async () => {
    const original = Object.getOwnPropertyDescriptor(app, 'isPackaged');
    const readPackagedState = vi.fn(() => {
      throw new Error('The injected tool must not read Electron state.');
    });
    Object.defineProperty(app, 'isPackaged', { configurable: true, get: readPackagedState });
    const resolveSeccompApplyPath = vi.fn(() => '/injected/physical/apply-seccomp');
    fenceSupport.factory.mockClear();
    try {
      const tool = requireRunPythonTool(
        toolsWithHost({
          resolvePythonExecutable: vi.fn(async () => '/injected/python3'),
          resolveSeccompApplyPath,
        })
      );
      await tool.execute({ code: 'print(1)' }, undefined);
      expect(resolveSeccompApplyPath).toHaveBeenCalledExactlyOnceWith();
      expect(readPackagedState).not.toHaveBeenCalled();
      expect(fenceSupport.factory).toHaveBeenCalledExactlyOnceWith({
        interpreters: { python: { command: '/injected/python3', scriptExtension: 'py' } },
        linuxSeccompApplyPath: '/injected/physical/apply-seccomp',
      });
    } finally {
      if (original) {
        Object.defineProperty(app, 'isPackaged', original);
      } else {
        Reflect.deleteProperty(app, 'isPackaged');
      }
    }
  });

  it('injects the desktop physical helper into the actual fence factory options', async () => {
    fenceSupport.factory.mockClear();
    const tool = requireRunPythonTool(toolsFor());
    await tool.execute({ code: 'print(1)' }, undefined);
    expect(fenceSupport.factory).toHaveBeenCalledExactlyOnceWith({
      interpreters: { python: { command: '/bundled/python3', scriptExtension: 'py' } },
      linuxSeccompApplyPath: '/resources/app.asar.unpacked/seccomp/apply-seccomp',
    });
  });

  it('reports an unsupported runtime before preparing Python', async () => {
    fenceSupport.isSupported.mockReturnValueOnce(false);
    const resolvePythonExecutable = vi.fn(async () => '/bundled/python3');
    const tool = requireRunPythonTool(
      toolsWithHost({ resolvePythonExecutable, resolveSeccompApplyPath: helperPath })
    );
    await expect(tool.execute({ code: 'print(1)' }, undefined)).resolves.toMatchObject({
      detail: expect.stringContaining('No user code ran'),
      kind: 'unavailable',
      reason: 'sandbox_unsupported_runtime',
    });
    expect(resolvePythonExecutable).not.toHaveBeenCalled();
  });
});
