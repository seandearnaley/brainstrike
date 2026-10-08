import {
  WorkspaceRootRegistry as NodeWorkspaceRootRegistry,
  type WorkspaceRootRegistryOptions,
} from '@brainstrike/assistant-service/node-workspace-services';
import { disposeDesktopCommandSessionsForRoot } from '../assistant-server/command-session-manager';
import { evictLspServersForRoot } from '../assistant-server/lsp-diagnostics';

export type {
  SecureWorkspaceRoot,
  StoredWorkspaceRoot,
  SubscribeMountedWorkspaceRoot,
} from '@brainstrike/assistant-service/node-workspace-services';

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
        options.disposeCommandSessionsForRoot ?? disposeDesktopCommandSessionsForRoot,
      evictLspServersForRoot: options.evictLspServersForRoot ?? evictLspServersForRoot,
    });
  }
}
