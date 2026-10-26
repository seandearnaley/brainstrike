// A `--platform` module whose close waits until the test releases it: a host
// whose release never ends on its own, as a child that ignores its ask.
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { HostPlatformFactory } from '../../src/process-entry.js';
import { scriptedModel } from './scripted-model.js';

let held = Promise.withResolvers<void>();

/** The next platform's close settles only when the returned release resolves. */
export function holdPlatformClose(): PromiseWithResolvers<void> {
  held = Promise.withResolvers<void>();
  return held;
}

export const createHostPlatform: HostPlatformFactory = () => {
  const { promise } = held;
  return {
    close: () => promise,
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => scriptedModel(),
    tools: {},
  };
};
