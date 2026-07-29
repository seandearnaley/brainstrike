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
import { readRequestBody } from './http';
import { respondJson } from './http-responses';
import { desktopAssistantServerLogger as logger } from './logger';
import { resolveRequestedProvider } from './memory-model-targets';
import {
  hydrateRuntimeDataWithLocalRuntimeToken,
  resolveProviderApiKeyOrRespond,
} from './provider-credentials';
import type { AssistantRequestPayload, AssistantUiMessage } from './server-types';

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

function convertAssistantMessagesOrRespond(
  rawMessages: readonly AssistantUiMessage[],
  res: http.ServerResponse
): AssistantUiMessageConversionResult | undefined {
  try {
    return convertAssistantUiMessagesWithFinalInput(rawMessages);
  } catch (error) {
    if (!(error instanceof AssistantAttachmentValidationError)) {
      throw error;
    }
    respondJson(res, 400, {
      error: 'invalid_attachment',
      message: 'Assistant attachment payload is invalid.',
      reason: error.reason,
    });
    return;
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

function respondToToolContinuationInputError(
  res: http.ServerResponse,
  actions: ParsedToolContinuationActions
): boolean {
  if (actions.toolApprovalActionInvalid) {
    respondJson(res, 400, {
      error: 'invalid_tool_approval_action',
      message:
        'Tool approval action must contain only action, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    return true;
  }

  if (actions.toolResumeActionInvalid) {
    respondJson(res, 400, {
      error: 'invalid_tool_resume_action',
      message:
        'Tool resume action must contain only resumeData, runId, toolCallId, and optional toolName with bounded non-empty identifiers.',
    });
    return true;
  }

  if (actions.toolApprovalAction && actions.toolResumeAction) {
    respondJson(res, 400, {
      error: 'conflicting_tool_continuation_actions',
      message: 'Assistant request must contain at most one tool continuation action.',
    });
    return true;
  }

  return false;
}

export async function prepareAssistantPostRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<PreparedAssistantPostRequest | undefined> {
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
    if (!respondToAssistantPayloadError(res, error)) {
      throw error;
    }
    return;
  }

  const conversion = convertAssistantMessagesOrRespond(rawMessages, res);
  if (!conversion) {
    return;
  }
  const { finalInputMessage, messages } = conversion;
  const provider = resolveRequestedProvider(data);

  if (
    respondToToolContinuationInputError(res, {
      toolApprovalAction,
      toolApprovalActionInvalid,
      toolResumeAction,
      toolResumeActionInvalid,
    })
  ) {
    return;
  }

  if (!provider) {
    respondJson(res, 400, {
      error: 'missing_provider',
      message: 'No provider specified or provider is not supported.',
    });
    return;
  }

  // Providers that never require a bearer token: the in-browser Gemma runtime
  // and the two local servers (Ollama/LM Studio). Local servers accept an
  // optional token when the user has stored one via the secrets bridge, but
  // the absence of a token is not an error — most setups don't have auth.
  const providerAllowsMissingAuth =
    provider === 'local' || provider === 'ollama' || provider === 'lmstudio';
  const apiKeyResolution =
    provider === 'local' ? { apiKey: '' } : await resolveProviderApiKeyOrRespond(provider, res);
  if (!apiKeyResolution) {
    return;
  }
  const { apiKey } = apiKeyResolution;

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
    respondJson(res, 400, {
      error: 'missing_api_key',
      message: `No API key configured for provider "${provider}".`,
    });
    return;
  }

  if (!hasAssistantPromptOrAction(finalInputMessage, toolApprovalAction, toolResumeAction)) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'empty_prompt' }));
    return;
  }

  return {
    apiKey: apiKey ?? '',
    ...(assistantMessageId ? { assistantMessageId } : {}),
    messages,
    runtimeData,
    ...(toolApprovalAction ? { toolApprovalAction } : {}),
    ...(toolResumeAction ? { toolResumeAction } : {}),
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

function respondToInvalidEnabledNativeToolIds(
  res: http.ServerResponse,
  invalidValues: readonly unknown[]
): void {
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
  respondJson(res, 400, {
    correlationId,
    error: 'invalid_enabled_native_tool_ids',
    message: 'Assistant request contains unknown enabled native tool IDs.',
    stage: 'native_tool_preferences',
  });
}

function respondToAssistantPayloadError(res: http.ServerResponse, error: unknown): boolean {
  if (error instanceof InvalidEnabledNativeToolIdsError) {
    respondToInvalidEnabledNativeToolIds(res, error.invalidValues);
    return true;
  }
  if (
    error instanceof AssistantInvalidJsonError ||
    error instanceof AssistantMessageValidationError ||
    error instanceof AssistantRequestEnvelopeValidationError
  ) {
    respondJson(res, 400, {
      error: error.code,
      message: error.message,
    });
    return true;
  }
  if (error instanceof AssistantRequestBodyTooLargeError) {
    res.setHeader('Connection', 'close');
    respondJson(res, 413, {
      error: error.code,
      message: error.message,
    });
    return true;
  }
  return false;
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
