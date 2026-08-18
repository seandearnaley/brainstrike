/**
 * Non-secret provenance fingerprint for a STORED credential (BST-1362):
 * the last (at most) four characters of the secret plus the ISO save
 * timestamp, both computed at save time. Never derived from a stored value
 * after the fact, and never more than four characters — the fingerprint is
 * displayable metadata, not key material.
 */
export interface StoredKeyFingerprint {
  readonly last4: string;
  readonly savedAt: string;
}

/**
 * Which AWS auth form actually WON resolution (BST-1353). Orthogonal to
 * env-vs-stored: a bearer key can come from either, and so can a profile
 * chain. Present only on `aws`-authType providers; every other provider omits
 * it entirely.
 *
 * This exists because the precedence table (bearer > chain; env > stored
 * within each) is otherwise invisible — a user with both a stored bearer key
 * and an `AWS_PROFILE` environment has no way to tell which one the next
 * request will sign with. The badge names the winner.
 */
export type ProviderAuthMode = 'bearer' | 'profile_chain';

export type ProviderKeySource<Id extends string> =
  | {
      readonly authMode?: ProviderAuthMode;
      readonly envVar: string;
      readonly metadata?: never;
      readonly provider: Id;
      readonly source: 'env';
    }
  | {
      readonly authMode?: ProviderAuthMode;
      readonly envVar?: never;
      readonly metadata?: StoredKeyFingerprint;
      readonly provider: Id;
      readonly source: 'stored';
    };

export function isProviderAuthMode(value: unknown): value is ProviderAuthMode {
  return value === 'bearer' || value === 'profile_chain';
}

/**
 * Env names that ACTIVATE the AWS credential chain (BST-1353), in priority
 * order. THE single definition: the desktop resolver reads it to decide
 * activation, and both strict key-source parsers read it to accept it as a
 * legitimate `envVar` — a hand-copied second list would drift and turn a
 * working chain into "Invalid provider key source".
 */
export const AWS_CHAIN_ACTIVATION_ENV_NAMES = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID'] as const;

/**
 * Whether `envVar` is a name the provider can legitimately report as its key
 * source. Non-aws providers accept only their own registry env names; an
 * aws-authType provider additionally accepts the chain ACTIVATION names,
 * which are not credentials and therefore never appear in the registry.
 *
 * Takes the provider's own names as a parameter rather than importing the
 * registry, so this module stays import-free (it is consumed from both the
 * renderer and desktop main).
 */
export function isAllowedProviderKeySourceEnvVar(
  envVar: string,
  providerEnvVarNames: readonly string[],
  isAwsAuthProvider: boolean
): boolean {
  if (providerEnvVarNames.includes(envVar)) {
    return true;
  }
  return (
    isAwsAuthProvider && (AWS_CHAIN_ACTIVATION_ENV_NAMES as readonly string[]).includes(envVar)
  );
}

/**
 * Strict optional-key reader shared by both arms. The parser's contract is
 * that an UNRECOGNIZED key rejects the whole payload (it previously enforced
 * that by counting keys); this keeps that guarantee while letting each arm
 * declare more than one optional field.
 *
 * EXPORTED (PR #2525 review, finding 8) so the app-shell status parser reuses
 * this exact rule instead of maintaining a look-alike — two hand-rolled
 * strictness checks over one wire shape is precisely how the two consumers
 * drift.
 */
export function assertNoUnknownKeys(
  candidate: Record<string, unknown>,
  allowed: readonly string[],
  invalidPayload: () => Error
): void {
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) {
      throw invalidPayload();
    }
  }
}

/**
 * Reads the optional `authMode`. Absent is fine (non-aws providers); present
 * but not a known mode is a malformed payload, never coerced or dropped.
 *
 * EXPORTED for the app-shell status parser (PR #2525 review, finding 8) —
 * same reason as {@link assertNoUnknownKeys}.
 */
export function parseAuthMode(
  candidate: Record<string, unknown>,
  invalidPayload: () => Error
): ProviderAuthMode | undefined {
  if (!Object.hasOwn(candidate, 'authMode')) {
    return;
  }
  const authMode = candidate['authMode'];
  if (!isProviderAuthMode(authMode)) {
    throw invalidPayload();
  }
  return authMode;
}

/**
 * Builds the save-time fingerprint. Throws for an empty secret — an empty
 * secret is never a configured credential, so fingerprinting one is a bug.
 * Secrets shorter than eight characters yield NO fingerprint: the `…last4`
 * of a very short secret would reveal half or more of the key material, so
 * the row shows a plain Stored badge with no hint instead (BST-1362).
 */
export function createStoredKeyFingerprint(
  secret: string,
  savedAt: Date = new Date()
): StoredKeyFingerprint | undefined {
  const trimmedLength = secret.trim().length;
  if (trimmedLength === 0) {
    throw new Error('Cannot fingerprint an empty credential secret.');
  }
  if (trimmedLength < 8) {
    return;
  }
  return { last4: secret.trim().slice(-4), savedAt: savedAt.toISOString() };
}

/**
 * Exact-shape guard for {@link StoredKeyFingerprint}: exactly the two keys,
 * `last4` a 1-4 character string (longer would leak key material), `savedAt`
 * a parseable date string.
 */
export function isStoredKeyFingerprint(value: unknown): value is StoredKeyFingerprint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2) {
    return false;
  }
  const candidate = value as { last4?: unknown; savedAt?: unknown };
  return (
    typeof candidate.last4 === 'string' &&
    candidate.last4.length > 0 &&
    candidate.last4.length <= 4 &&
    typeof candidate.savedAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.savedAt))
  );
}

export interface ParseProviderKeySourcesOptions<Id extends string> {
  /** Every provider id the payload may mention; anything else is malformed. */
  readonly allowedProviders: ReadonlySet<string>;
  /** Consumer-specific error for a malformed payload (message surfaces in UI). */
  readonly invalidPayload: () => Error;
  /** Whether `envVar` is a name the given provider actually resolves. */
  readonly isAllowedEnvVar: (provider: Id, envVar: string) => boolean;
}

function parseStoredEntry<Id extends string>(
  candidate: Record<string, unknown>,
  provider: Id,
  options: ParseProviderKeySourcesOptions<Id>
): ProviderKeySource<Id> {
  if (Object.hasOwn(candidate, 'envVar')) {
    throw options.invalidPayload();
  }
  assertNoUnknownKeys(
    candidate,
    ['authMode', 'metadata', 'provider', 'source'],
    options.invalidPayload
  );
  const authMode = parseAuthMode(candidate, options.invalidPayload);
  if (!Object.hasOwn(candidate, 'metadata')) {
    return { ...(authMode ? { authMode } : {}), provider, source: 'stored' };
  }
  // The save-time fingerprint is validated hard (BST-1362) — malformed
  // metadata is a visible failure, never guessed at.
  const metadata = candidate['metadata'];
  if (!isStoredKeyFingerprint(metadata)) {
    throw options.invalidPayload();
  }
  return { ...(authMode ? { authMode } : {}), metadata, provider, source: 'stored' };
}

function parseEnvEntry<Id extends string>(
  candidate: Record<string, unknown>,
  provider: Id,
  options: ParseProviderKeySourcesOptions<Id>
): ProviderKeySource<Id> {
  assertNoUnknownKeys(
    candidate,
    ['authMode', 'envVar', 'provider', 'source'],
    options.invalidPayload
  );
  const envVar = candidate['envVar'];
  if (
    typeof envVar !== 'string' ||
    envVar.trim().length === 0 ||
    !options.isAllowedEnvVar(provider, envVar)
  ) {
    throw options.invalidPayload();
  }
  const authMode = parseAuthMode(candidate, options.invalidPayload);
  return { ...(authMode ? { authMode } : {}), envVar, provider, source: 'env' };
}

/**
 * The ONE hard validator for `secrets:list`-shaped payloads (BST-1362).
 * Both strict consumers (the settings Credential Inventory and the
 * assistant-preferences configured-provider probe) parse through here so the
 * accepted wire shape can never drift between them. Every violation throws
 * the consumer's error — no entry is ever skipped or coerced.
 */
export function parseProviderKeySources<Id extends string>(
  value: unknown,
  options: ParseProviderKeySourcesOptions<Id>
): ProviderKeySource<Id>[] {
  if (!Array.isArray(value)) {
    throw options.invalidPayload();
  }

  const seen = new Set<string>();
  return value.map((entry: unknown): ProviderKeySource<Id> => {
    if (!(entry && typeof entry === 'object')) {
      throw options.invalidPayload();
    }
    const candidate = entry as Record<string, unknown>;
    const provider = candidate['provider'];
    const source = candidate['source'];
    if (
      typeof provider !== 'string' ||
      !options.allowedProviders.has(provider) ||
      seen.has(provider) ||
      (source !== 'env' && source !== 'stored')
    ) {
      throw options.invalidPayload();
    }
    seen.add(provider);
    return source === 'stored'
      ? parseStoredEntry(candidate, provider as Id, options)
      : parseEnvEntry(candidate, provider as Id, options);
  });
}
