import type { RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
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
  inputSchema?: { safeParse: (input: unknown) => { success: boolean } };
  outputSchema?: unknown;
  requireApproval?: unknown;
  resumeSchema?: unknown;
  suspendSchema?: unknown;
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
 * BST-1067 registration guards. These pin properties that fail SILENTLY if
 * broken — the tool would still build, still typecheck, and only misbehave at
 * runtime in the direction that matters.
 */
describe('run_python registration', () => {
  it('registers run_python for a normal provider', () => {
    expect(toolsFor()).toHaveProperty(NATIVE_TOOL_ID.runPython);
  });

  it('is registered as the factory-returned Mastra Tool, not a plain literal', () => {
    // The silent failure this guards: the registry's
    // `{description, execute, id, inputSchema}` literal shape DROPS
    // suspendSchema/resumeSchema. BST-1070 adds a suspendSchema to this tool
    // for the network escalation; if the registration were re-wrapped in that
    // literal, `hasSuspendSchema` would go false, the network prompt would
    // never fire, and the run would proceed with NO error and NO run event.
    // Asserting the real Tool object here arms that guard before the schema
    // exists.
    const tool = requireRunPythonTool(toolsFor());
    // A Mastra Tool instance carries these; an object literal would not.
    expect(typeof tool.execute).toBe('function');
    expect(tool.id).toBe(NATIVE_TOOL_ID.runPython);
    expect(tool.inputSchema).toBeDefined();
    expect(tool.outputSchema).toBeDefined();
    expect(Object.getPrototypeOf(tool)).not.toBe(Object.prototype);
    // GATE B IS ARMED (BST-1070): the registered entry carries the suspend
    // and resume schemas. This is the only guard against the silent bypass
    // above — with hasSuspendSchema false, a non-empty allowedDomains would
    // run with no prompt, no error, and no run event.
    expect(tool.suspendSchema).toBeTruthy();
    expect(tool.resumeSchema).toBeTruthy();
  });

  it('NEVER carries the per-tool requireApproval flag — Gate A is self-raised (BST-1097)', () => {
    // The flag is what made the Gate B resume resolve as "Tool call was not
    // approved by the user" pre-1.56. Since the @mastra/core 1.56+ idiom
    // adoption the FLAG lives on the permission gate's clone (applied per
    // request, downstream of registration) — the REGISTERED form must stay
    // flagless so an un-gated posture (enforcement off) never approval-gates
    // the tool.
    const tool = requireRunPythonTool(toolsFor());
    // createTool initializes the field to `false`; the invariant is that it is
    // never TRUE (truthy is all Mastra's approval step checks).
    expect(tool.requireApproval).not.toBe(true);
  });

  it("derives the DIRECT-invocation guard from the REQUEST's permission snapshot: execute:'ask' with no suspension channel refuses (BST-1097, 1.56+ idiom)", async () => {
    // Inside an agent run Gate A is the permission gate's requireApproval
    // clone (framework pre-execution approval), so execute() raises no
    // approval suspension of its own any more. The registration-derived
    // decision matters for DIRECT invocations: 'ask' with no way to ask must
    // refuse, never run unprompted.
    const tools = toolsFor({
      permissionPolicyRequest: {
        enforce: true,
        policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      },
    } as Partial<RuntimeData>);
    const tool = requireRunPythonTool(tools);
    const result = await tool.execute({ code: 'print(1)' }, undefined);
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'approval_confirmation_unavailable',
    });

    // And INSIDE a run under the same 'ask' snapshot: no in-tool approval
    // suspension — a networked call pauses at Gate B (the plain suspension)
    // as its FIRST pause, proof the framework gate owns Gate A.
    const suspend = vi.fn<(data: unknown, options?: unknown) => Promise<void>>(
      async () => undefined
    );
    const gated = await tool.execute(
      { allowedDomains: ['pypi.org'], code: 'print(1)' },
      {
        agent: { suspend },
      }
    );
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend.mock.calls[0]?.[0]).toEqual({
      allowedDomains: ['pypi.org'],
      kind: 'network',
    });
    expect(gated).toBeUndefined();
  });

  it('no enforced policy → no Gate A: the first suspension is Gate B, exactly as before', async () => {
    const tool = requireRunPythonTool(toolsFor());
    const suspend = vi.fn<(data: unknown, options?: unknown) => Promise<void>>(
      async () => undefined
    );
    // No permissionPolicyRequest on the runtime → Gate A resolves 'allow'
    // (the passthrough posture). A networked call therefore pauses at Gate B
    // first — the plain suspension, WITHOUT the approval option — before any
    // host resolution.
    await tool.execute(
      { allowedDomains: ['example.com'], code: 'print(1)' },
      {
        agent: { suspend },
      }
    );
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend.mock.calls[0]?.[0]).toEqual({
      allowedDomains: ['example.com'],
      kind: 'network',
    });
    expect(
      (suspend.mock.calls[0]?.[1] as { requireToolApproval?: unknown } | undefined)
        ?.requireToolApproval
    ).toBeUndefined();
  });

  it('rejects unrestricted egress at the schema: a bare "*" never parses', () => {
    // Gate B makes domains EXPRESSIBLE, but unrestricted egress stays
    // inexpressible: the seam's policyDomainSchema (single source) rejects a
    // bare "*" and single-label wildcards before execute() ever runs.
    const tool = requireRunPythonTool(toolsFor());
    expect(tool.inputSchema?.safeParse({ allowedDomains: ['*'], code: 'print(1)' }).success).toBe(
      false
    );
    expect(
      tool.inputSchema?.safeParse({ allowedDomains: ['*.com'], code: 'print(1)' }).success
    ).toBe(false);
    // A concrete domain request parses — approval of it is Gate B's job.
    expect(
      tool.inputSchema?.safeParse({ allowedDomains: ['pypi.org'], code: 'print(1)' }).success
    ).toBe(true);
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

/**
 * LEGACY-ONLY (BST-1980 C2 deletes this with `assistant-tools.ts`): the legacy
 * builder's local-provider skip. On the host, admission omits run_python for
 * the built-in local provider (agent-host-admitted-tool-descriptors.integration.test.ts,
 * recorded `local` admission).
 */
describe('legacy run_python local-provider registration', () => {
  it('is EXCLUDED for the built-in local provider', () => {
    // Same reasoning as askUser/submitPlan/manageTaskList: the on-device
    // model's WebGPU prefill budget cannot afford advertising it, and
    // BST-1070's network escalation is structurally unavailable there.
    const tools = buildDesktopAssistantTools({ ...runtimeData, provider: 'local' } as RuntimeData, {
      resolvePythonExecutable: vi.fn(async () => '/bundled/python3'),
    });
    expect(tools).not.toHaveProperty(NATIVE_TOOL_ID.runPython);
  });
});
