// A `--platform` module for a CLI process whose host's close never ends: the
// close keeps the process's event loop alive, as a child that ignores its ask.
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { HostPlatformFactory } from '../../src/process-entry.ts';

export const createHostPlatform: HostPlatformFactory = () => ({
  close: () =>
    new Promise<void>(() => {
      setInterval(() => undefined, 60_000);
    }),
  maxSteps: 1,
  readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  resolveModel: async () => {
    throw new Error('This platform runs no model');
  },
  tools: {},
});
