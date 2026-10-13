// The Node implementation is shared; Desktop retains its existing public surface.
export {
  BoundWorkspaceRootUnavailableError,
  describeOpenRootTopology,
  enrichRuntimeDataWithWorkspaceRoots,
  getWorkspaceRoots,
  loadWorkspaceRootsFromDatabase,
  markRootDisconnectedByPath,
  markRootsDisconnectedExcept,
  type OpenRootTopology,
  orderWorkspaceRoots,
  RootNotInThreadError,
  resolveFocusedWorkspaceRoot,
  resolveOptionalWorkspaceRoot,
  resolveWorkspaceRoot,
  resolveWorkspaceSearchScope,
  type WorkspaceRootsQueryable,
  type WorkspaceSearchScope,
} from '@brainstrike/assistant-service/node-workspace-services';
