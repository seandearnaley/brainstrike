import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';
import {
  type AgentMessage,
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantAttachmentValidationError,
  AssistantInvalidJsonError,
  AssistantMessageValidationError,
  AssistantRequestBodyTooLargeError,
  AssistantRequestEnvelopeValidationError,
  type AssistantToolApprovalAction,
  type AssistantToolResumeAction,
  type AssistantUiMessageConversionResult,
  convertAssistantUiMessagesWithFinalInput,
  DESKTOP_NATIVE_TOOL_IDS,
  hasAssistantPromptContent,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  parseAssistantRequestPayloadText,
  type RuntimeData,
  readToolApprovalRunConfigAction,
  readToolResumeRunConfigAction,
  resolveAssistantRequestBodyLimitBytes,
  resolveAutoObservationalMemoryModelTarget,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { resolveRequestedProvider } from '@brainstrike/assistant-service/memory-model-targets';
import type {
  AssistantPostRejection,
  AssistantRequestPayload,
  AssistantUiMessage,
} from '@brainstrike/assistant-service/types';
import { readRequestBody } from './http';
import { desktopAssistantServerLogger as logger } from './logger';
import { hydrateRuntimeDataWithLocalRuntimeToken } from './provider-credentials';
import { getSecretReadErrorPayload } from './secret-error-responses';

const DESKTOP_NATIVE_TOOL_ID_SET = new Set<string>(DESKTOP_NATIVE_TOOL_IDS);

const SAFE_NATIVE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

class InvalidEnabledNativeToolIdsError extends Error {
  readonly invalidValues: readonly unknown[];

  constructor(invalidValues: readonly unknown[]) {
    super('Assistant request contains unknown enabled native tool IDs.');
    this.name = 'InvalidEnabledNativeToolIdsError';
    this.invalidValues = invalidValues;
  }
}

const assistantRequestBodyLimitBytes = resolveAssistantRequestBodyLimitBytes(
  process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
);

interface PreparedAssistantPostRequest {
  apiKey: string;
  assistantMessageId?: string;
  messages: AgentMessage[];
  runtimeData: RuntimeData;
  toolApprovalAction?: AssistantToolApprovalAction;
  toolResumeAction?: AssistantToolResumeAction;
}

/**
 * Injected provider-credential reader — the structural twin of
 * agent-stream-init's AgentStreamProviderApiKeyReader (BST-972 A3/A4). The two
 * declarations unify at the ports module when the package-extraction slice
 * lands; until then each module states the shape it consumes.
 */
export type PreparationProviderApiKeyReader = (provider: string) => Promise<string | undefined>;

export interface PrepareAssistantPostRequestParams {
  readonly req: http.IncomingMessage;
  readonly resolveProviderApiKey: PreparationProviderApiKeyReader;
}

/**
 * De-transported result (BST-972 A4): preparation never writes the response —
 * every failure path returns a rejection the transport maps via
 * respondAssistantRejection. `req` remains only for the bounded body read;
 * it goes with the package-extraction slice.
 */
export type PrepareAssistantPostRequestResult =
  | { readonly ok: true; readonly request: PreparedAssistantPostRequest }
  | { readonly ok: false; readonly rejection: AssistantPostRejection };

function reject(rejection: AssistantPostRejection): PrepareAssistantPostRequestResult {
  return { ok: false, rejection };
}

/**
 * Absorbs the previous resolveProviderApiKeyOrRespond: a classified
 * secret-read failure becomes the same 400 payload; anything else still
 * propagates loudly. The in-browser 'local' runtime never needs a key.
 */
async function resolveApiKeyOrReject(
  provider: SupportedProvider,
  resolveProviderApiKey: PreparationProviderApiKeyReader
): Promise<
  | { readonly apiKey: string | undefined; readonly rejection?: undefined }
  | { readonly apiKey?: undefined; readonly rejection: AssistantPostRejection }
> {
  if (provider === 'local') {
    return { apiKey: '' };
  }
  try {
    return { apiKey: await resolveProviderApiKey(provider) };
  } catch (error) {
    const payload = getSecretReadErrorPayload(error);
    if (!payload) {
      throw error;
    }
    return { rejection: { payload, status: 400 } };
  }
}

function withTrustedAssistantMessageId(
  data: RuntimeData | undefined,
  provider: SupportedProvider,
  assistantMessageId: string | undefined
): RuntimeData {
  const { assistantMessageId: _ignoredClientAssistantMessageId, ...clientRuntimeData } = data ?? {};
  return {
    ...clientRuntimeData,
    provider,
    ...(assistantMessageId ? { assistantMessageId } : {}),
  };
}

function convertAssistantMessages(
  rawMessages: readonly AssistantUiMessage[]
):
  | { readonly conversion: AssistantUiMessageConversionResult; readonly rejection?: undefined }
  | { readonly conversion?: undefined; readonly rejection: AssistantPostRejection } {
  try {
    return { conversion: convertAssistantUiMessagesWithFinalInput(rawMessages) };
  } catch (error) {
    if (!(error instanceof AssistantAttachmentValidationError)) {
      throw error;
    }
    return {
      rejection: {
        payload: {
          error: 'invalid_attachment',
          message: 'Assistant attachment payload is invalid.',
          reason: error.reason,
        },
        status: 400,
      },
    };
  }
}

function hasAssistantPromptOrAction(
  finalInputMessage: AgentMessage | null,
  toolApprovalAction: AssistantToolApprovalAction | undefined,
  toolResumeAction: AssistantToolResumeAction | undefined
): boolean {
  if (toolApprovalAction || toolResumeAction) {
    return true;
  }
  return Boolean(finalInputMessage && hasAssistantPromptContent([finalInputMessage]));
}

interface ParsedToolContinuationActions {
  readonly toolApprovalAction: AssistantToolApprovalAction | undefined;
  readonly toolApprovalActionInvalid: boolean;
  readonly toolResumeAction: AssistantToolResumeAction | undefined;
  readonly toolResumeActionInvalid: boolean;
}

function rejectToolContinuationInputError(
  actions: ParsedToolContinuationActions
): AssistantPostRejection | undefined {
  if (actions.toolApprovalActionInvalid) {
    return {
      payload: {
        error: 'invalid_tool_approval_action',
        message:
          'Tool approval action must contain only action, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
      },
      status: 400,
    };
  }

  if (actions.toolResumeActionInvalid) {
    return {
      payload: {
        error: 'invalid_tool_resume_action',
        message:
          'Tool resume action must contain only resumeData, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
      },
      status: 400,
    };
  }

  if (actions.toolApprovalAction && actions.toolResumeAction) {
    return {
      payload: {
        error: 'conflicting_tool_continuation_actions',
        message: 'Assistant request must contain at most one tool continuation action.',
      },
      status: 400,
    };
  }

  return;
}

export async function prepareAssistantPostRequest(
  params: PrepareAssistantPostRequestParams
): Promise<PrepareAssistantPostRequestResult> {
  const { req, resolveProviderApiKey } = params;
  let rawMessages: AssistantUiMessage[];
  let data: RuntimeData | undefined;
  let assistantMessageId: string | undefined;
  let toolApprovalAction: AssistantToolApprovalAction | undefined;
  let toolApprovalActionInvalid = false;
  let toolResumeAction: AssistantToolResumeAction | undefined;
  let toolResumeActionInvalid = false;
  try {
    const payload = await parseAssistantRequestPayload(req);
    assistantMessageId = payload.assistantMessageId;
    rawMessages = payload.rawMessages;
    data = payload.data;
    toolApprovalAction = payload.toolApprovalAction;
    toolApprovalActionInvalid = Boolean(payload.toolApprovalActionInvalid);
    toolResumeAction = payload.toolResumeAction;
    toolResumeActionInvalid = Boolean(payload.toolResumeActionInvalid);
  } catch (error) {
    const rejection = rejectAssistantPayloadError(error);
    if (!rejection) {
      throw error;
    }
    return reject(rejection);
  }

  const converted = convertAssistantMessages(rawMessages);
  if (converted.rejection) {
    return reject(converted.rejection);
  }
  const { finalInputMessage, messages } = converted.conversion;
  const provider = resolveRequestedProvider(data);

  const continuationRejection = rejectToolContinuationInputError({
    toolApprovalAction,
    toolApprovalActionInvalid,
    toolResumeAction,
    toolResumeActionInvalid,
  });
  if (continuationRejection) {
    return reject(continuationRejection);
  }

  if (!provider) {
    return reject({
      payload: {
        error: 'missing_provider',
        message: 'No provider specified or provider is not supported.',
      },
      status: 400,
    });
  }

  // Providers that never require a bearer token: the in-browser Gemma runtime
  // and the two local servers (Ollama/LM Studio). Local servers accept an
  // optional token when the user has stored one via the secrets bridge, but
  // the absence of a token is not an error — most setups don't have auth.
  const providerAllowsMissingAuth =
    provider === 'local' || provider === 'ollama' || provider === 'lmstudio';
  const resolved = await resolveApiKeyOrReject(provider, resolveProviderApiKey);
  if (resolved.rejection) {
    return reject(resolved.rejection);
  }
  const { apiKey } = resolved;

  const runtimeData: RuntimeData = resolveServerAutoObservationalMemory(
    hydrateRuntimeDataWithLocalRuntimeToken(
      withTrustedAssistantMessageId(data, provider, assistantMessageId),
      provider,
      apiKey
    )
  );

  logger.info('Assistant request received', {
    hasApiKey: Boolean(apiKey) || providerAllowsMissingAuth,
    messageCount: messages.length,
    provider,
  });

  if (!(apiKey || providerAllowsMissingAuth)) {
    return reject({
      payload: {
        error: 'missing_api_key',
        message: `No API key configured for provider "${provider}".`,
      },
      status: 400,
    });
  }

  if (!hasAssistantPromptOrAction(finalInputMessage, toolApprovalAction, toolResumeAction)) {
    // Deliberately message-less on the wire (the pre-A4 hand-rolled write).
    return reject({ payload: { error: 'empty_prompt' }, status: 400 });
  }

  return {
    ok: true,
    request: {
      apiKey: apiKey ?? '',
      ...(assistantMessageId ? { assistantMessageId } : {}),
      messages,
      runtimeData,
      ...(toolApprovalAction ? { toolApprovalAction } : {}),
      ...(toolResumeAction ? { toolResumeAction } : {}),
    },
  };
}

/**
 * Server-side intake resolution of the 'auto' observer sentinel (BST-940).
 * Renderers resolve 'auto' before sending, but a raw client (or a replayed
 * request) may still ship it — and 'auto' must neither reach the target parser
 * (502 on an otherwise-valid stream) nor silently select a provider the chat
 * isn't already using. Same deterministic contract rule as the renderer: the
 * observer comes from the request's OWN chat provider or observation is off
 * for the request. Key presence is implied by the request reaching this seam;
 * a genuinely missing observer credential still fails visibly downstream,
 * exactly like an explicit target.
 */
function resolveServerAutoObservationalMemory(runtimeData: RuntimeData): RuntimeData {
  const memory = runtimeData.memory;
  const memorySettings = memory?.memorySettings;
  const observationalMemory = memorySettings?.observationalMemory;
  if (
    !(memory && memorySettings && observationalMemory) ||
    observationalMemory.modelTarget !== OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET
  ) {
    return runtimeData;
  }
  const chatProvider = typeof runtimeData.provider === 'string' ? runtimeData.provider : null;
  const target = resolveAutoObservationalMemoryModelTarget({
    chatProvider,
    providersWithKeys: chatProvider ? [chatProvider] : [],
  });
  return {
    ...runtimeData,
    memory: {
      ...memory,
      memorySettings: {
        ...memorySettings,
        observationalMemory:
          target === null
            ? { ...observationalMemory, enabled: false }
            : { ...observationalMemory, modelTarget: target },
      },
    },
  };
}

function validateEnabledNativeToolIds(runtimeData: RuntimeData | undefined): void {
  const rawToolIds = runtimeData?.enabledNativeToolIds;
  if (rawToolIds === undefined) {
    return;
  }
  if (!Array.isArray(rawToolIds)) {
    throw new InvalidEnabledNativeToolIdsError([rawToolIds]);
  }
  const invalidValues = rawToolIds.filter(
    (toolId): boolean => typeof toolId !== 'string' || !DESKTOP_NATIVE_TOOL_ID_SET.has(toolId)
  );
  if (invalidValues.length > 0) {
    throw new InvalidEnabledNativeToolIdsError(invalidValues);
  }
}

function rejectInvalidEnabledNativeToolIds(
  invalidValues: readonly unknown[]
): AssistantPostRejection {
  const correlationId = randomUUID();
  const identifiers = Array.from(
    new Set(
      invalidValues.map((value) => {
        if (typeof value === 'string' && SAFE_NATIVE_TOOL_ID_PATTERN.test(value)) {
          return value;
        }
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        return `sha256:${createHash('sha256')
          .update(serialized ?? String(value))
          .digest('hex')
          .slice(0, 12)}`;
      })
    )
  );
  logger.warn('Rejected unknown enabled native tool ids', {
    correlationId,
    toolIdentifiers: identifiers,
  });
  return {
    payload: {
      correlationId,
      error: 'invalid_enabled_native_tool_ids',
      message: 'Assistant request contains unknown enabled native tool IDs.',
      stage: 'native_tool_preferences',
    },
    status: 400,
  };
}

function rejectAssistantPayloadError(error: unknown): AssistantPostRejection | undefined {
  if (error instanceof InvalidEnabledNativeToolIdsError) {
    return rejectInvalidEnabledNativeToolIds(error.invalidValues);
  }
  if (
    error instanceof AssistantInvalidJsonError ||
    error instanceof AssistantMessageValidationError ||
    error instanceof AssistantRequestEnvelopeValidationError
  ) {
    return {
      payload: {
        error: error.code,
        message: error.message,
      },
      status: 400,
    };
  }
  if (error instanceof AssistantRequestBodyTooLargeError) {
    return {
      closeConnection: true,
      payload: {
        error: error.code,
        message: error.message,
      },
      status: 413,
    };
  }
  return;
}

async function parseAssistantRequestPayload(
  req: http.IncomingMessage
): Promise<AssistantRequestPayload> {
  const body = await readRequestBody(req, {
    maxBodyBytes: assistantRequestBodyLimitBytes,
  });
  const payload = parseAssistantRequestPayloadText(body);
  const toolApprovalActionResult = readToolApprovalRunConfigAction(payload.runConfig);
  const toolResumeActionResult = readToolResumeRunConfigAction(payload.runConfig);
  const parsedPayload: AssistantRequestPayload = { ...payload };
  validateEnabledNativeToolIds(parsedPayload.data);

  if (toolApprovalActionResult) {
    if ('invalid' in toolApprovalActionResult) {
      parsedPayload.toolApprovalActionInvalid = true;
    } else {
      parsedPayload.toolApprovalAction = toolApprovalActionResult.action;
    }
  }

  if (toolResumeActionResult) {
    if ('invalid' in toolResumeActionResult) {
      parsedPayload.toolResumeActionInvalid = true;
    } else {
      parsedPayload.toolResumeAction = toolResumeActionResult.action;
    }
  }

  return parsedPayload;
}
