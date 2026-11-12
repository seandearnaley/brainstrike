/**
 * Typed provider credentials for the desktop secrets store (BST-1348).
 *
 * The stored value is `JSON.stringify(credential)` encrypted exactly like the
 * pre-existing bare-string keys. Reading applies the settled decision table:
 *
 * | stored raw value                                   | outcome                  |
 * | -------------------------------------------------- | ------------------------ |
 * | not JSON at all (`sk-abc123`)                      | legacy api_key of raw    |
 * | JSON but not an object (number/array/string/bool)  | legacy api_key of raw    |
 * | JSON object WITHOUT a `type` property              | legacy api_key of raw    |
 * | JSON object with `type` not in the union           | MalformedCredentialError |
 * | JSON object with non-string `type`                 | MalformedCredentialError |
 * | recognized `type`, missing/invalid required fields | MalformedCredentialError |
 * | recognized `type`, invalid optional field types    | MalformedCredentialError |
 * | recognized `type`, all fields valid                | that credential          |
 *
 * The `type` property is the tag marker. A stored value that never claims to
 * be a tagged credential IS a legacy bare api_key — that is a defined mapping
 * (every pre-BST-1348 key is exactly such a string), not a fallback. A value
 * that claims a tag but cannot be recognized or validated is a hard failure
 * (NO SILENT FALLBACKS); the desktop read path surfaces it as
 * `SecretReadError('malformed_credential', …)`.
 *
 * Field rules: an `api_key` key must be NON-EMPTY (an empty key is never a
 * configured credential); `aws` splits by mode — `bearer` REQUIRES
 * `bearerKey`, `profile_chain` keeps `profile` optional (the default AWS
 * profile chain is legitimate). Both `api_key` and `aws` carry an optional
 * non-secret string-record `metadata` (BST-1362 uses it for the
 * `{last4, savedAt}` save fingerprint).
 *
 * `chatgpt_sign_in` is this installation's Sign in with ChatGPT registration
 * (ADR-0038). It exists from the first sign-in attempt, because OpenAI needs
 * the same `hostId` on every attempt, and it outlives sign-out so a later
 * sign-in reuses the issued `clientId`. Only a record with a `session` is a
 * configured credential ({@link isSignedInChatGptCredential}).
 */

export type ProviderCredential =
  | { type: 'api_key'; key: string; metadata?: Record<string, string> }
  | {
      type: 'aws';
      mode: 'bearer';
      bearerKey: string;
      region: string;
      metadata?: Record<string, string>;
    }
  | {
      type: 'aws';
      mode: 'profile_chain';
      profile?: string;
      region: string;
      metadata?: Record<string, string>;
    }
  | ChatGptSignInCredential;

/** The tokens of one ChatGPT sign-in. They never leave the host process. */
export interface ChatGptSession {
  accessToken: string;
  /** Epoch milliseconds at which the access token stops working. */
  expiresAt: number;
  refreshToken: string;
  /** The scopes OpenAI granted, as its token response listed them. */
  scopes: string[];
}

export interface ChatGptSignInCredential {
  /** The OAuth client OpenAI registered for this user and workspace. */
  clientId?: string;
  /** The signed-in account's email, for display and as the next sign-in's hint. */
  email?: string;
  /** OpenAI's `ext_agent_host_id` for this installation: `urn:uuid:` and a UUID. */
  hostId: string;
  session?: ChatGptSession;
  /** The validated ID token's `sub`: the account a later sign-in must match. */
  subject?: string;
  type: 'chatgpt_sign_in';
}

/** The scope that lets requests draw on the signed-in account's ChatGPT plan. */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';

/**
 * The API a ChatGPT sign-in's tokens are for: the OAuth `resource`, and the
 * only base URL those tokens are ever sent to.
 */
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';

export type ProviderCredentialType = ProviderCredential['type'];

export const PROVIDER_CREDENTIAL_TYPES = [
  'api_key',
  'aws',
  'chatgpt_sign_in',
] as const satisfies readonly ProviderCredentialType[];

/**
 * A stored value claimed to be a tagged credential (it carried a `type`
 * property) but could not be recognized or validated. Messages are STATIC by
 * contract — neither field values nor the offending type tag are ever echoed,
 * so a credential can never leak through an error message.
 */
export class MalformedCredentialError extends Error {
  constructor(detail: string) {
    super(`Stored provider credential is malformed: ${detail}.`);
    this.name = 'MalformedCredentialError';
  }
}

/**
 * AWS region identifier format (BST-1350 review — SECURITY). The region is
 * interpolated into the Bedrock request HOSTNAME
 * (`bedrock-runtime.<region>.amazonaws.com`), so a value like
 * `evil.example.com/` would redirect the bearer token and prompt content to
 * an attacker-controlled host. Accept only the documented AWS region shape:
 * lowercase geography words joined by hyphens ending in a number (covers
 * `us-east-1`, `us-gov-west-1`, `ap-southeast-4`, `il-central-1`, …).
 * Enforced here (stored credentials, both modes) AND at the factory auth
 * input (`assertValidProviderAuthInput`) — never trimmed or coerced.
 */
export const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/u;

export function isValidAwsRegion(region: string): boolean {
  return AWS_REGION_PATTERN.test(region);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isApiKeyCredential(
  value: unknown
): value is Extract<ProviderCredential, { type: 'api_key' }> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { key?: unknown; metadata?: unknown; type?: unknown };
  return (
    candidate.type === 'api_key' &&
    typeof candidate.key === 'string' &&
    candidate.key.length > 0 &&
    (candidate.metadata === undefined || isStringRecord(candidate.metadata))
  );
}

export function isAwsCredential(
  value: unknown
): value is Extract<ProviderCredential, { type: 'aws' }> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    bearerKey?: unknown;
    metadata?: unknown;
    mode?: unknown;
    profile?: unknown;
    region?: unknown;
    type?: unknown;
  };
  if (
    candidate.type !== 'aws' ||
    typeof candidate.region !== 'string' ||
    !isValidAwsRegion(candidate.region) ||
    !(candidate.metadata === undefined || isStringRecord(candidate.metadata))
  ) {
    return false;
  }
  switch (candidate.mode) {
    case 'bearer':
      return typeof candidate.bearerKey === 'string' && candidate.bearerKey.length > 0;
    case 'profile_chain':
      return isOptionalString(candidate.profile);
    default:
      return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isChatGptSession(value: unknown): value is ChatGptSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const scopes = candidate['scopes'];
  return (
    isNonEmptyString(candidate['accessToken']) &&
    isNonEmptyString(candidate['refreshToken']) &&
    typeof candidate['expiresAt'] === 'number' &&
    Number.isFinite(candidate['expiresAt']) &&
    Array.isArray(scopes) &&
    scopes.every((scope) => typeof scope === 'string')
  );
}

const CHATGPT_HOST_ID_PATTERN = /^urn:uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export function isChatGptSignInCredential(value: unknown): value is ChatGptSignInCredential {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const session = candidate['session'];
  return (
    candidate['type'] === 'chatgpt_sign_in' &&
    typeof candidate['hostId'] === 'string' &&
    CHATGPT_HOST_ID_PATTERN.test(candidate['hostId']) &&
    (candidate['clientId'] === undefined || isNonEmptyString(candidate['clientId'])) &&
    isOptionalString(candidate['email']) &&
    isOptionalString(candidate['subject']) &&
    (session === undefined ||
      (isChatGptSession(session) &&
        // Tokens belong to exactly one registered client and one account.
        isNonEmptyString(candidate['clientId']) &&
        isNonEmptyString(candidate['subject'])))
  );
}

/** A registration whose tokens may spend the account's ChatGPT plan. */
export function isSignedInChatGptCredential(
  credential: ProviderCredential
): credential is ChatGptSignInCredential & {
  clientId: string;
  session: ChatGptSession;
  subject: string;
} {
  return (
    credential.type === 'chatgpt_sign_in' &&
    credential.session?.scopes.includes(CHATGPT_PLAN_SCOPE) === true
  );
}

export function isProviderCredential(value: unknown): value is ProviderCredential {
  return isApiKeyCredential(value) || isAwsCredential(value) || isChatGptSignInCredential(value);
}

function isTaggedObject(value: unknown): value is { type: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'type')
  );
}

/**
 * Interpret a decrypted secrets-store value per the decision table above.
 * Returns the typed credential; throws {@link MalformedCredentialError} for a
 * tagged-but-invalid value. Never coerces.
 */
export function parseStoredCredential(raw: string): ProviderCredential {
  const legacy: ProviderCredential = { key: raw, type: 'api_key' };

  // Fast path: only a JSON object can be a tagged credential, so anything not
  // starting with `{` is the legacy mapping without paying for JSON.parse.
  if (!raw.trimStart().startsWith('{')) {
    return legacy;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — every pre-BST-1348 stored key lands here. Defined mapping.
    return legacy;
  }

  if (!isTaggedObject(parsed)) {
    // JSON, but never claims to be a tagged credential (an object without
    // `type`) — legacy by definition.
    return legacy;
  }

  if (
    typeof parsed.type !== 'string' ||
    !PROVIDER_CREDENTIAL_TYPES.some((type) => type === parsed.type)
  ) {
    throw new MalformedCredentialError('unrecognized credential type tag');
  }
  if (!isProviderCredential(parsed)) {
    throw new MalformedCredentialError('credential has missing or invalid fields for its type');
  }
  return parsed;
}
