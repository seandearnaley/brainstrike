import type { KeyringCredentialStore } from '@brainstrike/agent-host/credential-contract';

/** One decrypted entry of a retired store, under its existing account name. */
export interface LegacySecretEntry {
  readonly account: string;
  readonly value: string;
}

/**
 * A retired encrypted store (Electron safeStorage today). The shell that can
 * decrypt it supplies plaintext entries in-process; values never cross IPC.
 */
export interface LegacySecretSource {
  /** Every stored entry. A decrypt failure rejects; it is never an absent entry. */
  entries(signal?: AbortSignal): Promise<readonly LegacySecretEntry[]>;
  /** Remove the retired copy. Called only after every entry is verified in the store. */
  retire(signal?: AbortSignal): Promise<void>;
}

export interface LegacySecretMigrationReport {
  /** Entries whose identical value was already present (an interrupted earlier pass). */
  readonly alreadyPresent: number;
  readonly migrated: number;
}

/** The store already holds a different value for an account; both copies are kept. */
export class LegacySecretConflictError extends Error {
  readonly accounts: readonly string[];
  readonly code = 'legacy_secret_conflict';
  constructor(accounts: readonly string[]) {
    super(
      `The credential store already holds different values for ${accounts.length} legacy account(s); the legacy store was kept.`
    );
    this.name = 'LegacySecretConflictError';
    this.accounts = accounts;
  }
}

/** A written value did not read back identically; the legacy store was kept. */
export class LegacySecretVerificationError extends Error {
  readonly account: string;
  readonly code = 'legacy_secret_verification_failed';
  constructor(account: string) {
    super('A migrated credential did not read back from the credential store.');
    this.name = 'LegacySecretVerificationError';
    this.account = account;
  }
}

/**
 * One-time move of a retired store into the host credential store. Accounts keep
 * their names. Conflicts refuse before any write; the legacy copy is retired only
 * after every entry reads back identically, so an interrupted pass is re-runnable.
 */
export async function migrateLegacySecrets(options: {
  readonly destination: KeyringCredentialStore;
  readonly signal?: AbortSignal;
  readonly source: LegacySecretSource;
}): Promise<LegacySecretMigrationReport> {
  const { destination, signal, source } = options;
  const entries = await source.entries(signal);
  const accounts = new Set<string>();
  for (const entry of entries) {
    if (entry.account.length === 0 || accounts.has(entry.account)) {
      throw new TypeError('Legacy secret entries need unique, non-empty account names.');
    }
    accounts.add(entry.account);
  }
  const pending: LegacySecretEntry[] = [];
  const conflicts: string[] = [];
  let alreadyPresent = 0;
  for (const entry of entries) {
    const current = await destination.read(entry.account, signal);
    if (current === null) {
      pending.push(entry);
    } else if (current === entry.value) {
      alreadyPresent += 1;
    } else {
      conflicts.push(entry.account);
    }
  }
  if (conflicts.length > 0) {
    throw new LegacySecretConflictError(conflicts);
  }
  for (const entry of pending) {
    await destination.write(entry.account, entry.value, signal);
  }
  for (const entry of entries) {
    if ((await destination.read(entry.account, signal)) !== entry.value) {
      throw new LegacySecretVerificationError(entry.account);
    }
  }
  if (entries.length > 0) {
    await source.retire(signal);
  }
  return { alreadyPresent, migrated: pending.length };
}
