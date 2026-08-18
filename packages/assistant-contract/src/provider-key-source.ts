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

export type ProviderKeySource<Id extends string> =
  | {
      readonly envVar: string;
      readonly metadata?: never;
      readonly provider: Id;
      readonly source: 'env';
    }
  | {
      readonly envVar?: never;
      readonly metadata?: StoredKeyFingerprint;
      readonly provider: Id;
      readonly source: 'stored';
    };

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
  const keyCount = Object.keys(candidate).length;
  if (Object.hasOwn(candidate, 'envVar')) {
    throw options.invalidPayload();
  }
  if (keyCount === 2) {
    return { provider, source: 'stored' };
  }
  // The only optional third key is the save-time fingerprint; validated hard
  // (BST-1362) — malformed metadata is a visible failure, never guessed at.
  if (keyCount !== 3 || !Object.hasOwn(candidate, 'metadata')) {
    throw options.invalidPayload();
  }
  const metadata = candidate['metadata'];
  if (!isStoredKeyFingerprint(metadata)) {
    throw options.invalidPayload();
  }
  return { metadata, provider, source: 'stored' };
}

function parseEnvEntry<Id extends string>(
  candidate: Record<string, unknown>,
  provider: Id,
  options: ParseProviderKeySourcesOptions<Id>
): ProviderKeySource<Id> {
  const envVar = candidate['envVar'];
  if (
    Object.keys(candidate).length !== 3 ||
    typeof envVar !== 'string' ||
    envVar.trim().length === 0 ||
    !options.isAllowedEnvVar(provider, envVar)
  ) {
    throw options.invalidPayload();
  }
  return { envVar, provider, source: 'env' };
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
