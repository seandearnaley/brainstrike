import type {
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
} from '@brainstrike/agent/local-llm';
import type {
  BackgroundRuntimeStatus,
  RuntimeErrorEnvelope,
  RuntimeProgressEnvelope,
  RuntimeRequestEnvelope,
  RuntimeResultEnvelope,
} from '@brainstrike/worker-runtime';
import {
  assertRuntimeObjectPayloadEnvelope,
  createBackgroundRuntimeDescriptor,
  serializeRuntimeError,
} from '@brainstrike/worker-runtime';

export const LLM_HOST_RUNTIME = createBackgroundRuntimeDescriptor('llm-host');
export const LLM_HOST_LIFECYCLE_CHANNELS = LLM_HOST_RUNTIME.lifecycleChannels;
const LLM_HOST_CHANNELS = LLM_HOST_RUNTIME.createScopedChannels({
  request: 'request',
  progress: 'progress',
  reportResponse: 'report-response',
  reportProgress: 'report-progress',
  cancel: 'cancel',
  generate: 'generate',
  warmup: 'warmup',
});

export const LLM_HOST_STATUS_ADAPTER = LLM_HOST_RUNTIME.statusAdapter;
export const LLM_HOST_STATUS_EVENT = LLM_HOST_LIFECYCLE_CHANNELS.statusEvent;
export const LLM_HOST_REPORT_STATUS_CHANNEL = LLM_HOST_LIFECYCLE_CHANNELS.reportStatus;
export const LLM_HOST_ENSURE_STARTED_CHANNEL = LLM_HOST_LIFECYCLE_CHANNELS.ensureStarted;
export const LLM_HOST_STOP_CHANNEL = LLM_HOST_LIFECYCLE_CHANNELS.stop;
export const LLM_HOST_RESET_CHANNEL = LLM_HOST_LIFECYCLE_CHANNELS.reset;
export const LLM_HOST_GET_STATUS_CHANNEL = LLM_HOST_LIFECYCLE_CHANNELS.getStatus;
export const LLM_HOST_REQUEST_EVENT = LLM_HOST_CHANNELS.request;
export const LLM_HOST_PROGRESS_EVENT = LLM_HOST_CHANNELS.progress;
export const LLM_HOST_REPORT_RESPONSE_CHANNEL = LLM_HOST_CHANNELS.reportResponse;
export const LLM_HOST_REPORT_PROGRESS_CHANNEL = LLM_HOST_CHANNELS.reportProgress;
export const LLM_HOST_CANCEL_CHANNEL = LLM_HOST_CHANNELS.cancel;
export const LLM_HOST_GENERATE_CHANNEL = LLM_HOST_CHANNELS.generate;
export const LLM_HOST_WARMUP_CHANNEL = LLM_HOST_CHANNELS.warmup;

export type LlmHostStatus = BackgroundRuntimeStatus<'llm-host'>;
export type LlmHostStatusReport = BackgroundRuntimeStatus<'llm-host'>;

export interface LlmHostWarmupRequestPayload {
  clientRequestId?: string;
  kind: 'warmup';
  modelId: string;
}

export interface LlmHostGenerateRequestPayload {
  clientRequestId?: string;
  kind: 'generate';
  messages: LocalLlmMessage[];
  modelId: string;
  options?: LocalLlmGenerationOptions;
}

export interface LlmHostCancelRequestPayload {
  kind: 'cancel';
  requestId: string;
}

export type LlmHostRequestPayload =
  | LlmHostCancelRequestPayload
  | LlmHostGenerateRequestPayload
  | LlmHostWarmupRequestPayload;
export type LlmHostRequest = RuntimeRequestEnvelope<'llm', LlmHostRequestPayload>;

export interface LlmHostErrorDetails {
  diagnostics?: Record<string, unknown>;
  stage?: string;
}

export interface LlmHostProgressPayload {
  clientRequestId?: string;
  file?: string;
  kind: 'loading' | 'reasoning' | 'stage' | 'text';
  message?: string;
  progress?: number;
  reasoningText?: string;
  text?: string;
}

export type LlmHostResultReport = RuntimeResultEnvelope<
  'llm-result',
  { result: LocalLlmGenerationResult | null }
>;
export type LlmHostProgressReport = RuntimeProgressEnvelope<'llm-progress', LlmHostProgressPayload>;
export type LlmHostErrorReport = RuntimeErrorEnvelope<'llm-error'> & {
  payload: RuntimeErrorEnvelope<'llm-error'>['payload'] & {
    errorDetails?: LlmHostErrorDetails;
    errorMessage: string;
    errorStack?: string;
  };
};
export type LlmHostResponseReport =
  | LlmHostErrorReport
  | LlmHostProgressReport
  | LlmHostResultReport;

export function createStoppedLlmHostStatus(
  runtimeId: string = LLM_HOST_RUNTIME.stoppedRuntimeId
): LlmHostStatus {
  return LLM_HOST_RUNTIME.createStoppedStatus(runtimeId);
}

export function assertLlmHostRequest(value: unknown): LlmHostRequest {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(value, 'Llm host request');
  if (envelopeBase.type !== 'request') {
    throw new Error('Llm host request must have type="request".');
  }
  if (envelopeBase.channel !== 'llm') {
    throw new Error('Llm host request must have channel="llm".');
  }

  const kind = payload['kind'];
  const modelId = payload['modelId'];

  if (kind === 'warmup') {
    if (!(typeof modelId === 'string' && modelId.trim().length > 0)) {
      throw new Error('Llm host request payload.modelId must be a non-empty string.');
    }
    return {
      type: 'request',
      channel: 'llm',
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      payload: {
        kind,
        ...(payload['clientRequestId'] !== undefined
          ? { clientRequestId: payload['clientRequestId'] as string }
          : {}),
        modelId: modelId.trim(),
      },
    };
  }

  if (kind === 'cancel') {
    const cancelRequestId = payload['requestId'];
    if (!(typeof cancelRequestId === 'string' && cancelRequestId.trim().length > 0)) {
      throw new Error('Llm host cancel payload.requestId must be a non-empty string.');
    }
    return {
      type: 'request',
      channel: 'llm',
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      payload: {
        kind,
        requestId: cancelRequestId.trim(),
      },
    };
  }

  if (kind !== 'generate') {
    throw new Error('Llm host request payload.kind must be "warmup", "generate", or "cancel".');
  }
  if (!(typeof modelId === 'string' && modelId.trim().length > 0)) {
    throw new Error('Llm host request payload.modelId must be a non-empty string.');
  }
  if (!Array.isArray(payload['messages'])) {
    throw new Error('Llm host request payload.messages must be an array.');
  }

  return {
    type: 'request',
    channel: 'llm',
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    payload: {
      kind,
      ...(payload['clientRequestId'] !== undefined
        ? { clientRequestId: payload['clientRequestId'] as string }
        : {}),
      modelId: modelId.trim(),
      messages: payload['messages'] as LocalLlmMessage[],
      ...(payload['options'] !== undefined
        ? { options: payload['options'] as LocalLlmGenerationOptions }
        : {}),
    },
  };
}

export function createLlmHostResultReport(
  request: LlmHostRequest,
  result: LocalLlmGenerationResult | null
): LlmHostResultReport {
  return {
    type: 'result',
    channel: 'llm-result',
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    payload: {
      result,
    },
  };
}

export function createLlmHostProgressReport(
  request: LlmHostRequest,
  payload: LlmHostProgressPayload
): LlmHostProgressReport {
  return {
    type: 'progress',
    channel: 'llm-progress',
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    payload,
  };
}

export function createLlmHostErrorReport(
  request: LlmHostRequest,
  error: unknown,
  details?: LlmHostErrorDetails
): LlmHostErrorReport {
  const serialized = serializeRuntimeError(error);
  return {
    type: 'error',
    channel: 'llm-error',
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    payload: {
      ...serialized,
      errorMessage: serialized.message,
      ...(serialized.stack ? { errorStack: serialized.stack } : {}),
      ...(details ? { errorDetails: details } : {}),
    },
  };
}
