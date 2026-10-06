import { resolvePermissionDecision } from '@brainstrike/assistant-contract';
import type { ToolSet } from 'ai';
import { ApprovalInputReconstructionError, admittedApprovalInput } from './approval-input.js';
import type { HostRunState } from './core-state.js';
import { canonical, jsonValue } from './json-value.js';
import type { HostPlatform, HostRunAdmission, HostRunAdmissionRequest } from './ports.js';
import type { HostEvent } from './protocol.js';
import { HostRunSnapshotSchema } from './protocol.js';
import { createHostSdkTools } from './sdk-tools.js';

/** Copy data records; credentials/functions and native capabilities stay process-local. */
function immutableData<T>(input: T): T {
  if (Array.isArray(input)) {
    return Object.freeze(input.map((value: unknown) => immutableData(value))) as T;
  }
  if (input === null || typeof input !== 'object') {
    return input;
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return input;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(input).map(([key, value]: [string, unknown]) => [key, immutableData(value)])
    )
  ) as T;
}

/** Retain the selected executors and configuration without freezing the source registry. */
export function captureHostRunAdmission(selected: HostRunAdmission): HostRunAdmission {
  return Object.freeze({
    ...selected,
    configuration: immutableData(selected.configuration),
    ...(selected.provider
      ? { provider: Object.freeze({ prepare: selected.provider.prepare.bind(selected.provider) }) }
      : {}),
    snapshot: immutableData(HostRunSnapshotSchema.parse(selected.snapshot)),
    tools: Object.freeze(
      Object.fromEntries(
        Object.entries(selected.tools).map(([id, binding]) => [id, Object.freeze({ ...binding })])
      )
    ),
  });
}

export async function acquireHostRunAdmission(
  platform: HostPlatform,
  request: HostRunAdmissionRequest
): Promise<HostRunAdmission> {
  const selected = platform.admitRun
    ? await platform.admitRun(request)
    : {
        configuration: {},
        model: await platform.resolveModel(request.modelId),
        snapshot: {
          configuration: {},
          maxSteps: platform.maxSteps,
          toolIdentities: Object.fromEntries(
            Object.entries(platform.tools).map(([id, binding]) => [id, binding.identity])
          ),
        },
        tools: platform.tools,
      };
  const admission = captureHostRunAdmission(selected);
  const { snapshot, tools } = admission;
  if (
    canonical(jsonValue(snapshot.toolIdentities)) !==
    canonical(
      jsonValue(Object.fromEntries(Object.entries(tools).map(([id, tool]) => [id, tool.identity])))
    )
  ) {
    throw new Error('Admitted tool catalog does not match its durable identities');
  }
  if (
    request.snapshot &&
    canonical(jsonValue(snapshot)) !== canonical(jsonValue(request.snapshot))
  ) {
    throw new ApprovalInputReconstructionError();
  }
  return admission;
}

export function ensureHostRunAdmission(
  platform: HostPlatform,
  run: HostRunState
): Promise<HostRunAdmission> {
  if (run.admission) {
    return Promise.resolve(run.admission);
  }
  run.admissionTask ??= acquireHostRunAdmission(platform, {
    modelId: run.modelId,
    signal: run.controller.signal,
    ...(run.snapshot ? { snapshot: run.snapshot } : {}),
    threadId: run.threadId,
  }).then((admission) => {
    run.admission = admission;
    return admission;
  });
  return run.admissionTask;
}

export function hostRunTools(run: HostRunState): HostRunAdmission['tools'] {
  if (!run.admission) {
    throw new Error('Run executors were not acquired');
  }
  return run.admission.tools;
}

/** Keep revocation live while taking risk and executor identity from admission. */
export function hostRunToolDecision(
  platform: HostPlatform,
  run: HostRunState,
  toolId: string
): 'allow' | 'ask' | 'deny' {
  const registered = hostRunTools(run)[toolId];
  if (!registered) {
    throw new Error('Tool is not registered');
  }
  const snapshot = platform.readPermissionPolicy();
  // ADR-0010: explicit deny outranks a session grant or YOLO.
  if (
    snapshot.perToolOverrides?.[toolId] === 'deny' ||
    snapshot.policies[registered.risk] === 'deny'
  ) {
    return 'deny';
  }
  return resolvePermissionDecision({
    policies: snapshot.policies,
    riskCategory: registered.risk,
    toolId,
    ...(snapshot.perToolOverrides ? { perToolOverrides: snapshot.perToolOverrides } : {}),
    sessionGrants: new Set(snapshot.sessionGrants ?? []),
    yolo: snapshot.yolo,
  });
}

/** Callbacks retain the existing Core writer and dispatcher; this owns no effects. */
export function createAdmittedHostSdkTools(
  run: HostRunState,
  dispatch: (
    action: Extract<HostEvent, { type: 'effect.started' }>,
    input: unknown
  ) => Promise<unknown>
): ToolSet {
  return createHostSdkTools({
    admittedInput: (id, input) => admittedApprovalInput(id, input, run),
    execute: (id, toolCallId, input) => {
      const action = run.permits.get(toolCallId);
      if (!action || action.toolId !== id) {
        throw new Error('Tool execution bypassed host permission admission');
      }
      if (canonical(jsonValue(input)) !== canonical(action.input)) {
        throw new Error('SDK execution input changed after permission admission');
      }
      return dispatch(action, input);
    },
    tools: hostRunTools(run),
  });
}
