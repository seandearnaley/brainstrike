/**
 * run_python over an injected code-execution host, as every agent host builds
 * it (Desktop's bundled CPython, the CLI's system Python). Approval of the run
 * and each networked call's consent are the host's cards, pinned in
 * `packages/agent-host/__tests__/network-consent.integration.test.ts`; the
 * shared tool's own refusals are in `packages/agent/src/__tests__/run-python-tool.spec.ts`.
 * These pin what the executor adds: nothing it wires lets a networked call run
 * without the host's decision, and the host's interpreter and helper are what
 * the fence runs.
 */

import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type CodeExecutionHost,
  ReadWorkspaceFileCursorRegistry,
  runPythonExecutor,
  SystemPythonUnavailableError,
} from '../src/native-tools/index.js';

const fence = vi.hoisted(() => ({
  factory: vi.fn(() => undefined),
  isSupported: vi.fn(() => true),
}));
vi.mock('@brainstrike/agent/fence-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/agent/fence-executor')>()),
  createFenceExecutorFactory: fence.factory,
  isFenceSupported: fence.isSupported,
}));

interface RunPythonDefinition {
  readonly execute: (input: unknown, options?: unknown) => Promise<unknown>;
  readonly id?: unknown;
  readonly inputSchema?: unknown;
}

function runPython(host: Partial<CodeExecutionHost> = {}): {
  readonly host: CodeExecutionHost;
  readonly tool: RunPythonDefinition;
} {
  const injected: CodeExecutionHost = {
    resolvePythonExecutable: vi.fn(async () => '/host/python3'),
    resolveSeccompApplyPath: () => '/host/apply-seccomp',
    windowsCommandEntry: () => '/host/windows-command-entry.mjs',
    ...host,
  };
  const budget = CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget;
  const tool = runPythonExecutor(injected)({
    ports: {
      artifactReader: undefined,
      canvas: undefined,
      fileMutations: {
        edits: () => {
          throw new Error('run_python never edits through the tracker');
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
    throw new Error('The run_python executor built no executable definition');
  }
  return { host: injected, tool: tool as RunPythonDefinition };
}

beforeEach(() => {
  fence.factory.mockClear();
  fence.isSupported.mockClear();
});

describe('run_python registration', () => {
  test('builds the shared producer: its id, input schema and execute', () => {
    const { tool } = runPython();
    expect(tool.id).toBe(NATIVE_TOOL_ID.runPython);
    expect(validateToolInputValue(tool.inputSchema, { code: 'print(1)' }).success).toBe(true);
  });

  test('refuses a networked call without the host decision before resolving Python or a sandbox', async () => {
    const { host, tool } = runPython();
    await expect(
      tool.execute({ allowedDomains: ['pypi.org'], code: 'print(1)' })
    ).resolves.toMatchObject({ kind: 'unavailable', reason: 'network_confirmation_unavailable' });
    expect(host.resolvePythonExecutable).not.toHaveBeenCalled();
    expect(fence.factory).not.toHaveBeenCalled();
  });

  test("settles the host's network denial as network_denied without running", async () => {
    const { host, tool } = runPython();
    await expect(
      tool.execute(
        { allowedDomains: ['example.com'], code: 'print(1)' },
        { resumeData: { action: 'deny' } }
      )
    ).resolves.toEqual({ deniedDomains: ['example.com'], kind: 'network_denied' });
    expect(host.resolvePythonExecutable).not.toHaveBeenCalled();
  });

  test('rejects unrestricted egress at the schema: a bare "*" never parses', () => {
    const { tool } = runPython();
    const accepts = (allowedDomains: readonly string[]) =>
      validateToolInputValue(tool.inputSchema, { allowedDomains, code: 'print(1)' }).success;
    expect(accepts(['*'])).toBe(false);
    expect(accepts(['*.com'])).toBe(false);
    expect(accepts(['pypi.org'])).toBe(true);
  });
});

describe('run_python over the host its agent host injects', () => {
  test("runs the host's interpreter and helper in the fence, never writing bytecode", async () => {
    const { tool } = runPython();
    await tool.execute({ code: 'print(1)' });
    expect(fence.factory).toHaveBeenCalledExactlyOnceWith({
      interpreters: {
        python: {
          command: '/host/python3',
          env: { PYTHONDONTWRITEBYTECODE: '1' },
          scriptExtension: 'py',
        },
      },
      linuxSeccompApplyPath: '/host/apply-seccomp',
    });
  });

  test('leaves the helper to sandbox-runtime where the host names none', async () => {
    const { tool } = runPython({ resolveSeccompApplyPath: () => undefined });
    await tool.execute({ code: 'print(1)' });
    expect(fence.factory).toHaveBeenCalledExactlyOnceWith({
      interpreters: {
        python: {
          command: '/host/python3',
          env: { PYTHONDONTWRITEBYTECODE: '1' },
          scriptExtension: 'py',
        },
      },
    });
  });

  test('reports an unsupported runtime before preparing Python', async () => {
    fence.isSupported.mockReturnValueOnce(false);
    const { host, tool } = runPython();
    await expect(tool.execute({ code: 'print(1)' })).resolves.toMatchObject({
      detail: expect.stringContaining('No user code ran'),
      kind: 'unavailable',
      reason: 'sandbox_unsupported_runtime',
    });
    expect(host.resolvePythonExecutable).not.toHaveBeenCalled();
  });

  test('a host without Python reports interpreter_unavailable with its own instructions', async () => {
    const { tool } = runPython({
      resolvePythonExecutable: () =>
        Promise.reject(new SystemPythonUnavailableError('Install Python 3, then retry.')),
    });
    await expect(tool.execute({ code: 'print(1)' })).resolves.toEqual({
      detail: 'Install Python 3, then retry.',
      kind: 'unavailable',
      reason: 'interpreter_unavailable',
    });
    expect(fence.factory).not.toHaveBeenCalled();
  });
});
