// The Node implementation is shared; Desktop retains its existing public surface.
export {
  describeOpenRootTopology,
  getWorkspaceRoots,
  loadWorkspaceRootsFromCatalog,
  type OpenRootTopology,
  resolveOptionalWorkspaceRoot,
  resolveWorkspaceRoot,
  resolveWorkspaceSearchScope,
  type WorkspaceSearchScope,
} from '@brainstrike/assistant-service/node-workspace-services';
