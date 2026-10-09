/**
 * run_python over a caller-supplied code-execution host: Main resolves the
 * bundled CPython and the Linux sandbox helper from Electron's app facts, the
 * desktop agent host from the app paths it was launched with. This module must
 * not import Electron: the host bundle loads it.
 */
import {
  createRunPythonTool,
  resolveRequestPermissionPolicy,
  resolveSelfApprovalDecision,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { NativeToolExecutor } from '@brainstrike/host-capabilities/native-tools';

/** Where this process finds the bundled interpreter and the sandbox helper. */
export interface CodeExecutionHost {
  /** Resolves (unpacking on first run) the bundled CPython; never a PATH python. */
  readonly resolvePythonExecutable: (signal?: AbortSignal) => Promise<string>;
  /** The packaged Linux seccomp helper; undefined where none applies. */
  readonly resolveSeccompApplyPath: () => string | undefined;
}

export function runPythonExecutor(host: CodeExecutionHost): NativeToolExecutor {
  // BST-1067. Registered as the factory-returned Tool object DIRECTLY (not
  // re-wrapped in the registry's { description, execute, id, inputSchema }
  // literal shape): BST-1070 added a suspendSchema for the network
  // escalation, and the literal would silently drop it — leaving the network
  // gate never firing, with no error and no run event. The catalog marks it
  // `localProvider: 'unregistered'`, so no fold builds it for the built-in
  // local provider.
  return ({ runtimeData }) =>
    createRunPythonTool({
      // Gate A decision (BST-1097): run_python raises its OWN approval
      // suspension instead of carrying Mastra's per-tool
      // `requireApproval` flag (the flag re-fires on the Gate B resume
      // leg and denies it). Resolved lazily at execute() time from THIS
      // request's permission snapshot through the SAME resolvers the
      // permission gate uses (`resolveRequestPermissionPolicy` →
      // `resolveSelfApprovalDecision`), so the tool and the gate cannot
      // disagree about the decision.
      resolveApprovalDecision: () =>
        resolveSelfApprovalDecision(
          resolveRequestPermissionPolicy(runtimeData?.permissionPolicyRequest),
          NATIVE_TOOL_ID.runPython
        ),
      resolveHost: async (signal) => {
        // LAZY import, deliberately. `@brainstrike/agent/fence-executor`
        // pulls in @anthropic-ai/sandbox-runtime AND evaluates
        // `promisify(fs.realpath.native)` at MODULE SCOPE. A top-level
        // import would load all of that merely to BUILD the tool map —
        // on every desktop main startup, and inside every test that
        // imports this registry (measured: it broke 8 suites that mock
        // `node:fs` without a `.native`). Loading it only when a
        // run_python call actually needs an executor is what the seam's
        // Node-only subpath posture intends.
        const { createFenceExecutorFactory, FenceUnsupportedPlatformError, isFenceSupported } =
          await import('@brainstrike/agent/fence-executor');
        // Fence FIRST, interpreter second. On a host with no OS fence
        // (Windows today) the missing half is the sandbox, and resolving
        // the interpreter first would report a python_* failure there —
        // telling the user to fix the interpreter on a machine that
        // could not have run anything anyway, inverting exactly the
        // "which half is missing" distinction the error mapping exists
        // to preserve. It also skips a pointless first-run unpack.
        if (!isFenceSupported()) {
          throw new FenceUnsupportedPlatformError(process.platform);
        }
        const command = await host.resolvePythonExecutable(signal);
        const linuxSeccompApplyPath = host.resolveSeccompApplyPath();
        const fence = createFenceExecutorFactory({
          ...(linuxSeccompApplyPath === undefined ? {} : { linuxSeccompApplyPath }),
          interpreters: { python: { command, scriptExtension: 'py' } },
        });
        // `undefined` on a host with no OS fence (Windows today). Under
        // exactOptionalPropertyTypes an explicit `fence: undefined` is
        // not assignable, and omitting the key is also the honest
        // shape: the capability is ABSENT, and the seam then throws
        // ExecutorKindUnavailableError rather than degrading.
        return fence ? { fence } : {};
      },
    });
}
