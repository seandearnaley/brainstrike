/**
 * Executor entries for the execution, session, and self-inspection tools
 * (BST-1646 step c). Each entry builds the request-scoped Mastra registry
 * object for ONE catalog definition; `native-tool-executors.ts` assembles the
 * exhaustive map.
 */
import {
  createRunPythonTool,
  type ExecuteCommandInput,
  type InspectCommandSessionsInput,
  type ManageCommandSessionInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type QueryDiagnosticsInput,
  type QuerySelfInput,
  type RunSkillScriptInput,
  readToolExecutionThreadId,
  resolveGuardedToolSignal,
  resolveRequestPermissionPolicy,
  resolveSelfApprovalDecision,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { app } from 'electron';
import { resolveDesktopPythonExecutable } from '../python-runtime';
import { resolveDesktopSeccompApplyPath } from '../sandbox-runtime-path';
import {
  INSPECT_COMMAND_SESSIONS_TRANSFORM,
  MANAGE_COMMAND_SESSION_TRANSFORM,
  runInspectCommandSessions,
  runManageCommandSession,
} from './command-session-tools';
import { runExecuteCommandWithShellCorrelation } from './execute-command-correlation';
import { projectExecuteCommandModelOutput } from './execute-command-model-projection';
import { executorGroup } from './native-tool-executor-context';
import { runQueryDiagnostics } from './query-diagnostics-tool';
import { projectQuerySelfModelOutput } from './query-self-model-projection';
import { runQuerySelf, toQuerySelfInputError } from './query-self-tool';
import { runSkillScript } from './run-skill-script-tool';
import {
  logToolFailure,
  parseToolExecuteInput,
  resolveShellOutputStreamer,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from './tool-execute-support';

export const EXECUTION_TOOL_EXECUTORS = executorGroup({
  // Arbitrary shell execution is registered like every other native tool and
  // gated by the permission engine. With enforce-on-by-default, its 'execute'
  // risk bucket resolves to 'ask', so the run SUSPENDS for per-call approval
  // before the command runs (approve → execute, decline → skip). A user can set
  // execute to 'allow'/yolo to run it unprompted, or 'deny' to omit it — that is
  // the permission gate's job now, not a registration-time conditional.
  [NATIVE_TOOL_ID.executeCommand]: ({
    dependencies,
    resolveActiveDomainCharBudget,
    runtimeData,
  }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.executeCommand],
    // The second arg carries the Mastra ToolExecutionContext, whose abortSignal
    // we thread into the run so a cancelled run kills the process tree, and whose
    // stream writer + tool-call id we use to stream incremental stdout/stderr to
    // the live tool card. Mastra hands a DIFFERENT context shape to a plain tool
    // object (raw `outputWriter` fn + top-level `toolCallId`) vs a `createTool`
    // instance (`writer.custom` + `agent.toolCallId`); we accept both.
    // `resolveShellOutputStreamer` returns undefined when neither is present, so
    // the command still runs and returns its full captured result — only the
    // live slices are skipped (capability presence, not a policy fallback).
    execute: async (input: ToolExecuteInput<ExecuteCommandInput>, options?: ToolExecuteContext) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.executeCommand],
        input
      );
      const stream = resolveShellOutputStreamer(options, (error) => {
        logToolFailure('executeCommand output streaming failed', error, resolvedInput);
      });
      try {
        // Mis-attribution guard (BST-1392 review) lives in
        // execute-command-correlation.ts.
        return await runExecuteCommandWithShellCorrelation(
          resolvedInput,
          runtimeData,
          { signal: resolveGuardedToolSignal(options), ...(stream ? { stream } : {}) },
          dependencies
        );
      } catch (error) {
        logToolFailure('executeCommand failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.executeCommand,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.executeCommand],
    toModelOutput: (output: unknown) =>
      projectExecuteCommandModelOutput(output, resolveActiveDomainCharBudget()),
  }),
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
            const linuxSeccompApplyPath = resolveDesktopSeccompApplyPath(
              app.isPackaged,
              process.resourcesPath
            );
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
  [NATIVE_TOOL_ID.querySelf]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.querySelf],
    execute: async (input: ToolExecuteInput<QuerySelfInput>) => {
      // Schema validation is INSIDE the try on purpose. For every other tool a
      // malformed call is a bug; for this one the model is authoring the input
      // freehand, so an opaque `tool_failed` leaves it no way to correct and it
      // simply retries the same call. Observed live: a rejected input produced
      // "The tool did not complete successfully" and the model gave up after
      // two identical attempts. `toToolInputError` turns the validation
      // message into text the model can act on.
      let resolvedInput: QuerySelfInput | undefined;
      try {
        resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.querySelf],
          input
        );
        return await runQuerySelf(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('querySelf failed', error, resolvedInput ?? {});
        throw resolvedInput === undefined ? toQuerySelfInputError(error) : error;
      }
    },
    id: NATIVE_TOOL_ID.querySelf,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.querySelf],
    toModelOutput: (output: unknown) =>
      projectQuerySelfModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.queryDiagnostics]: () => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.queryDiagnostics],
    execute: async (input: ToolExecuteInput<QueryDiagnosticsInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryDiagnostics],
        input
      );
      try {
        return await runQueryDiagnostics(resolvedInput);
      } catch (error) {
        logToolFailure('queryDiagnostics failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.queryDiagnostics,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryDiagnostics],
  }),
});
