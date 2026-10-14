import type { PromptLibraryCapability } from '@brainstrike/types/prompt-item';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type AssertTrue, type BridgeMatches, channel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';
import { parsePromptLibraryRequest } from './prompt-library-args';
export const promptLibraryContract = {
  request: channel<
    Parameters<PromptLibraryCapability['request']>,
    Awaited<ReturnType<PromptLibraryCapability['request']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.promptLibrary.request,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'Prompt Library');
      return [parsePromptLibraryRequest(raw[0])];
    },
    roles: ['visible-ui'],
  }),
};
export type PromptLibraryBridgeProof = AssertTrue<
  BridgeMatches<typeof promptLibraryContract, PromptLibraryCapability>
>;
