import { type ModelCatalogSnapshot, projectModelCatalog } from '@brainstrike/assistant-contract';
import type { WorkspaceRootRecord } from '@brainstrike/state-store';
import { vi } from 'vitest';
import type { DesktopHostToolServices } from '../../agent-host-platform/production-desktop-capabilities';

function admissionModelSnapshot(): ModelCatalogSnapshot {
  const snapshot = projectModelCatalog({ models: [], providers: [] });
  return {
    ...snapshot,
    models: snapshot.models.map((model) => ({ ...model, isEnabled: true })),
    providers: snapshot.providers.map((provider) => ({ ...provider, isEnabled: false })),
  };
}

/** Recorded catalog/root DTOs at Main's typed read boundary; SQL is deliberately unavailable. */
export function admissionCatalogFixture(
  readRoots: () => readonly Pick<WorkspaceRootRecord, 'id' | 'path' | 'displayName'>[]
) {
  const modelRead = vi.fn(async () => admissionModelSnapshot());
  const workspaceRoots = vi.fn(async () => ({
    roots: readRoots().map((root) => ({
      ...root,
      canonicalPath: root.path,
      createdAt: 1,
      kind: 'path' as const,
      lastVerifiedAt: 1,
      projectId: `project-${root.path}`,
      projectName: null,
      status: 'live' as const,
    })),
  }));
  const services: Pick<DesktopHostToolServices, 'modelCatalog' | 'workspaceRoots'> = {
    modelCatalog: { read: modelRead },
    workspaceRoots: { workspaceRoots },
  };
  return { modelRead, services, workspaceRoots };
}
