import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type {
  LocalExecutionCapability,
  WebGpuAdapterAvailability,
} from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useState } from 'react';

const logger = createLogger('WebGpuAvailability');
type WebGpuState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly availability: WebGpuAdapterAvailability }
  | { readonly kind: 'failed' };

/** Retry failed detection on the keep-mounted Settings tab's next open (BST-2010). */
export function useWebGpuAvailability(
  localExecution: LocalExecutionCapability | undefined
): WebGpuState {
  const [state, setDetection] = useState<WebGpuState>({ kind: 'unknown' });
  useEffect(() => {
    if (!localExecution) {
      return;
    }
    let current = true;
    let failed = false;
    let pending = false;
    const detect = async (): Promise<void> => {
      if (pending) {
        return;
      }
      pending = true;
      failed = false;
      setDetection({ kind: 'unknown' });
      try {
        const availability = await localExecution.webgpuAdapter();
        if (current) {
          setDetection({ availability, kind: 'known' });
        }
      } catch (error) {
        if (current) {
          failed = true;
          logger.warn('WebGPU detection failed', { error });
          setDetection({ kind: 'failed' });
        }
      } finally {
        pending = false;
      }
    };
    const unsubscribe = usePanelLayoutStore.subscribe((next, previous) => {
      if (next.activeTab === 'settings' && previous.activeTab !== 'settings' && failed) {
        void detect();
      }
    });
    void detect();
    return () => {
      current = false;
      unsubscribe();
    };
  }, [localExecution]);
  return state;
}
