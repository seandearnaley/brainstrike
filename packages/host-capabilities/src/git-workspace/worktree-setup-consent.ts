/**
 * Repository setup script consent (ADR-0034): the person's answer for a
 * repository's `.brainstrike/worktree-setup.sh`, kept by the agent host under
 * ONE state-store setting. Each repository is keyed by its realpath'd git
 * common dir, which every checkout of it shares, and its answer is pinned to
 * the SHA-256 of the script's bytes the person answered for.
 *
 * This module is the record's only reader and writer. Only a person's answer
 * reaches the writer (the create sheet's Allow and Skip, Settings › Workspace's
 * Revoke), never a run. Every worktree the service creates reads the record,
 * so the person's own creation, the model's worktree tool and Automatic
 * isolation all run the script when the repository is approved at the script's
 * current hash. `resolveSetupCommand` re-hashes the script before it runs and
 * fails closed.
 *
 * The state store has no listing by prefix, so the record is one JSON value,
 * as the trusted locations are (`workspace.trust.locations`), and its changes
 * are serialized per store so that two answers never drop each other's.
 */
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { StateStore } from '@brainstrike/state-store';
import type {
  WorktreeCreateContext,
  WorktreeRepositorySetupDecision,
  WorktreeSettings,
  WorktreeSetupConsent,
} from '@brainstrike/types';
import { Schema } from 'effect';
import { sha256OfBuffer } from '../hooks/trust.ts';
import { gitRefused } from './git-failure.ts';
import type { RepositoryContext, RepositorySetupDecisionInput } from './worktree-service-inputs.ts';
import { REPOSITORY_SETUP_SCRIPT } from './worktree-setup.ts';

/** The one setting that holds every repository's answer. */
export const WORKTREE_SETUP_CONSENT_KEY = 'worktrees.setup.consent';

/** The host's state store settings, which hold the answers. */
export type WorktreeSetupConsentStore = Pick<
  StateStore,
  'deleteSetting' | 'getSetting' | 'setSetting'
>;

const StoredConsentSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    decidedAt: Schema.String,
    decision: Schema.Literals(['approved', 'denied']),
    scriptSha256: Schema.String,
  })
);
type StoredConsent = (typeof StoredConsentSchema)['Type'];
const decodeStoredConsent = Schema.decodeUnknownSync(StoredConsentSchema);

/**
 * Every answer, by repository. A value the host did not write throws rather
 * than reading as no answer: a corrupt record is a fault to show, not a reason
 * to ask again silently.
 */
async function readStoredConsent(store: WorktreeSetupConsentStore): Promise<StoredConsent> {
  const value = await store.getSetting(WORKTREE_SETUP_CONSENT_KEY);
  if (value === undefined) {
    return {};
  }
  const stored = decodeStoredConsent(JSON.parse(value));
  if (!Object.keys(stored).every((repositoryId) => path.isAbsolute(repositoryId))) {
    // The host records realpath'd common dirs only, so this value is not one it wrote.
    throw new Error('The stored worktree setup consent names a repository by a relative path');
  }
  return stored;
}

/** One change at a time per store: two answers never drop each other's. */
const consentChanges = new WeakMap<WorktreeSetupConsentStore, Promise<unknown>>();
function changeStoredConsent<T>(
  store: WorktreeSetupConsentStore,
  change: (stored: StoredConsent) => { readonly result: T; readonly stored: StoredConsent }
): Promise<T> {
  const next = (consentChanges.get(store) ?? Promise.resolve()).then(async () => {
    const { result, stored } = change(await readStoredConsent(store));
    if (Object.keys(stored).length === 0) {
      await store.deleteSetting(WORKTREE_SETUP_CONSENT_KEY);
    } else {
      await store.setSetting(WORKTREE_SETUP_CONSENT_KEY, JSON.stringify(stored));
    }
    return result;
  });
  // A failed change is its caller's; the next one still runs.
  consentChanges.set(
    store,
    next.catch(() => undefined)
  );
  return next;
}

/** The repository's answer as the service hands it to setup, or undefined when there is none. */
export async function readWorktreeSetupConsent(
  store: WorktreeSetupConsentStore,
  repositoryId: string
): Promise<RepositorySetupDecisionInput | undefined> {
  const entry = (await readStoredConsent(store))[repositoryId];
  return entry === undefined
    ? undefined
    : { decision: entry.decision, scriptSha256: entry.scriptSha256 };
}

/** Every repository's answer, by repository id, for Settings › Workspace. */
export async function listWorktreeSetupConsents(
  store: WorktreeSetupConsentStore
): Promise<readonly WorktreeSetupConsent[]> {
  return Object.entries(await readStoredConsent(store))
    .map(([repositoryId, entry]) => ({ ...entry, repositoryId }))
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
}

/**
 * Records the person's answer for the script in the repository's checkout,
 * only for the bytes on disk now, which the person was shown by hash: a
 * script that changed since is refused, and nothing is recorded. An answer
 * replaces the repository's earlier one.
 */
export async function decideWorktreeSetupConsent(
  store: WorktreeSetupConsentStore,
  request: {
    readonly decision: WorktreeRepositorySetupDecision;
    readonly repository: Pick<RepositoryContext, 'commonDir' | 'repositoryRoot'>;
    readonly scriptSha256: string;
  }
): Promise<BoundaryResult<WorktreeSetupConsent>> {
  const scriptPath = path.join(request.repository.repositoryRoot, REPOSITORY_SETUP_SCRIPT);
  let bytes: Buffer;
  try {
    bytes = await fsPromises.readFile(scriptPath);
  } catch (error) {
    return gitRefused(
      'input',
      'worktree.setup-consent-refused',
      `${scriptPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (sha256OfBuffer(bytes) !== request.scriptSha256) {
    return gitRefused(
      'conflict',
      'worktree.setup-consent-refused',
      `${scriptPath} changed since it was shown; review it again.`
    );
  }
  const consent: WorktreeSetupConsent = {
    decidedAt: new Date().toISOString(),
    decision: request.decision,
    repositoryId: request.repository.commonDir,
    scriptSha256: request.scriptSha256,
  };
  return {
    ok: true,
    value: await changeStoredConsent(store, (stored) => ({
      result: consent,
      stored: {
        ...stored,
        [consent.repositoryId]: {
          decidedAt: consent.decidedAt,
          decision: consent.decision,
          scriptSha256: consent.scriptSha256,
        },
      },
    })),
  };
}

/** Removes the repository's answer, so its next worktree asks again; false when it had none. */
export function revokeWorktreeSetupConsent(
  store: WorktreeSetupConsentStore,
  repositoryId: string
): Promise<boolean> {
  return changeStoredConsent(store, (stored) => {
    if (!Object.hasOwn(stored, repositoryId)) {
      return { result: false, stored };
    }
    const { [repositoryId]: _revoked, ...rest } = stored;
    return { result: true, stored: rest };
  });
}

/**
 * The create sheet's view of the repository's script: where it is, its hash
 * now, and the standing answer when it was given for those bytes. Null when
 * a setup command in Settings replaces the script, or the checkout has none.
 */
export async function resolveRepositorySetupContext(
  settings: WorktreeSettings,
  context: Pick<RepositoryContext, 'commonDir' | 'repositoryRoot'>,
  readConsent: (repositoryId: string) => Promise<RepositorySetupDecisionInput | undefined>
): Promise<WorktreeCreateContext['repositorySetup']> {
  if (settings.setupCommand !== null) {
    return null;
  }
  const scriptPath = path.join(context.repositoryRoot, REPOSITORY_SETUP_SCRIPT);
  // The raw bytes, hashed as `resolveSetupCommand` hashes them at run time: a
  // hash of decoded text would differ for a script that is not UTF-8, and an
  // approval would never take.
  let bytes: Buffer;
  try {
    bytes = await fsPromises.readFile(scriptPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const scriptSha256 = sha256OfBuffer(bytes);
  const standing = await readConsent(context.commonDir);
  return {
    decision: standing?.scriptSha256 === scriptSha256 ? standing.decision : null,
    repositoryId: context.commonDir,
    repositoryPath: context.repositoryRoot,
    scriptPath,
    scriptSha256,
  };
}
