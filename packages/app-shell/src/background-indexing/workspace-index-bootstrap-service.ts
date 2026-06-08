import {
  type EmbeddingSet,
  type IEmbeddingSetsRepository,
  WORKSPACE_INDEX_SYSTEM_ROLE,
} from '@brainstrike/db';

export interface WorkspaceIndexBootstrapRequest {
  readonly enabled: boolean;
  readonly managedCollectionId: string | null;
}

export interface WorkspaceIndexBootstrapDependencies {
  readonly embeddingSetsRepository: Pick<IEmbeddingSetsRepository, 'getOrCreateWorkspaceIndexSet'>;
  readonly setManagedCollectionId: (managedCollectionId: string) => void;
}

export async function bootstrapWorkspaceIndexCollection(
  request: WorkspaceIndexBootstrapRequest,
  deps: WorkspaceIndexBootstrapDependencies
): Promise<EmbeddingSet | null> {
  if (!(request.enabled && request.managedCollectionId === null)) {
    return null;
  }

  const collection = await deps.embeddingSetsRepository.getOrCreateWorkspaceIndexSet();
  if (collection.systemRole !== WORKSPACE_INDEX_SYSTEM_ROLE) {
    throw new Error('Workspace index bootstrap returned a collection without the system role.');
  }

  deps.setManagedCollectionId(collection.id);
  return collection;
}
