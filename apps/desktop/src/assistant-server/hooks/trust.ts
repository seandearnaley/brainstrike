/**
 * Project-hook trust resolution (desktop / main-process authority).
 *
 * The renderer only ATTESTS a per-root approved content hash. This module is
 * the server authority: it re-reads the on-disk `.brainstrike/hooks.json`,
 * hashes it, and marks a root trusted iff the disk hash equals an approval
 * hash for that same `rootId`. A changed file → untrusted (re-approval needed).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HookTrustRequest } from '@brainstrike/agent';
import { getProjectHooksPath } from './config';

export function sha256OfFile(absPath: string): string | null {
  try {
    const content = readFileSync(absPath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    // Missing/unreadable file is not an error here — it means "no trust".
    return null;
  }
}

export interface TrustRootInput {
  readonly absPath: string;
  readonly rootId: string;
}

export function resolveTrustedRoots(
  roots: readonly TrustRootInput[],
  request: HookTrustRequest | undefined
): ReadonlyMap<string, boolean> {
  const approvedByRoot = new Map<string, string>();
  for (const approval of request?.approvals ?? []) {
    approvedByRoot.set(approval.rootId, approval.sha256);
  }

  const trusted = new Map<string, boolean>();
  for (const root of roots) {
    const approvedHash = approvedByRoot.get(root.rootId);
    if (!approvedHash) {
      trusted.set(root.rootId, false);
      continue;
    }
    const diskHash = sha256OfFile(getProjectHooksPath(root.absPath));
    trusted.set(root.rootId, diskHash !== null && diskHash === approvedHash);
  }
  return trusted;
}
