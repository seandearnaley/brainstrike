import type { HostPlatform } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';

/** A platform whose close never settles, like a child process that ignores every ask. */
export function createHostPlatform(): HostPlatform {
  return {
    close: () => new Promise<void>(() => undefined),
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => {
      throw new Error('No model on this platform');
    },
    tools: {},
  };
}
