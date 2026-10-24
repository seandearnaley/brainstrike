/**
 * Pure provider-error projection used by provider-runtime. Redact and bound
 * visible evidence, preserve typed failures, and choose credential guidance
 * from the provider registry. The decoder suite pins referential transparency.
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
  MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS,
  PROVIDER_RUN_ERROR_FALLBACK_CODE,
  type ProviderRunError,
} from '../provider-error-metadata';
import { OpenAIStoredItemExpiredError } from '../providers/openai-expired-item';
import type { RuntimeData } from '../types';

/** Cap the provider error detail rendered as visible assistant text. Provider
 * error bodies can be verbose; the full detail is preserved in the log. */
export const MAX_VISIBLE_PROVIDER_ERROR_CHARS = MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS;
export const PROVIDER_ERROR_TRUNCATION_MARKER = '… [truncated]';

/**
 * The one clamp used for every user-visible or persisted stream detail, so provider evidence cannot drift into different truncation rules.
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
 * for Bedrock (`aws`; bearer key OR an AWS profile
 * chain whose SSO session can expire) and for a local runtime (`none`; the
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
  if (value instanceof OpenAIStoredItemExpiredError) {
    const failure = refusal({
      category: 'configuration',
      code: 'provider.request-rejected',
      message: OpenAIStoredItemExpiredError.publicMessage,
    });
    return { detail: describeBoundaryFailure(failure), failure, runError };
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
