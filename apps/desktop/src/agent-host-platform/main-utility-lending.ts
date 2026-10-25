import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger } from '@brainstrike/logging';
import type { MessagePortMain } from 'electron';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { forkIndexUtility } from '../fork-utility';
import { UTILITY_PORT_EVENT } from '../lent-utility';
import {
  PLATFORM_UTILITY_ERRORED,
  PLATFORM_UTILITY_EXITED,
  PLATFORM_UTILITY_FORK,
  PLATFORM_UTILITY_KILL,
  PLATFORM_UTILITY_SPAWNED,
  PlatformUtilityForkSchema,
  PlatformUtilitySchema,
} from './utility-lending-wire';

const logger = createLogger('MainUtilityLending');
const decodeFork = wireDecoder(PlatformUtilityForkSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});
const decodeUtility = wireDecoder(PlatformUtilitySchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

interface LentChild {
  readonly child: { kill(): boolean };
  readonly exited: Promise<void>;
}

/**
 * ADR-0030 decision 1: Main forks the agent host's index utilities, transfers each one's channel
 * end to the host on its platform port, and joins each exit. When the host's connection closes,
 * Main ends the utilities it lent it.
 */
export function serveUtilityLending(
  connection: MessageConnection,
  platformPort: Pick<MessagePortMain, 'postMessage'>,
  fork: typeof forkIndexUtility
): { close(): Promise<void> } {
  const live = new Map<string, LentChild>();
  const notify = (method: string, params: unknown): void => {
    connection.sendNotification(method, params).catch((cause: unknown) => {
      logger.warn('The agent host did not receive a utility report', { cause, method });
    });
  };
  connection.onRequest(PLATFORM_UTILITY_FORK, (input: unknown): null => {
    const { env, kind, utilityId } = decodeFork(input);
    if (live.has(utilityId)) {
      throw new Error('The utility id is already lent');
    }
    const exit = Promise.withResolvers<void>();
    const { child, ownerPort } = fork(kind, env, {
      errored: (type, location, report) =>
        notify(PLATFORM_UTILITY_ERRORED, { location, report, type, utilityId }),
      exited: (code) => {
        live.delete(utilityId);
        exit.resolve();
        notify(PLATFORM_UTILITY_EXITED, { code, utilityId });
      },
      spawned: (pid) => notify(PLATFORM_UTILITY_SPAWNED, { pid: pid ?? null, utilityId }),
    });
    live.set(utilityId, { child, exited: exit.promise });
    // On the same port as the reply, so the host holds the channel before it learns of the fork.
    platformPort.postMessage({ event: UTILITY_PORT_EVENT, utilityId }, [ownerPort]);
    return null;
  });
  connection.onRequest(PLATFORM_UTILITY_KILL, (input: unknown): null => {
    live.get(decodeUtility(input).utilityId)?.child.kill();
    return null;
  });
  const close = async (): Promise<void> => {
    const exits = [...live.values()].map(({ child, exited }) => {
      child.kill();
      return exited;
    });
    await Promise.all(exits);
  };
  connection.onClose(() => {
    close().catch((cause: unknown) => {
      logger.error('Main could not end the utilities lent to a closed host', { cause });
    });
  });
  return { close };
}
