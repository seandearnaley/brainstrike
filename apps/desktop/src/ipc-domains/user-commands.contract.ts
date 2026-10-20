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

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type UserCommandsBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof userCommandsContract, UserCommandsBridge>
>;
