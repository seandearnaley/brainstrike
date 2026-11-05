import type { ThreadCatalogRoot, ThreadGroupsReply, ThreadGroupsRequest } from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { channel } from '../platform/ipc-contract';

export const threadGroupsContract = {
  readRoots: channel<[], readonly ThreadCatalogRoot[]>({
    channel: DESKTOP_IPC_CHANNELS.threadGroups.readRoots,
  }),
  request: channel<[ThreadGroupsRequest], ThreadGroupsReply>({
    channel: DESKTOP_IPC_CHANNELS.threadGroups.request,
  }),
};
