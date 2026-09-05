/**
 * `userCommands` IPC contract (BST-1648): user-defined slash command
 * discovery for the composer's "/" menu (`window.userCommands`). Pinned
 * equal to app-shell's `UserCommandsBridge` below. PURE — bundled into the
 * preload and imported by main.
 */
import type { UserCommandsBridge } from '@brainstrike/app-shell/user-commands-bridge';
import type { UserSlashCommandsListResult } from '@brainstrike/assistant-contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
  parseNoArgs,
} from '../platform/ipc-contract';

export const userCommandsContract = {
  list: channel<[], UserSlashCommandsListResult>({
    channel: DESKTOP_IPC_CHANNELS.userCommands.list,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
} satisfies Contract;

export type UserCommandsBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof userCommandsContract, UserCommandsBridge>
>;
