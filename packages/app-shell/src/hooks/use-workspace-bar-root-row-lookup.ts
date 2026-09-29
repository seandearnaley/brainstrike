/**
 * The durable `roots.id` lookup used by `use-workspace-bar.ts`'s Add-folder,
 * worktree, and MAIN-root-fallback resolution paths — extracted purely to
 * stay under Biome's file-line cap, the same reason
 * `use-workspace-bar-write-derive.ts` exists. Hook-free, pure async logic;
 * nothing here imports React or reads component state directly.
 */
import type { DbHandle } from '@brainstrike/db/react';
import {
  type AssistantOperatingRootCandidate,
  AssistantOperatingRootRowNotFoundError,
  resolveAssistantOperatingRootBinding,
} from '../assistant-operating-root';
import { awaitRootRegistration, rootRegistrationSeq } from '../roots/root-registration-events';

/**
 * A folder's durable `roots` row is written by the roots-reconciliation effect
 * in `workspace-collection-sync-provider.tsx`, which runs only AFTER
 * `addRootDirectory()` has resolved and re-rendered the provider. Looking the
 * row up in the same microtask therefore loses that race, and the folder mounts
 * globally while never being attached to the thread. Re-mounting a
 * `'disconnected'` root has the same shape (the row is flipped back to 'live'
 * by the same effect).
 *
 * So the lookup AWAITS the reconciliation layer's own "root registered"
 * notification (`../roots/root-registration-events.ts`) instead of polling
 * the database for the side effect — the canonical fix, landed in BST-1400
 * item 1. The seam is EPOCH-based, not a one-shot flag, so a path registered
 * a SECOND time this session (the remove-then-re-add shape above) still wakes
 * a waiter whose first read raced it — see that module's docblock. A bounded
 * timeout is still enforced (`ROOT_ROW_WAIT_TIMEOUT_MS`, the same ~5s budget
 * the old 20×250ms retry loop had): exhaustion is not a silent no-op for any
 * caller.
 */
const ROOT_ROW_WAIT_TIMEOUT_MS = 5000;

export type RootRowLookup =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'resolved'; readonly rootId: string }
  | { readonly error: unknown; readonly kind: 'unresolved' };

type RootRowAttempt =
  | { readonly kind: 'miss'; readonly error: unknown }
  | { readonly kind: 'query-failed'; readonly error: unknown }
  | { readonly kind: 'resolved'; readonly rootId: string };

/**
 * A bounded number of immediate retries for a raw `database.query` failure —
 * NOT the same bound as `ROOT_ROW_WAIT_TIMEOUT_MS`'s registration wait, and
 * deliberately independent of it. See `tryResolveRootId`'s doc for why a
 * query failure must never fall into that wait.
 */
const TRANSIENT_QUERY_RETRY_ATTEMPTS = 3;

/**
 * One read of the durable `roots` row for `candidate.path`. Never throws.
 *
 * `database.query` rejecting is NOT the same outcome as an authoritative
 * "no unique live row" result (`AssistantOperatingRootRowNotFoundError`) —
 * the row may already exist, and a transient query failure (a connection
 * blip, IPC hiccup) says nothing about that. Treating it as a miss the way
 * the original version of this function did sent the caller into
 * `awaitRootRegistration`'s wait for a registration EVENT that will never
 * fire for a row that was never missing in the first place — the MAIN
 * primary could disappear until an unrelated invalidation, and Add Folder
 * could mount a folder globally while reporting it was never attached,
 * after burning the full wait timeout on an event nothing was ever going to
 * send.
 *
 * So only `AssistantOperatingRootRowNotFoundError` is a `'miss'` (safe to
 * wait for registration). Any other error retries the SAME read a bounded
 * number of times immediately — most query failures worth retrying are
 * transient enough that an immediate re-read succeeds — and if every retry
 * still fails, reports `'query-failed'` so the caller surfaces it right
 * away instead of taking the wait path for an event that cannot help here.
 */
async function tryResolveRootId(
  database: DbHandle,
  candidate: AssistantOperatingRootCandidate
): Promise<RootRowAttempt> {
  let lastError: unknown;
  // eslint-disable-next-line react-doctor/async-await-in-loop -- inherently serial: each retry is only attempted after the previous one has already failed, and parallelizing would just spam the same read concurrently for no benefit.
  for (let attempt = 0; attempt < TRANSIENT_QUERY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const binding = await resolveAssistantOperatingRootBinding(database, candidate);
      return { kind: 'resolved', rootId: binding.rootId };
    } catch (error) {
      if (error instanceof AssistantOperatingRootRowNotFoundError) {
        return { error, kind: 'miss' };
      }
      lastError = error;
    }
  }
  return { error: lastError, kind: 'query-failed' };
}

/**
 * The durable `roots.id` for a path, AWAITING reconciliation's own
 * registration event when the row is not there yet (instead of polling the
 * database for it — see the docblock above `ROOT_ROW_WAIT_TIMEOUT_MS`). Never
 * rejects: every outcome — including timeout — is returned so the caller can
 * surface it. Timeout is NOT a silent no-op for any caller.
 */
export async function resolveRootIdAfterReconciliation(
  database: DbHandle,
  candidate: AssistantOperatingRootCandidate,
  isCancelled: () => boolean
): Promise<RootRowLookup> {
  if (isCancelled()) {
    return { kind: 'cancelled' };
  }
  // Captured BEFORE the first read, not after: a registration for this exact
  // path can land concurrently with (or immediately after) that read — most
  // commonly a remove-then-re-add, since re-adding mints a fresh adapter id
  // and so is a genuine SECOND registration of the same path, not a no-op.
  // Comparing against the generation observed here (rather than asking "was
  // this path EVER registered?") is what makes a registration that beats the
  // first read still satisfy the wait below, instead of the wait resolving
  // instantly off a stale earlier registration while the row is still absent.
  const since = rootRegistrationSeq(candidate.path);
  const firstAttempt = await tryResolveRootId(database, candidate);
  if (firstAttempt.kind === 'resolved') {
    return { kind: 'resolved', rootId: firstAttempt.rootId };
  }
  // A query failure (retried already, see tryResolveRootId) is NOT an
  // authoritative "row absent" — the row may already exist, and no
  // registration event is coming to wake this wait. Surface it immediately
  // instead of burning the full wait timeout for an event that cannot fix a
  // read failure.
  if (firstAttempt.kind === 'query-failed') {
    return isCancelled()
      ? { kind: 'cancelled' }
      : { error: firstAttempt.error, kind: 'unresolved' };
  }
  if (isCancelled()) {
    return { kind: 'cancelled' };
  }
  try {
    await awaitRootRegistration(candidate.path, { since, timeoutMs: ROOT_ROW_WAIT_TIMEOUT_MS });
  } catch (waitError) {
    // Timed out: reconciliation never announced this path. Loud, not silent —
    // the caller logs/toasts this outcome.
    return isCancelled() ? { kind: 'cancelled' } : { error: waitError, kind: 'unresolved' };
  }
  if (isCancelled()) {
    return { kind: 'cancelled' };
  }
  const secondAttempt = await tryResolveRootId(database, candidate);
  if (secondAttempt.kind === 'resolved') {
    return { kind: 'resolved', rootId: secondAttempt.rootId };
  }
  // Registration was announced but the row still fails the unique-live-row
  // read (e.g. a genuine duplicate path) — surface THAT error, not a stale one.
  return isCancelled() ? { kind: 'cancelled' } : { error: secondAttempt.error, kind: 'unresolved' };
}
