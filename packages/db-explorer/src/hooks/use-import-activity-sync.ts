import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';

/**
 * Reads the canonical import activity maintained by the enhanced import service.
 * Keeping this subscription behind the panel seam avoids mirroring live state
 * through an effect and an additional render.
 */
export function useImportActivitySync(): boolean {
  return useVectorStatusUIStore((state) => state.isImporting);
}
