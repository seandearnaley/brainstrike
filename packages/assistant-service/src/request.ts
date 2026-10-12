import { createHash, randomUUID } from 'node:crypto';
import type { SupportedProvider } from '@brainstrike/agent/client';
// The hosted-web SUBPATH, not the agent root: Vercel traces every reachable
// file into the function bundle, and the root entry drags the Mastra/Node
// graph past the 250MB function limit (PR #2127 deploy failure). Everything
// preparation needs is exported from the slim entry.
import {
  type AgentMessage,
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
  type ParsedAssistantRequestEnvelope,
  parseAssistantRequestPayloadText,
  type RuntimeData,
  readToolApprovalRunConfigAction,
  readToolResumeRunConfigAction,
  resolveAutoObservationalMemoryModelTarget,
} from '@brainstrike/agent/hosted-web';
import {
  type AssistantChildFollowupAction,
  readChildFollowupRunConfigAction,
} from '@brainstrike/assistant-contract/child-followup';
import {
  getProviderDefinition,
  isSupportedProvider,
  providerAuthType,
} from '@brainstrike/assistant-contract/provider-metadata';
import type { AssistantPostRejection } from '@brainstrike/assistant-wire';
import type { ScopedLogger } from '@brainstrike/logging';
import { resolveRequestedProvider } from './memory-model-targets.js';
import type { ProviderCredentialReader, ResolvedProviderCredential } from './ports.js';
import {
  type ProviderAuthProjectionOptions,
  providerAuthInputFromCredential,
} from './provider-credential-projection.js';
import { getSecretReadErrorPayload } from './secret-errors.js';
import type { AssistantRequestPayload, AssistantUiMessage } from './types.js';

const DESKTOP_NATIVE_TOOL_ID_SET = new Set<string>(DESKTOP_NATIVE_TOOL_IDS);

const SAFE_NATIVE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

/**
 * Wrapper for ANY error thrown by the filterPayload hook (BST-1030 review):
 * without it, a hook throwing one of preparation's own payload-error classes
 * would be silently mapped by rejectAssistantPayloadError — the package
 * claiming an error it doesn't own. Preparation tags hook throws with this
 * class and rethrows them past its mapping; the transport unwraps `cause`
 * and owns the wire shape.
 */
export class AssistantFilterPayloadError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('Assistant request filterPayload hook threw.');
    this.name = 'AssistantFilterPayloadError';
    this.cause = cause;
  }
}

class InvalidEnabledNativeToolIdsError extends Error {
  readonly invalidValues: readonly unknown[];

  constructor(invalidValues: readonly unknown[]) {
    super('Assistant request contains unknown enabled native tool IDs.');
    this.name = 'InvalidEnabledNativeToolIdsError';
    this.invalidValues = invalidValues;
  }
}

interface PreparedAssistantPostRequest {
  apiKey: string;
  assistantMessageId?: string;
  childFollowupAction?: AssistantChildFollowupAction;
  /**
   * The typed credential the request resolved (BST-1352). In the current
   * pipeline this is always an `api_key` credential when present — a stored
   * non-api_key credential rejects the request before preparation succeeds.
   * Hosts derive the factory `ProviderAuthInput` from it (see ports'
   * `providerAuthInputFromCredential`).
   */
  credential?: ResolvedProviderCredential;
  finalInputMessage?: AgentMessage;
  inputParentMessageId?: string | null;
  messages: AgentMessage[];
  pausedMessageId?: string;
  runtimeData: RuntimeData;
  toolApprovalAction?: AssistantToolApprovalAction;
  toolResumeAction?: AssistantToolResumeAction;
}

function optionalInputParentMessageId(value: string | null | undefined): {
  inputParentMessageId?: string | null;
} {
  return value === undefined ? {} : { inputParentMessageId: value };
}

function optionalPausedMessageId(value: string | undefined): { pausedMessageId?: string } {
  return value === undefined ? {} : { pausedMessageId: value };
}

function optionalFinalInputMessage(value: AgentMessage | null | undefined): {
  finalInputMessage?: AgentMessage;
} {
  return value === null || value === undefined ? {} : { finalInputMessage: value };
}

/**
 * Injected provider-credential reader, now owned by ./ports (BST-972 B2).
 * Re-exported under the historical name. Since BST-1352 the string reader is the
 * MIGRATION shim (ports' createProviderApiKeyReader); preparation itself
 * consumes the typed {@link ProviderCredentialReader}.
 */
export type { ProviderApiKeyReader as PreparationProviderApiKeyReader } from './ports.js';

export interface PrepareAssistantPostRequestParams {
  /**
   * AWS credential-chain capability (BST-1353), forwarded verbatim to the
   * shared projection. Preparation must classify a stored `profile_chain`
   * credential exactly as the host that will later CONSUME it does: desktop
   * supplies the chain builder here so preparation accepts the credential
   * (keyless — a chain has no bearer string), while Hosted Web omits it so
   * the credential rejects at preparation with the same
   * `api_key_unreadable` 400 the consumer would produce. Omitting it on
   * desktop would reject every profile-chain request before the stream ever
   * started.
   */
  readonly awsCredentialChain?: ProviderAuthProjectionOptions['awsCredentialChain'];
  /**
   * Optional trust-boundary hook (BST-1030): runs on the parsed envelope
   * AFTER parseAssistantRequestPayloadText and BEFORE tool-action extraction
   * and native-tool-id validation — the exact point Hosted Web's allow-list
   * previously reached by parsing, re-serializing, and letting preparation
   * parse again (2 parses + 1 stringify per turn; now 1 parse). The hook
   * returns the payload preparation proceeds with; a throw is NEVER mapped
   * here — every hook throw (including one that happens to be a class this
   * module maps for its own parse phase) is rethrown to the caller wrapped in
   * AssistantFilterPayloadError, and the transport unwraps `cause` and owns
   * the wire shape (NO SILENT FALLBACKS, in both directions). Desktop uses an
   * identity hook to register the initializing thread before credential work.
   */
  readonly filterPayload?: (
    payload: ParsedAssistantRequestEnvelope
  ) => ParsedAssistantRequestEnvelope;
  /**
   * Injected structured logger (BST-972 B2). NEVER a package-created scope:
   * desktop passes desktopAssistantServerLogger so the scope-cached identity
   * its integration-test spies rely on keeps observing every line.
   */
  readonly logger: ScopedLogger;
  /**
   * Bounded body read, supplied by the transport (BST-972 B2). The thunk
   * throws the agent package's typed body errors (413 included), which
   * rejectAssistantPayloadError maps — so the rejection contract stays in
   * core while the read mechanics (and the byte limit's env read) live with
   * the transport.
   */
  readonly readBody: () => Promise<string>;
  /**
   * Typed credential reader (BST-1352). Desktop passes provider-credentials'
   * `resolveProviderCredential`; Hosted Web wraps its env-only config lookup
   * into `api_key` credentials (`kind: 'api_key'` only — no typed-credential
   * resolution on web).
   */
  readonly resolveProviderCredential: ProviderCredentialReader;
}

/**
 * De-transported result (BST-972 A4): preparation never writes the response —
 * every failure path returns a rejection the transport maps via
 * respondAssistantRejection. Since B2 the transport supplies a readBody thunk
 * — no request object reaches this module at all.
 */
export type PrepareAssistantPostRequestResult =
  | { readonly ok: true; readonly request: PreparedAssistantPostRequest }
  | { readonly ok: false; readonly rejection: AssistantPostRejection };

function reject(rejection: AssistantPostRejection): PrepareAssistantPostRequestResult {
  return { ok: false, rejection };
}

/**
 * Absorbs the previous resolveApiKeyOrReject (itself the previous
 * resolveProviderApiKeyOrRespond): a classified secret-read failure becomes
 * the same 400 payload; anything else still propagates loudly. Keyless-ness
 * is registry-derived (`authType: 'none'`, PR #2513 review finding 3): the
 * in-browser runtime (registry `runtime: 'browser'`) has no credential
 * surface at all and skips the read; the local servers still read their
 * OPTIONAL bearer token, but a classified read failure proceeds keyless with
 * a visible warn instead of a 400 — the token is optional, so an unreadable
 * keychain entry must not block the run.
 *
 * BST-1352: consumes the TYPED reader. The credential-type narrow is the ONE
 * shared projection (`providerAuthInputFromCredential`, BST-1350): a
 * credential it can project yields the bearer key surface (api_key keys, and
 * bedrock aws-bearer keys whose region rides the exposed credential); a
 * credential it cannot project throws the SecretReadError-shaped typed error
 * into the classification below — the EXACT `api_key_unreadable` 400 (or the
 * keyless warn) the old string reader's `getKey` throw produced. The
 * credential is never stringified.
 */
async function resolveCredentialOrReject(
  provider: SupportedProvider,
  resolveProviderCredential: ProviderCredentialReader,
  logger: ScopedLogger,
  projectionOptions: ProviderAuthProjectionOptions | undefined
): Promise<
  | {
      readonly apiKey: string | undefined;
      readonly credential?: ResolvedProviderCredential;
      readonly rejection?: undefined;
    }
  | {
      readonly apiKey?: undefined;
      readonly credential?: undefined;
      readonly rejection: AssistantPostRejection;
    }
> {
  const keyless = providerAuthType(provider) === 'none';
  if (keyless && getProviderDefinition(provider).runtime === 'browser') {
    return { apiKey: '' };
  }
  try {
    const credential = await resolveProviderCredential(provider);
    if (credential === undefined) {
      return { apiKey: undefined };
    }
    const authInput = providerAuthInputFromCredential(provider, credential, projectionOptions);
    return { apiKey: authInput?.apiKey, credential };
  } catch (error) {
    const payload = getSecretReadErrorPayload(error);
    if (!payload) {
      throw error;
    }
    if (keyless) {
      logger.warn('Optional local-runtime token is unreadable; proceeding keyless', {
        code: payload.code,
        provider,
      });
      return { apiKey: '' };
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
  toolResumeAction: AssistantToolResumeAction | undefined,
  childFollowupAction: AssistantChildFollowupAction | undefined
): boolean {
  if (toolApprovalAction || toolResumeAction || childFollowupAction) {
    return true;
  }
  return Boolean(finalInputMessage && hasAssistantPromptContent([finalInputMessage]));
}

interface ParsedToolContinuationActions {
  readonly childFollowupAction: AssistantChildFollowupAction | undefined;
  readonly childFollowupActionInvalid: boolean;
  readonly toolApprovalAction: AssistantToolApprovalAction | undefined;
  readonly toolApprovalActionInvalid: boolean;
  readonly toolResumeAction: AssistantToolResumeAction | undefined;
  readonly toolResumeActionInvalid: boolean;
}

function rejectToolContinuationInputError(
  actions: ParsedToolContinuationActions
): AssistantPostRejection | undefined {
  if (actions.childFollowupActionInvalid) {
    return {
      payload: {
        error: 'invalid_child_followup_action',
        message:
          'Child follow-up requires only its stable request ID, selected conversation and text.',
      },
      status: 400,
    };
  }

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

  if (
    [actions.toolApprovalAction, actions.toolResumeAction, actions.childFollowupAction].filter(
      Boolean
    ).length > 1
  ) {
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
  const { awsCredentialChain, filterPayload, logger, readBody, resolveProviderCredential } = params;
  let childFollowupAction: AssistantChildFollowupAction | undefined;
  let childFollowupActionInvalid = false;
  let rawMessages: AssistantUiMessage[];
  let data: RuntimeData | undefined;
  let assistantMessageId: string | undefined;
  let inputParentMessageId: string | null | undefined;
  let pausedMessageId: string | undefined;
  let toolApprovalAction: AssistantToolApprovalAction | undefined;
  let toolApprovalActionInvalid = false;
  let toolResumeAction: AssistantToolResumeAction | undefined;
  let toolResumeActionInvalid = false;
  try {
    const payload = await parseAssistantRequestPayload(readBody, filterPayload);
    childFollowupAction = payload.childFollowupAction;
    childFollowupActionInvalid = Boolean(payload.childFollowupActionInvalid);
    assistantMessageId = payload.assistantMessageId;
    inputParentMessageId = payload.inputParentMessageId;
    pausedMessageId = payload.pausedMessageId;
    rawMessages = payload.rawMessages;
    data = payload.data;
    toolApprovalAction = payload.toolApprovalAction;
    toolApprovalActionInvalid = Boolean(payload.toolApprovalActionInvalid);
    toolResumeAction = payload.toolResumeAction;
    toolResumeActionInvalid = Boolean(payload.toolResumeActionInvalid);
  } catch (error) {
    const rejection = rejectAssistantPayloadError(error, logger);
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
    childFollowupAction,
    childFollowupActionInvalid,
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

  // Providers that never require a bearer token — the registry's
  // `authType: 'none'` set (in-browser Gemma plus the local servers,
  // BST-1349), never a hand list. Local servers accept an optional token when
  // the user has stored one via the secrets bridge, but the absence of a
  // token is not an error — most setups don't have auth.
  const keylessProvider = providerAuthType(provider) === 'none';
  const resolved = await resolveCredentialOrReject(
    provider,
    resolveProviderCredential,
    logger,
    awsCredentialChain === undefined ? undefined : { awsCredentialChain }
  );
  if (resolved.rejection) {
    return reject(resolved.rejection);
  }
  const { apiKey, credential } = resolved;
  // BST-1353: an AWS profile-chain credential is CONFIGURED but carries no
  // bearer string — the credentials live in the user's AWS setup. It is the
  // second legitimate way to have no `apiKey`, alongside keyless providers.
  // Reaching this point means the projection already ACCEPTED the credential
  // (a host without the chain capability rejected it above), so this can
  // never wave through an unusable credential.
  const providerAllowsMissingAuth =
    keylessProvider || (credential?.type === 'aws' && credential.mode === 'profile_chain');

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

  if (
    !hasAssistantPromptOrAction(
      finalInputMessage,
      toolApprovalAction,
      toolResumeAction,
      childFollowupAction
    )
  ) {
    // Deliberately message-less on the wire (the pre-A4 hand-rolled write).
    return reject({ payload: { error: 'empty_prompt' }, status: 400 });
  }

  return {
    ok: true,
    request: {
      apiKey: apiKey ?? '',
      ...(childFollowupAction ? { childFollowupAction } : {}),
      ...(assistantMessageId ? { assistantMessageId } : {}),
      ...optionalFinalInputMessage(finalInputMessage),
      ...optionalInputParentMessageId(inputParentMessageId),
      ...optionalPausedMessageId(pausedMessageId),
      ...(credential ? { credential } : {}),
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
  invalidValues: readonly unknown[],
  logger: ScopedLogger
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

function rejectAssistantPayloadError(
  error: unknown,
  logger: ScopedLogger
): AssistantPostRejection | undefined {
  if (error instanceof AssistantFilterPayloadError) {
    // Hook throws are the transport's to map — never this module's.
    return;
  }
  if (error instanceof InvalidEnabledNativeToolIdsError) {
    return rejectInvalidEnabledNativeToolIds(error.invalidValues, logger);
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
  readBody: () => Promise<string>,
  filterPayload?: (payload: ParsedAssistantRequestEnvelope) => ParsedAssistantRequestEnvelope
): Promise<AssistantRequestPayload> {
  const body = await readBody();
  const parsed = parseAssistantRequestPayloadText(body);
  let payload = parsed;
  if (filterPayload) {
    try {
      payload = filterPayload(parsed);
    } catch (error) {
      throw new AssistantFilterPayloadError(error);
    }
  }
  const childFollowupActionResult = readChildFollowupRunConfigAction(payload.runConfig);
  const toolApprovalActionResult = readToolApprovalRunConfigAction(payload.runConfig);
  const toolResumeActionResult = readToolResumeRunConfigAction(payload.runConfig);
  const parsedPayload: AssistantRequestPayload = { ...payload };
  validateEnabledNativeToolIds(parsedPayload.data);

  if (childFollowupActionResult) {
    if ('invalid' in childFollowupActionResult) {
      parsedPayload.childFollowupActionInvalid = true;
    } else {
      parsedPayload.childFollowupAction = childFollowupActionResult.action;
    }
  }

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

export function hydrateRuntimeDataWithLocalRuntimeToken(
  runtimeData: RuntimeData,
  provider: string,
  fetchedApiKey: string | undefined
): RuntimeData {
  // Only local-runtime providers (registry `runtime: 'local'` — the
  // Ollama/LM Studio servers) need their `apiToken` injected into
  // providerOptions so the OpenAI-compat factory can forward it as a bearer
  // header. Hosted providers receive the key through the top-level `apiKey`.
  const isLocalRuntimeServer =
    isSupportedProvider(provider) && getProviderDefinition(provider).runtime === 'local';
  if (!(isLocalRuntimeServer && fetchedApiKey)) {
    return runtimeData;
  }

  const providerOptions = { ...(runtimeData.providerOptions ?? {}) };
  const existing = providerOptions[provider];
  providerOptions[provider] = {
    ...(existing ?? {}),
    apiToken: fetchedApiKey,
  };

  return {
    ...runtimeData,
    providerOptions,
  };
}
