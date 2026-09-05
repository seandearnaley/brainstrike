/**
 * `userPersonas` IPC contract (BST-1648): the Settings → Subagents panel's
 * persona discovery, exposed as `window.assistantPersonas`. The shared
 * `AssistantPersonasBridge` interface in @brainstrike/assistant-contract is
 * what settings-ui consumes; the derived bridge is pinned equal to it below.
 * PURE — bundled into the preload and imported by main.
 */
import type { AssistantPersonasListResult } from '@brainstrike/assistant-contract';
import type { AssistantPersonasBridge } from '@brainstrike/assistant-contract/personas-bridge';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
  parseNoArgs,
} from '../platform/ipc-contract';

export const userPersonasContract = {
  list: channel<[], AssistantPersonasListResult>({
    channel: DESKTOP_IPC_CHANNELS.userPersonas.list,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
} satisfies Contract;

export type UserPersonasBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof userPersonasContract, AssistantPersonasBridge>
>;
