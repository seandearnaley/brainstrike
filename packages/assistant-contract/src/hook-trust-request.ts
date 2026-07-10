/**
 * Wire type for the renderer's hook-trust snapshot.
 *
 * The renderer ATTESTS a per-root approved content hash; the desktop server
 * independently re-reads and re-hashes the on-disk `.brainstrike/hooks.json`
 * and runs a root's project hooks only when the disk hash matches an approval
 * for that `rootId` (threat model: the attacker is the repo, not the renderer).
 * Keyed by durable `rootId`, never raw path (multi-root discipline).
 */

export interface HookTrustApproval {
  readonly approvedAt: number;
  readonly rootId: string;
  readonly sha256: string;
}

export interface HookTrustRequest {
  readonly approvals: readonly HookTrustApproval[];
}
