import type { ContentClearResult } from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, rawChannel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

export const contentClearContract = {
  clear: rawChannel<['CONFIRM_CLEAR_DATABASE'], ContentClearResult>({
    channel: DESKTOP_IPC_CHANNELS.db.clearAll,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'content clear');
      if (raw[0] !== 'CONFIRM_CLEAR_DATABASE') {
        throw new Error('Content clear requires confirmation');
      }
      return ['CONFIRM_CLEAR_DATABASE'];
    },
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;
