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
  resolveFocusedWorkspaceRoot,
  resolveOptionalWorkspaceRoot,
  resolveWorkspaceRoot,
  type WorkspaceRootsQueryable,
} from '@brainstrike/assistant-service/node-workspace-services';
