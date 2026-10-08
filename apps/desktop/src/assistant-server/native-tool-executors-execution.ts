/**
 * Executor entries for the execution, session, and self-inspection tools
 * (BST-1646 step c). Each entry builds the request-scoped Mastra registry
 * object for ONE catalog definition; `native-tool-executors.ts` assembles the
 * exhaustive map.
 */
import {
  createRunPythonTool,
  type InspectCommandSessionsInput,
  type ManageCommandSessionInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RunSkillScriptInput,
  readToolExecutionThreadId,
  resolveGuardedToolSignal,
  resolveRequestPermissionPolicy,
  resolveSelfApprovalDecision,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  parseToolExecuteInput,
  resolveShellOutputStreamer,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { resolveDesktopPythonExecutable } from '../python-runtime';
import { resolveDesktopSandboxHelperPath } from '../sandbox-runtime';
import {
  INSPECT_COMMAND_SESSIONS_TRANSFORM,
  MANAGE_COMMAND_SESSION_TRANSFORM,
  runInspectCommandSessions,
  runManageCommandSession,
} from './command-session-tools';
import { executorGroup } from './native-tool-executor-context';
import { selfInspectionExecutors } from './native-tool-executors-self';
import { executeCommandExecutor } from './native-tool-executors-shell';
import { mainDiagnosticsReader } from './query-diagnostics-tool';
import { mainQuerySelfRead } from './query-self-tool';
import { runSkillScript } from './run-skill-script-tool';

export const EXECUTION_TOOL_EXECUTORS = executorGroup({
  // Main correlates a legacy thread's commands through its own worktree/forge services.
  [NATIVE_TOOL_ID.executeCommand]: (context) =>
    executeCommandExecutor(() => context.dependencies)(context),
  // Skill execution is capability-gated by the trusted per-request scan
  // engine: no resolver, no tool (the enabled-id filter in assistant-tools.ts
  // treats that omission as the explicit capability result).
  [NATIVE_TOOL_ID.runSkillScript]: ({ dependencies, runtimeData }) => {
    const skillScriptResolver = dependencies.skillScriptResolver;
    if (!skillScriptResolver) {
      return;
    }
    return {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.runSkillScript],
      execute: async (
        input: ToolExecuteInput<RunSkillScriptInput>,
        options?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
          input
        );
        const stream = resolveShellOutputStreamer(options, (error) => {
          logToolFailure('runSkillScript output streaming failed', error, resolvedInput);
        });
        try {
          return await runSkillScript(resolvedInput, runtimeData, skillScriptResolver, {
            resolvePythonExecutable:
              dependencies.resolvePythonExecutable ?? resolveDesktopPythonExecutable,
            signal: resolveGuardedToolSignal(options),
            ...(stream ? { stream } : {}),
          });
        } catch (error) {
          logToolFailure('runSkillScript failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.runSkillScript,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
    };
  },
  // BST-1067. Registered as the factory-returned Tool object DIRECTLY (not
  // re-wrapped in the registry's { description, execute, id, inputSchema }
  // literal shape): BST-1070 added a suspendSchema for the network
  // escalation, and the literal would silently drop it — leaving the network
  // gate never firing, with no error and no run event. Excluded for the
  // built-in local provider (same WebGPU-prefill reasoning as the task-list
  // tool and the plan-mode gate).
  [NATIVE_TOOL_ID.runPython]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : createRunPythonTool({
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
            const command = await (
              dependencies.resolvePythonExecutable ?? resolveDesktopPythonExecutable
            )(signal);
            const linuxSeccompApplyPath = (
              dependencies.resolveSeccompApplyPath ?? resolveDesktopSandboxHelperPath
            )();
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
        }),
  // Session tools are omitted for the built-in local provider: both ids are
  // absent from LOCAL_DESKTOP_NATIVE_TOOL_IDS and this gate makes that real
  // at runtime rather than only in the catalog.
  [NATIVE_TOOL_ID.inspectCommandSessions]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.inspectCommandSessions],
          execute: (input: ToolExecuteInput<InspectCommandSessionsInput>) => {
            const resolvedInput = parseToolExecuteInput(
              NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
              input
            );
            try {
              return runInspectCommandSessions(resolvedInput, runtimeData, {
                ...(dependencies.commandSessionManager
                  ? { manager: dependencies.commandSessionManager }
                  : {}),
              });
            } catch (error) {
              logToolFailure('inspectCommandSessions failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.inspectCommandSessions,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
          transform: INSPECT_COMMAND_SESSIONS_TRANSFORM,
        },
  [NATIVE_TOOL_ID.manageCommandSession]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageCommandSession],
          execute: async (
            input: ToolExecuteInput<ManageCommandSessionInput>,
            options?: ToolExecuteContext
          ) => {
            const resolvedInput = parseToolExecuteInput(
              NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
              input
            );
            try {
              return await runManageCommandSession(resolvedInput, runtimeData, {
                executionThreadId: readToolExecutionThreadId([input, options]),
                ...(dependencies.commandSessionManager
                  ? { manager: dependencies.commandSessionManager }
                  : {}),
                ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
              });
            } catch (error) {
              logToolFailure('manageCommandSession failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.manageCommandSession,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
          transform: MANAGE_COMMAND_SESSION_TRANSFORM,
        },
  ...selfInspectionExecutors(mainQuerySelfRead(), mainDiagnosticsReader),
});
