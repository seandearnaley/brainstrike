/**
 * BST-985: the PURE decode half of the Mastra stream boundary.
 *
 * Everything here takes an untyped Mastra chunk (or a value read off one) and
 * returns a validated Brainstrike value. These functions are referentially
 * transparent: no clock, no id minting, no logging, no mutation of their
 * arguments. That is the contract this module exists to hold, and
 * `__tests__/mastra-chunk-decoding.spec.ts` enforces it directly instead of
 * through a full fake Mastra stream.
 *
 * The IMPURE half — run-event minting (`generateUUID` + `new Date()`),
 * lifecycle-state bookkeeping, and the coded `logger` diagnostics — stays in
 * `agent-streaming.ts` alongside `processMastraStreamPart`, which also remains
 * the single R6 dispatch site pinned by `scripts/mastra-stream-chunk-contract.mjs`.
 * See docs/agents/mastra-boundary.md R6.
 */
import {
  type BoundaryFailure,
  BoundaryFailureError,
  describeBoundaryFailure,
  fault,
  INTERNAL_FAULT,
  refusal,
} from '@brainstrike/assistant-contract';
import {
  findProviderDefinition,
  type ProviderAuthType,
} from '@brainstrike/assistant-contract/provider-registry';
import { scrubLikelySecretValues } from '@brainstrike/utils/diagnostics';
import {
  extractProviderRunError,
  isLocalRunErrorClassification,
  LOCAL_RUN_ERROR_FALLBACK_CODE,
  MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS,
  PROVIDER_RUN_ERROR_FALLBACK_CODE,
  type ProviderRunError,
} from '../provider-error-metadata';
import type { AssistantRunEventJson, AssistantRunEventMetadata } from '../run-events';
import { sanitizeAssistantRunEventMetadata } from '../run-events';
import type { RuntimeData, StreamChunkTool, StreamFinishReason } from '../types';
import {
  readOpenRouterDiagnostics,
  readStreamPartUsage,
  type UsageLike,
} from './runtime-assembly/usage-metering';

/** Shape of a Mastra stream part with potential usage/text/tool payload fields. */
export interface MastraStreamPart {
  delta?: string;
  error?: unknown;
  finishReason?: unknown;
  messageId?: unknown;
  payload?: {
    delta?: string;
    error?: unknown;
    metadata?: { providerMetadata?: unknown; usage?: UsageLike };
    output?: { usage?: UsageLike };
    processorId?: unknown;
    reason?: unknown;
    retry?: unknown;
    stepResult?: { reason?: unknown };
    text?: string;
    textDelta?: string;
    tripwireReason?: unknown;
  };
  providerMetadata?: unknown;
  runId?: unknown;
  text?: string;
  textDelta?: string;
  tripwireReason?: unknown;
  type: string;
  usage?: UsageLike;
}

export function asMastraStreamPart(part: unknown): MastraStreamPart {
  if (part && typeof part === 'object') {
    return part as MastraStreamPart;
  }
  return { type: 'unknown' };
}

/** Cap the provider error detail rendered as visible assistant text. Provider
 * error bodies can be verbose; the full detail is preserved in the log. */
export const MAX_VISIBLE_PROVIDER_ERROR_CHARS = MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS;
export const PROVIDER_ERROR_TRUNCATION_MARKER = '… [truncated]';

/**
 * The one clamp used for every user-visible or persisted stream detail, so a
 * tripwire reason, a processor id, a provider error body, and an observational
 * memory failure cannot drift into subtly different truncation rules.
 *
 * The result NEVER exceeds `maxChars`. That needs saying because the obvious
 * implementation does not hold it: `slice(0, maxChars - marker.length)` with a
 * cap smaller than the 13-char marker passes a negative end index, which
 * `String.prototype.slice` reinterprets as an offset from the END — returning
 * more characters than the input for a cap of 5 (review #2169). A cap with no
 * room for the marker drops the marker rather than the guarantee.
 */
export function truncateStreamDetail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const room = maxChars - PROVIDER_ERROR_TRUNCATION_MARKER.length;
  if (room <= 0) {
    return value.slice(0, Math.max(0, maxChars));
  }
  return `${value.slice(0, room)}${PROVIDER_ERROR_TRUNCATION_MARKER}`;
}

function normalizeFinishReason(reason: string): StreamFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
    case 'unknown':
      return reason;
    case 'tool_calls':
      return 'tool-calls';
    default:
      return 'unrecognized';
  }
}

export function readFinishReason(part: unknown): StreamFinishReason {
  const p = asMastraStreamPart(part);
  const direct = p.finishReason;
  if (typeof direct === 'string' && direct.length > 0) {
    return normalizeFinishReason(direct);
  }
  const nested = p.payload?.stepResult?.reason;
  if (typeof nested === 'string' && nested.length > 0) {
    return normalizeFinishReason(nested);
  }
  return 'absent';
}

export function getDeltaText(part: unknown): string {
  const p = asMastraStreamPart(part);
  const payloadText = p.payload?.text ?? p.payload?.textDelta ?? p.payload?.delta;
  return p.text ?? p.textDelta ?? p.delta ?? payloadText ?? '';
}

export function isRunEventMetadata(value: unknown): value is AssistantRunEventMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function makeStepMetadata(part: unknown): AssistantRunEventMetadata | undefined {
  const p = asMastraStreamPart(part);
  const metadata: AssistantRunEventMetadata = {};
  if (typeof p.messageId === 'string' && p.messageId.length > 0) {
    metadata['messageId'] = p.messageId;
  }
  // Reading just `p.usage` here left every step event token-free in
  // production (a real part nests usage under `payload.output.usage`), which
  // silently killed the renderer's live tick (BST-953) — caught by live CDP,
  // missed by every unit test because the fixtures are top-level shaped. The
  // shared reader is now the single source of that knowledge.
  const stepUsage = readStreamPartUsage(p);
  if (stepUsage) {
    const promptTokens = stepUsage.promptTokens ?? stepUsage.inputTokens;
    if (typeof promptTokens === 'number' && Number.isFinite(promptTokens)) {
      metadata['promptTokens'] = promptTokens;
    }
    // v1/v2 fallback, same reason: an AI-SDK-v2 part carries `outputTokens`,
    // and the live tick needs BOTH counts on the step event.
    const completionTokens = stepUsage.completionTokens ?? stepUsage.outputTokens;
    if (typeof completionTokens === 'number' && Number.isFinite(completionTokens)) {
      metadata['completionTokens'] = completionTokens;
    }
  }
  const openRouterDiagnostics = readOpenRouterDiagnostics(p);
  if (openRouterDiagnostics?.provider) {
    metadata['openRouterProvider'] = openRouterDiagnostics.provider;
  }
  if (openRouterDiagnostics?.reasoningTokens !== undefined) {
    metadata['reasoningTokens'] = openRouterDiagnostics.reasoningTokens;
  }
  return isRunEventMetadata(metadata) && Object.keys(metadata).length > 0 ? metadata : undefined;
}

// ---------------------------------------------------------------------------
// Tool-event payload decoding
// ---------------------------------------------------------------------------

function getToolEventPayload(toolEvent: StreamChunkTool): AssistantRunEventMetadata | undefined {
  return isRunEventMetadata(toolEvent.payload) ? toolEvent.payload : undefined;
}

export function getToolCallIdFromToolEvent(toolEvent: StreamChunkTool): string | undefined {
  const payload = getToolEventPayload(toolEvent);
  return typeof payload?.['toolCallId'] === 'string'
    ? payload['toolCallId']
    : typeof payload?.['callId'] === 'string'
      ? payload['callId']
      : undefined;
}

export function makeToolEventMetadata(toolEvent: StreamChunkTool): AssistantRunEventMetadata {
  const payload = getToolEventPayload(toolEvent);
  const toolCallId = getToolCallIdFromToolEvent(toolEvent);
  const metadata: AssistantRunEventMetadata = {
    toolName: toolEvent.name,
    ...(toolCallId ? { toolCallId } : {}),
  };
  if (typeof payload?.['providerExecuted'] === 'boolean') {
    metadata['providerExecuted'] = payload['providerExecuted'];
  }
  if (typeof payload?.['dynamic'] === 'boolean') {
    metadata['dynamic'] = payload['dynamic'];
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Tripwire decoding
// ---------------------------------------------------------------------------

export const INVALID_TRIPWIRE_REASON =
  'Mastra emitted a malformed tripwire without a valid reason.';
const MAX_TRIPWIRE_PROCESSOR_ID_CHARS = 256;
const MAX_TRIPWIRE_METADATA_KEY_CHARS = 128;
const MAX_TRIPWIRE_METADATA_ARRAY_ITEMS = 32;
const MAX_TRIPWIRE_METADATA_OBJECT_ENTRIES = 32;
const TRIPWIRE_METADATA_SUMMARY_KEY = '__brainstrikeSummary';
const SAFE_TRIPWIRE_METADATA_STRING_KEYS = new Set([
  'category',
  'kind',
  'processorId',
  'rule',
  'severity',
  'strategy',
  'type',
]);

type TripwireSource = 'legacy-tripwire-reason' | 'malformed' | 'mastra-1.51';

export interface ResolvedTripwire {
  detail: string;
  diagnostic: AssistantRunEventJson;
}

interface OptionalTripwireField<T> {
  malformed: boolean;
  value?: T;
}

function makeTripwireMetadataSummary(
  input: Record<string, AssistantRunEventJson>
): AssistantRunEventJson {
  return { [TRIPWIRE_METADATA_SUMMARY_KEY]: input };
}

function isSafeTripwireMetadataString(key: string | undefined, value: string): boolean {
  if (key === 'match') {
    return value === '[REDACTED_MATCH]';
  }
  return (
    key !== undefined &&
    SAFE_TRIPWIRE_METADATA_STRING_KEYS.has(key) &&
    value.length <= MAX_TRIPWIRE_METADATA_KEY_CHARS &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  );
}

function boundTripwireMetadataArray(value: AssistantRunEventJson[]): AssistantRunEventJson {
  const items = value
    .slice(0, MAX_TRIPWIRE_METADATA_ARRAY_ITEMS)
    .map((item) => boundTripwireMetadata(item));
  if (value.length <= MAX_TRIPWIRE_METADATA_ARRAY_ITEMS) {
    return items;
  }
  return {
    [TRIPWIRE_METADATA_SUMMARY_KEY]: {
      itemCount: value.length,
      kind: 'array',
      omittedItemCount: value.length - MAX_TRIPWIRE_METADATA_ARRAY_ITEMS,
    },
    items,
  };
}

function boundTripwireMetadataObject(
  value: Record<string, AssistantRunEventJson>
): AssistantRunEventJson {
  const entries = Object.entries(value);
  const bounded: Record<string, AssistantRunEventJson> = {};
  let acceptedEntryCount = 0;
  let omittedEntryCount = 0;
  let overlongKeyCount = 0;
  let reservedKeyCount = 0;
  for (const [key, nested] of entries) {
    if (key === TRIPWIRE_METADATA_SUMMARY_KEY) {
      omittedEntryCount += 1;
      reservedKeyCount += 1;
      continue;
    }
    if (key.length > MAX_TRIPWIRE_METADATA_KEY_CHARS) {
      omittedEntryCount += 1;
      overlongKeyCount += 1;
      continue;
    }
    if (acceptedEntryCount >= MAX_TRIPWIRE_METADATA_OBJECT_ENTRIES) {
      omittedEntryCount += 1;
      continue;
    }
    bounded[key] = boundTripwireMetadata(nested, key);
    acceptedEntryCount += 1;
  }
  if (omittedEntryCount > 0) {
    bounded[TRIPWIRE_METADATA_SUMMARY_KEY] = {
      entryCount: entries.length,
      kind: 'object',
      omittedEntryCount,
      ...(overlongKeyCount === 0 ? {} : { overlongKeyCount }),
      ...(reservedKeyCount === 0 ? {} : { reservedKeyCount }),
    };
  }
  return bounded;
}

function boundTripwireMetadata(
  value: AssistantRunEventJson,
  sourceKey?: string
): AssistantRunEventJson {
  if (typeof value === 'string') {
    return isSafeTripwireMetadataString(sourceKey, value)
      ? value
      : makeTripwireMetadataSummary({
          characterCount: value.length,
          kind: 'string',
        });
  }
  if (Array.isArray(value)) {
    return boundTripwireMetadataArray(value);
  }
  return value && typeof value === 'object' ? boundTripwireMetadataObject(value) : value;
}

function isTripwireMetadataJson(value: unknown, depth = 0): boolean {
  // The shared sanitizer receives this value one level deeper under `{value}`.
  // Reject anything at depth eight so it cannot silently coerce depth nine to null.
  if (depth >= 8) {
    return false;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isTripwireMetadataJson(item, depth + 1));
  }
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!(prototype === Object.prototype || prototype === null)) {
    return false;
  }
  return Object.values(value).every((nested) => isTripwireMetadataJson(nested, depth + 1));
}

function sanitizeTripwireMetadata(value: unknown): AssistantRunEventJson | undefined {
  if (!isTripwireMetadataJson(value)) {
    return;
  }
  const sanitized = sanitizeAssistantRunEventMetadata({ value })?.['value'];
  return sanitized === undefined ? undefined : boundTripwireMetadata(sanitized);
}

function makeTripwireDiagnostic(
  source: TripwireSource,
  input: {
    malformedFields?: string[];
    metadata?: AssistantRunEventJson;
    processorId?: string;
    retry?: boolean;
  }
): AssistantRunEventJson {
  return {
    ...(input.malformedFields && input.malformedFields.length > 0
      ? { malformedFields: input.malformedFields }
      : {}),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.processorId === undefined ? {} : { processorId: input.processorId }),
    ...(input.retry === undefined ? {} : { retry: input.retry }),
    source,
  };
}

function hasCurrentTripwirePayload(
  payload: MastraStreamPart['payload']
): payload is NonNullable<MastraStreamPart['payload']> {
  return (
    payload !== undefined &&
    (Object.hasOwn(payload, 'reason') ||
      Object.hasOwn(payload, 'retry') ||
      Object.hasOwn(payload, 'processorId'))
  );
}

function resolveLegacyTripwire(part: MastraStreamPart): ResolvedTripwire {
  const legacyReason = part.tripwireReason ?? part.payload?.tripwireReason;
  if (typeof legacyReason !== 'string' || legacyReason.trim().length === 0) {
    return {
      detail: INVALID_TRIPWIRE_REASON,
      diagnostic: makeTripwireDiagnostic('malformed', {
        malformedFields: ['reason'],
      }),
    };
  }
  return {
    detail: truncateStreamDetail(legacyReason.trim(), MAX_VISIBLE_PROVIDER_ERROR_CHARS),
    diagnostic: makeTripwireDiagnostic('legacy-tripwire-reason', {}),
  };
}

function readOptionalTripwireMetadata(
  payload: NonNullable<MastraStreamPart['payload']>
): OptionalTripwireField<AssistantRunEventJson> {
  if (!Object.hasOwn(payload, 'metadata')) {
    return { malformed: false };
  }
  const metadata = sanitizeTripwireMetadata(payload.metadata);
  if (metadata === undefined) {
    return { malformed: true };
  }
  return { malformed: false, value: metadata };
}

function readOptionalTripwireProcessorId(
  payload: NonNullable<MastraStreamPart['payload']>
): OptionalTripwireField<string> {
  if (!Object.hasOwn(payload, 'processorId')) {
    return { malformed: false };
  }
  if (typeof payload.processorId !== 'string' || payload.processorId.trim().length === 0) {
    return { malformed: true };
  }
  return {
    malformed: false,
    value: truncateStreamDetail(payload.processorId.trim(), MAX_TRIPWIRE_PROCESSOR_ID_CHARS),
  };
}

function readOptionalTripwireRetry(
  payload: NonNullable<MastraStreamPart['payload']>
): OptionalTripwireField<boolean> {
  if (!Object.hasOwn(payload, 'retry')) {
    return { malformed: false };
  }
  if (typeof payload.retry !== 'boolean') {
    return { malformed: true };
  }
  return { malformed: false, value: payload.retry };
}

function resolveCurrentTripwire(part: MastraStreamPart): ResolvedTripwire {
  const payload = part.payload as NonNullable<MastraStreamPart['payload']>;
  const metadata = readOptionalTripwireMetadata(payload);
  const processorId = readOptionalTripwireProcessorId(payload);
  const retry = readOptionalTripwireRetry(payload);
  const reason = payload.reason;
  const currentReason =
    typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null;
  const legacyReason = part.tripwireReason ?? payload.tripwireReason;
  const validLegacyReason =
    typeof legacyReason === 'string' && legacyReason.trim().length > 0 ? legacyReason.trim() : null;
  const resolvedReason = currentReason ?? validLegacyReason;
  const malformedFields = [
    ...(metadata.malformed ? ['metadata'] : []),
    ...(processorId.malformed ? ['processorId'] : []),
    ...(resolvedReason === null ? ['reason'] : []),
    ...(retry.malformed ? ['retry'] : []),
  ];
  return {
    detail: resolvedReason
      ? truncateStreamDetail(resolvedReason, MAX_VISIBLE_PROVIDER_ERROR_CHARS)
      : INVALID_TRIPWIRE_REASON,
    diagnostic: makeTripwireDiagnostic(
      currentReason ? 'mastra-1.51' : validLegacyReason ? 'legacy-tripwire-reason' : 'malformed',
      {
        malformedFields,
        ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
        ...(processorId.value === undefined ? {} : { processorId: processorId.value }),
        ...(retry.value === undefined ? {} : { retry: retry.value }),
      }
    ),
  };
}

export function resolveTripwire(part: unknown): ResolvedTripwire {
  const streamPart = asMastraStreamPart(part);
  if (!hasCurrentTripwirePayload(streamPart.payload)) {
    return resolveLegacyTripwire(streamPart);
  }
  return resolveCurrentTripwire(streamPart);
}

// ---------------------------------------------------------------------------
// Provider-error decoding
// ---------------------------------------------------------------------------

export interface ResolvedProviderError {
  detail: string;
  failure: BoundaryFailure;
  runError: ProviderRunError;
}

export function extractErrorMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  try {
    return String(value);
  } catch {
    return;
  }
}

/**
 * The ONE wrong-credential HTTP status (BST-1384). Mirrors the Settings "Test
 * connection" probe's settled classifier (`provider-verification.ts`): 401 is
 * `invalid`; 403 is authenticated-but-limited and 429 is a rate-limited VALID
 * credential, so neither may be read as a credential problem here either.
 * Keeping the two in agreement is the point — a run must not blame the
 * credential for a status the probe would report as "verified".
 */
const REJECTED_CREDENTIAL_HTTP_STATUS = 401;

/**
 * The remedy half of the 401 copy, keyed by the provider's registry
 * `authType` (PR #2573 review). The remedy MUST match how that provider
 * actually authenticates — an "update the API key" instruction is a dead end
 * for a ChatGPT subscription session (`oauth_subscription`; its stored key is
 * the `oauth-subscription-no-api-key` placeholder and a 401 means the session
 * expired or was revoked), for Bedrock (`aws`; bearer key OR an AWS profile
 * chain whose SSO session can expire), and for a local runtime (`none`; the
 * optional bearer is `providerOptions.apiToken`, configured under Local
 * Runtimes — there is no Settings key to edit). Settings surface names are the
 * CURRENT category titles ("Providers" replaced "API Keys" in #2529).
 */
function rejectedCredentialRemedy(authType: ProviderAuthType, subject: string): string {
  switch (authType) {
    case 'api_key':
      return `${subject} rejected the API key (HTTP ${REJECTED_CREDENTIAL_HTTP_STATUS}) — it is invalid or was revoked. Update the key in Settings → Providers, or verify it in the provider dashboard.`;
    case 'aws':
      return `${subject} rejected the AWS credentials (HTTP ${REJECTED_CREDENTIAL_HTTP_STATUS}) — they are invalid or expired. Update the Bedrock credential in Settings → Providers, or refresh the AWS profile session (for example \`aws sso login\`).`;
    case 'none':
      return `${subject} rejected the request as unauthorized (HTTP ${REJECTED_CREDENTIAL_HTTP_STATUS}). Check the runtime’s API token under Settings → Local Runtimes.`;
    case 'oauth_subscription':
      return `${subject} rejected the sign-in session (HTTP ${REJECTED_CREDENTIAL_HTTP_STATUS}) — it expired or was revoked. Sign in again in Settings → Providers.`;
    default: {
      // Exhaustive: a new registry authType must choose its remedy here.
      const exhaustive: never = authType;
      throw new Error(`Unhandled provider authType: ${String(exhaustive)}`);
    }
  }
}

/** Neutral remedy for a provider the registry does not know (no authType to branch on). */
const REJECTED_CREDENTIAL_UNKNOWN_PROVIDER_REMEDY = `The provider rejected the credential (HTTP ${REJECTED_CREDENTIAL_HTTP_STATUS}) — it is invalid or was revoked. Check the provider’s credential in Settings → Providers.`;

/**
 * Visible copy for a provider-evidenced 401. GUIDANCE FIRST, provider body
 * LAST: the termination helper clamps the visible detail to
 * {@link MAX_VISIBLE_PROVIDER_ERROR_CHARS}, so this ordering guarantees the
 * clamp can only ever shorten the provider's text, never the instruction
 * (pinned by the clamp spec in mastra-chunk-decoding.spec.ts).
 *
 * The raw body is still appended (and the runError envelope is untouched)
 * because it is the only provider-side evidence the user has: OpenRouter's
 * 401 body is literally "User not found." for ANY unrecognized key — shown
 * alone it reads like an app bug, which is the 2026-08-21 field failure that
 * motivated this classification. This is a DELIBERATE asymmetry with the
 * Settings probe, which composes its detail from the status alone: the
 * pre-change visible detail WAS the raw body and `runError.message` persists
 * it regardless, so nothing new is exposed here.
 */
function describeRejectedCredential(provider: string | undefined): string {
  const definition = provider === undefined ? undefined : findProviderDefinition(provider);
  const remedy = definition
    ? rejectedCredentialRemedy(definition.authType, definition.displayName)
    : REJECTED_CREDENTIAL_UNKNOWN_PROVIDER_REMEDY;
  return remedy;
}

export function resolveProviderError(
  value: unknown,
  runtimeData: RuntimeData | undefined
): ResolvedProviderError {
  const runError = extractProviderRunError(value);
  if (value instanceof BoundaryFailureError) {
    return { detail: describeBoundaryFailure(value.failure), failure: value.failure, runError };
  }
  if (isLocalRunErrorClassification(runError.code)) {
    return { detail: INTERNAL_FAULT.message, failure: INTERNAL_FAULT, runError };
  }
  const extractedDetail = extractErrorMessage(value);
  const providerBody =
    extractedDetail && extractedDetail !== '[object Object]'
      ? extractedDetail
      : (runError.message ?? 'No provider response detail was supplied.');
  const provider = runtimeData?.provider?.trim().toLowerCase();
  const includeStableCode =
    provider === 'openrouter' && runError.code !== PROVIDER_RUN_ERROR_FALLBACK_CODE;
  const evidence = scrubLikelySecretValues(providerBody).text;
  const providerEvidence = truncateStreamDetail(
    includeStableCode ? `[${runError.code}] ${evidence}` : evidence,
    MAX_VISIBLE_PROVIDER_ERROR_CHARS
  );
  const failure =
    runError.httpStatus === REJECTED_CREDENTIAL_HTTP_STATUS
      ? refusal({
          category: 'authorization',
          code: 'provider.credential-rejected',
          message: describeRejectedCredential(provider),
          providerEvidence,
        })
      : (runError.httpStatus !== undefined && runError.httpStatus >= 500) ||
          runError.httpStatus === 429
        ? fault({
            category: 'availability',
            code: 'provider.unavailable',
            message: 'The provider could not complete this request.',
            providerEvidence,
          })
        : refusal({
            category: 'configuration',
            code: 'provider.request-rejected',
            message: 'The provider rejected this request.',
            providerEvidence,
          });
  return { detail: describeBoundaryFailure(failure), failure, runError };
}

export function buildProviderErrorDiagnosticCode(runError: ProviderRunError): string {
  const httpStatus = runError.httpStatus === undefined ? 'no_status' : String(runError.httpStatus);
  if (
    runError.code === PROVIDER_RUN_ERROR_FALLBACK_CODE ||
    runError.code === LOCAL_RUN_ERROR_FALLBACK_CODE
  ) {
    return `${runError.code}:${httpStatus}`;
  }
  // Stable typed codes are namespaced by classification: the local model's
  // malformed-tool-arguments fault never crossed to a provider, so it must not
  // wear the provider log fingerprint either.
  const namespace = isLocalRunErrorClassification(runError.code)
    ? LOCAL_RUN_ERROR_FALLBACK_CODE
    : PROVIDER_RUN_ERROR_FALLBACK_CODE;
  return `${namespace}:${runError.code}:${httpStatus}`;
}

interface ProviderErrorDiagnosticCorrelation {
  readonly resourceId?: string;
  readonly rootId?: string;
  readonly runId?: string;
  readonly threadId?: string;
}

/**
 * Explicit request context for the provider-error diagnostic choke point.
 *
 * These identifiers must ride the structured log argument: the durable
 * diagnostic converter promotes correlation from context keys, not logger
 * bindings or ambient async state. The run id is the renderer-minted durable
 * id carried in memory; the root is the server-validated thread binding.
 */
export function buildProviderErrorDiagnosticCorrelation(
  runtimeData: RuntimeData | undefined
): ProviderErrorDiagnosticCorrelation {
  const memory = runtimeData?.memory;
  return {
    ...(memory?.resourceId ? { resourceId: memory.resourceId } : {}),
    ...(runtimeData?.boundWorkspaceRootId ? { rootId: runtimeData.boundWorkspaceRootId } : {}),
    ...(memory?.runId ? { runId: memory.runId } : {}),
    ...(memory?.threadId ? { threadId: memory.threadId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Observational-memory chunk decoding
// ---------------------------------------------------------------------------

export const OM_FAILURE_DETAIL_MAX_CHARS = 500;

/**
 * Mastra streams observational-memory bookkeeping as DYNAMIC `data-om-*`
 * chunks (not in the static disposition map, so they must branch BEFORE the
 * typed switch whose default clause carries the R6 unrecognized-chunk
 * diagnostic — see scripts/mastra-stream-chunk-contract.mjs).
 */
export function isObservationalMemoryDataChunkType(type: unknown): type is string {
  return typeof type === 'string' && type.startsWith('data-om-');
}

export function readOmTokenCount(
  payload: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = payload?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
