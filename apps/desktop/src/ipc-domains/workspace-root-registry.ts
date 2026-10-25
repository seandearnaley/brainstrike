import {
  WorkspaceRootRegistry as NodeWorkspaceRootRegistry,
  type WorkspaceRootRegistryOptions,
} from '@brainstrike/assistant-service/node-workspace-services';
import {
  disposeHostCommandSessionsForRoot,
  evictHostLspServersForRoot,
} from '../agent-host-platform/host-root-cleanup-client';

export type { SecureWorkspaceRoot } from '@brainstrike/assistant-service/node-workspace-services';

type DesktopOptions = Omit<
  WorkspaceRootRegistryOptions,
  'disposeCommandSessionsForRoot' | 'evictLspServersForRoot'
> &
  Partial<
    Pick<WorkspaceRootRegistryOptions, 'disposeCommandSessionsForRoot' | 'evictLspServersForRoot'>
  >;

export class WorkspaceRootRegistry extends NodeWorkspaceRootRegistry {
  constructor(options: DesktopOptions) {
    super({
      ...options,
      disposeCommandSessionsForRoot:
        options.disposeCommandSessionsForRoot ?? disposeHostCommandSessionsForRoot,
      evictLspServersForRoot: options.evictLspServersForRoot ?? evictHostLspServersForRoot,
    });
  }
}
