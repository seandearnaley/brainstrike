import type { ThreadCatalogRoot, ThreadGroupsReply, ThreadGroupsRequest } from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { parseThreadGroupsRequest } from './thread-groups-args';

export { parseThreadGroupsRequest } from './thread-groups-args';

import { channel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

export const threadGroupsContract = {
  readRoots: channel<[], readonly ThreadCatalogRoot[]>({
    channel: DESKTOP_IPC_CHANNELS.threadGroups.readRoots,
    parseArgs: (raw) => {
      assertArgCount(raw, 0, 'Thread root catalog');
      return [];
    },
    roles: ['visible-ui'],
  }),
  request: channel<[ThreadGroupsRequest], ThreadGroupsReply>({
    channel: DESKTOP_IPC_CHANNELS.threadGroups.request,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'Thread groups');
      return [parseThreadGroupsRequest(raw[0])];
    },
    roles: ['visible-ui'],
  }),
};
