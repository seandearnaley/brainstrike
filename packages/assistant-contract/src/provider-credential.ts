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
 * `{last4, savedAt}` save fingerprint); `oauth` has no metadata field.
 */

export type ProviderCredential =
  | { type: 'api_key'; key: string; metadata?: Record<string, string> }
  | { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string }
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
    };

export type ProviderCredentialType = ProviderCredential['type'];

export const PROVIDER_CREDENTIAL_TYPES = [
  'api_key',
  'oauth',
  'aws',
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
export const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;

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

export function isOauthCredential(
  value: unknown
): value is Extract<ProviderCredential, { type: 'oauth' }> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    access?: unknown;
    accountId?: unknown;
    expires?: unknown;
    refresh?: unknown;
    type?: unknown;
  };
  return (
    candidate.type === 'oauth' &&
    typeof candidate.access === 'string' &&
    typeof candidate.refresh === 'string' &&
    typeof candidate.expires === 'number' &&
    Number.isFinite(candidate.expires) &&
    isOptionalString(candidate.accountId)
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

export function isProviderCredential(value: unknown): value is ProviderCredential {
  return isApiKeyCredential(value) || isOauthCredential(value) || isAwsCredential(value);
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
