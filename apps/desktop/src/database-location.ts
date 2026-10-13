import path from 'node:path';
import type { DatabaseLocation } from '@brainstrike/assistant-service/node-workspace-services';

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

/** Profile-owned UI state is a sibling of the host root: its reset lease must
 * never recursively remove Chromium's live, Session-owned container. */
export function resolveDevelopmentUserDataPath(location: DatabaseLocation): string {
  return path.join(location.rootPath, 'desktop', 'profiles', location.profile);
}
