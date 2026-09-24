/** Pure contract for the desktop forge bridge. */
import type { ForgeBridge } from '@brainstrike/app-shell/forge/availability';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  pushEvent,
  rawChannel,
} from '../platform/ipc-contract';
import { assertArgCount, assertSupportedKeys, parseRecord } from './contract-args';

type InvokeArgs<K extends keyof ForgeBridge> = Parameters<ForgeBridge[K]>;
type InvokeResult<K extends keyof ForgeBridge> = Awaited<ReturnType<ForgeBridge[K]>>;

function parseRoot(operation: 'identity' | 'prStatus'): (raw: readonly unknown[]) => [string] {
  return (raw) => {
    assertArgCount(raw, 1, `forge ${operation}`);
    if (typeof raw[0] !== 'string') {
      throw new Error(`forge ${operation} rootId must be a string`);
    }
    return [raw[0]];
  };
}

export const forgeContract = {
  identity: rawChannel<InvokeArgs<'identity'>, InvokeResult<'identity'>>({
    channel: DESKTOP_IPC_CHANNELS.forge.identity,
    parseArgs: parseRoot('identity'),
    roles: ['visible-ui'],
  }),
  onPrUpdated: pushEvent<Parameters<Parameters<ForgeBridge['onPrUpdated']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.forge.prUpdated,
  }),
  prStatus: rawChannel<InvokeArgs<'prStatus'>, InvokeResult<'prStatus'>>({
    channel: DESKTOP_IPC_CHANNELS.forge.prStatus,
    parseArgs: parseRoot('prStatus'),
    roles: ['visible-ui'],
  }),
  refresh: rawChannel<InvokeArgs<'refresh'>, InvokeResult<'refresh'>>({
    channel: DESKTOP_IPC_CHANNELS.forge.refresh,
    parseArgs: (raw) => {
      assertArgCount(raw, 2, 'forge refresh');
      if (typeof raw[0] !== 'string') {
        throw new Error('forge refresh rootId must be a string');
      }
      const params = parseRecord(raw[1], 'forge refresh params');
      assertSupportedKeys(params, ['reason'], 'forge refresh');
      const reason = params['reason'];
      if (reason !== 'invalidation' && reason !== 'user' && reason !== 'window') {
        throw new Error('forge refresh reason must be "invalidation", "user", or "window"');
      }
      return [raw[0], { reason }];
    },
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type ForgeBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof forgeContract, ForgeBridge>
>;
