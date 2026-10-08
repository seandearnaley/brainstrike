// The Node implementation is shared; Desktop retains its existing public surface.
export {
  createWorktreeScopedProfile,
  type DatabaseLocation,
  type DatabaseLocationInput,
  type DatabaseLocationSource,
  type GitProfileContext,
  joinProfileDirectory,
  PACKAGED_PRODUCT_DIR_NAME,
  resolveDatabaseLocation,
  sanitizeProfileSegment,
} from '@brainstrike/assistant-service/node-workspace-services';
