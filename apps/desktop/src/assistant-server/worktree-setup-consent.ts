import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type {
  WorktreeCreateContext,
  WorktreeCreateParams,
  WorktreeSettings,
} from '@brainstrike/types';
import { sha256OfBuffer } from './hooks/trust';
import type { RepositorySetupDecisionInput } from './worktree-service';
import { REPOSITORY_SETUP_SCRIPT } from './worktree-setup';

interface RepositorySetupIdentity {
  readonly commonDir: string;
  readonly repositoryRoot: string;
}

export async function resolveRepositorySetupContext(
  settings: WorktreeSettings,
  context: RepositorySetupIdentity
): Promise<WorktreeCreateContext['repositorySetup']> {
  if (settings.setupCommand !== null) {
    return null;
  }
  const scriptPath = path.join(context.repositoryRoot, REPOSITORY_SETUP_SCRIPT);
  // Read the bytes rather than just probing existence: the same read backs
  // both the ENOENT check and the SHA-256 the renderer pins its decision to,
  // byte-identically to the re-hash `resolveSetupCommand` does at run time —
  // a utf8-decoded-string hash would diverge for BOM/non-utf8 scripts and an
  // approval would silently never take (mirrors the hooks trust precedent).
  let bytes: Buffer;
  try {
    bytes = await fsPromises.readFile(scriptPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return {
    repositoryId: context.commonDir,
    repositoryPath: context.repositoryRoot,
    scriptPath,
    scriptSha256: sha256OfBuffer(bytes),
  };
}

export function repositorySetupDecisionInput(
  params: WorktreeCreateParams,
  repositoryId: string
): { readonly repositorySetupDecision?: RepositorySetupDecisionInput } {
  if (params.repositorySetupDecision?.repositoryId !== repositoryId) {
    return {};
  }
  return {
    repositorySetupDecision: {
      decision: params.repositorySetupDecision.decision,
      scriptSha256: params.repositorySetupDecision.scriptSha256,
    },
  };
}
