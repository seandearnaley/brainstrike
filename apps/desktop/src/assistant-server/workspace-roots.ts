// The Node implementation is shared; Desktop retains its existing public surface.
export {
  BoundWorkspaceRootUnavailableError,
  describeOpenRootTopology,
  enrichRuntimeDataWithWorkspaceRoots,
  getWorkspaceRoots,
  loadWorkspaceRootsFromCatalog,
  loadWorkspaceRootsFromDatabase,
  markRootDisconnectedByPath,
  markRootsDisconnectedExcept,
  type OpenRootTopology,
  orderWorkspaceRoots,
  RootNotInThreadError,
  resolveOptionalWorkspaceRoot,
  resolveWorkspaceRoot,
  resolveWorkspaceSearchScope,
  type WorkspaceRootsQueryable,
  type WorkspaceSearchScope,
} from '@brainstrike/assistant-service/node-workspace-services';
