import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type {
  WorktreeCreateContext,
  WorktreeCreateParams,
  WorktreeRepositorySetupDecision,
  WorktreeSettings,
} from '@brainstrike/types';
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
  try {
    await fsPromises.access(scriptPath);
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
  };
}

export function repositorySetupDecisionInput(
  params: WorktreeCreateParams,
  repositoryId: string
): { readonly repositorySetupDecision?: WorktreeRepositorySetupDecision } {
  if (params.repositorySetupDecision?.repositoryId !== repositoryId) {
    return {};
  }
  return { repositorySetupDecision: params.repositorySetupDecision.decision };
}
