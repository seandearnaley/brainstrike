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

function assertNonEmptyString(value: unknown, message: string): string {
  if (!(typeof value === 'string' && value.trim().length > 0)) {
    throw new Error(message);
  }
  return value.trim();
}

function assertOptionalRequestId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertNonEmptyString(
    value,
    'Llm host payload.clientRequestId must be a non-empty string.'
  );
}

export function assertLlmHostWarmupPayload(value: unknown): LlmHostWarmupRequestPayload {
  if (!(typeof value === 'object' && value !== null)) {
    throw new Error('Llm host warmup payload must be an object.');
  }

  const payload = value as Record<string, unknown>;
  if (payload['kind'] !== 'warmup') {
    throw new Error('Llm host warmup payload.kind must be "warmup".');
  }

  const clientRequestId = assertOptionalRequestId(payload['clientRequestId']);
  return {
    kind: 'warmup',
    modelId: assertNonEmptyString(
      payload['modelId'],
      'Llm host warmup payload.modelId must be a non-empty string.'
    ),
    ...(clientRequestId ? { clientRequestId } : {}),
  };
}

export function assertLlmHostGeneratePayload(value: unknown): LlmHostGenerateRequestPayload {
  if (!(typeof value === 'object' && value !== null)) {
    throw new Error('Llm host generate payload must be an object.');
  }

  const payload = value as Record<string, unknown>;
  if (payload['kind'] !== 'generate') {
    throw new Error('Llm host generate payload.kind must be "generate".');
  }
  if (!Array.isArray(payload['messages'])) {
    throw new Error('Llm host generate payload.messages must be an array.');
  }

  const options = payload['options'];
  if (!(options === undefined || (typeof options === 'object' && options !== null))) {
    throw new Error('Llm host generate payload.options must be an object when provided.');
  }

  const clientRequestId = assertOptionalRequestId(payload['clientRequestId']);
  return {
    kind: 'generate',
    modelId: assertNonEmptyString(
      payload['modelId'],
      'Llm host generate payload.modelId must be a non-empty string.'
    ),
    messages: payload['messages'] as LocalLlmMessage[],
    ...(clientRequestId ? { clientRequestId } : {}),
    ...(options ? { options: options as LocalLlmGenerationOptions } : {}),
  };
}

export function assertLlmHostCancelPayload(value: unknown): LlmHostCancelRequestPayload {
  if (!(typeof value === 'object' && value !== null)) {
    throw new Error('Llm host cancel payload must be an object.');
  }

  const payload = value as Record<string, unknown>;
  if (payload['kind'] !== 'cancel') {
    throw new Error('Llm host cancel payload.kind must be "cancel".');
  }

  return {
    kind: 'cancel',
    requestId: assertNonEmptyString(
      payload['requestId'],
      'Llm host cancel payload.requestId must be a non-empty string.'
    ),
  };
}

function assertResponseReportBase(value: unknown): {
  payload: Record<string, unknown>;
  requestId: string;
  runtimeId: string;
  type: unknown;
} {
  if (!(typeof value === 'object' && value !== null)) {
    throw new Error('Llm host response report must be an object.');
  }

  const report = value as Record<string, unknown>;
  const payload = report['payload'];
  if (!(typeof payload === 'object' && payload !== null)) {
    throw new Error('Llm host response report.payload must be an object.');
  }

  return {
    type: report['type'],
    requestId: assertNonEmptyString(
      report['requestId'],
      'Llm host response report.requestId must be a non-empty string.'
    ),
    runtimeId: assertNonEmptyString(
      report['runtimeId'],
      'Llm host response report.runtimeId must be a non-empty string.'
    ),
    payload: payload as Record<string, unknown>,
  };
}

function assertLlmHostProgressKind(value: unknown): LlmHostProgressPayload['kind'] {
  if (value === 'loading' || value === 'reasoning' || value === 'stage' || value === 'text') {
    return value;
  }
  throw new Error(
    'Llm host progress report.payload.kind must be one of loading, reasoning, stage, or text.'
  );
}

function createProgressReport(
  requestId: string,
  runtimeId: string,
  payload: Record<string, unknown>
): LlmHostProgressReport {
  return {
    type: 'progress',
    channel: 'llm-progress',
    requestId,
    runtimeId,
    payload: {
      kind: assertLlmHostProgressKind(payload['kind']),
      ...(typeof payload['clientRequestId'] === 'string'
        ? { clientRequestId: payload['clientRequestId'] }
        : {}),
      ...(typeof payload['file'] === 'string' ? { file: payload['file'] } : {}),
      ...(typeof payload['message'] === 'string' ? { message: payload['message'] } : {}),
      ...(typeof payload['progress'] === 'number' ? { progress: payload['progress'] } : {}),
      ...(typeof payload['reasoningText'] === 'string'
        ? { reasoningText: payload['reasoningText'] }
        : {}),
      ...(typeof payload['text'] === 'string' ? { text: payload['text'] } : {}),
    },
  };
}

function createResultReport(
  requestId: string,
  runtimeId: string,
  payload: Record<string, unknown>
): LlmHostResultReport {
  if (!('result' in payload)) {
    throw new Error('Llm host result report.payload.result is required.');
  }

  return {
    type: 'result',
    channel: 'llm-result',
    requestId,
    runtimeId,
    payload: {
      result: (payload as { result: LocalLlmGenerationResult | null }).result,
    },
  };
}

function createErrorReport(
  requestId: string,
  runtimeId: string,
  payload: Record<string, unknown>
): LlmHostErrorReport {
  const errorMessage = assertNonEmptyString(
    payload['errorMessage'],
    'Llm host error report.payload.errorMessage must be a non-empty string.'
  );
  const errorName =
    typeof payload['name'] === 'string' && payload['name'].trim().length > 0
      ? payload['name']
      : 'Error';

  return {
    type: 'error',
    channel: 'llm-error',
    requestId,
    runtimeId,
    payload: {
      errorMessage,
      message: typeof payload['message'] === 'string' ? payload['message'] : errorMessage,
      ...(typeof payload['errorStack'] === 'string' ? { errorStack: payload['errorStack'] } : {}),
      ...(typeof payload['errorDetails'] === 'object' && payload['errorDetails'] !== null
        ? { errorDetails: payload['errorDetails'] as LlmHostErrorDetails }
        : {}),
      name: errorName,
    },
  };
}

export function assertLlmHostResponseReport(value: unknown): LlmHostResponseReport {
  const { payload, requestId, runtimeId, type } = assertResponseReportBase(value);

  if (type === 'progress') {
    return createProgressReport(requestId, runtimeId, payload);
  }
  if (type === 'result') {
    return createResultReport(requestId, runtimeId, payload);
  }
  if (type === 'error') {
    return createErrorReport(requestId, runtimeId, payload);
  }

  throw new Error('Llm host response report.type must be "progress", "result", or "error".');
}

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

  if (kind === 'warmup') {
    return {
      type: 'request',
      channel: 'llm',
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      payload: assertLlmHostWarmupPayload(payload),
    };
  }

  if (kind === 'cancel') {
    return {
      type: 'request',
      channel: 'llm',
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      payload: assertLlmHostCancelPayload(payload),
    };
  }

  if (kind !== 'generate') {
    throw new Error('Llm host request payload.kind must be "warmup", "generate", or "cancel".');
  }

  return {
    type: 'request',
    channel: 'llm',
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    payload: assertLlmHostGeneratePayload(payload),
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
