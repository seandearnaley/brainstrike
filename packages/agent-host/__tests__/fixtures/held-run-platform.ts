// A `--platform` module for a CLI process whose run's owner never closes: its
// close keeps the process's event loop alive, as memory that ignores its ask.
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { HostPlatformFactory } from '../../src/process-entry.ts';
import { scriptedModel } from '../../src/test-fixtures/scripted-model.ts';

export const createHostPlatform: HostPlatformFactory = () => ({
  close: async () => undefined,
  maxSteps: 1,
  openRun: async () => ({
    close: () =>
      new Promise<void>(() => {
        setInterval(() => undefined, 60_000);
      }),
  }),
  readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  resolveModel: async () => scriptedModel(),
  tools: {},
});
