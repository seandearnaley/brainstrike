import { existsSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type LockProcessIdentity,
  type LockRetirementReceipt,
  processStartTime,
  RootLock,
} from '../../src/lock.js';

interface Command {
  readonly authority?: LockProcessIdentity;
  readonly firstLink?: string;
  readonly id: number;
  readonly op: 'acquire' | 'retire' | 'resume' | 'release' | 'acknowledge' | 'exit';
  readonly proof?: 'ok' | 'reject' | 'pause' | 'missing' | 'false';
  readonly receipt?: LockRetirementReceipt;
}

const [root, legacyPath] = process.argv.slice(2) as [string, string | undefined];
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const originalLink = fs.linkSync;
const Lock = legacyPath
  ? (
      (await import(pathToFileURL(legacyPath).href)) as {
        RootLock: typeof RootLock;
      }
    ).RootLock
  : RootLock;
let lock: RootLock | undefined;
let resume: (() => void) | undefined;
const send = (message: Record<string, unknown>): void => {
  process.send?.(message);
};

async function command(message: Command): Promise<void> {
  try {
    switch (message.op) {
      case 'acquire': {
        if (message.firstLink) {
          const signal = message.firstLink;
          fs.linkSync = (from, to) => {
            originalLink(from, to);
            if (dirname(String(to)) === RootLock.dirOf(root)) {
              writeFileSync(`${signal}.linked`, 'linked');
              while (!existsSync(`${signal}.continue`)) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
              }
            }
          };
          syncBuiltinESMExports();
        }
        try {
          lock = await Lock.acquire(root, {
            ...(message.authority ? { retirementAuthority: message.authority } : {}),
          });
        } finally {
          fs.linkSync = originalLink;
          syncBuiltinESMExports();
        }
        send({
          event: 'acquired',
          gen: lock.gen,
          id: message.id,
          owner: lock.owner,
          receipt: legacyPath ? undefined : lock.retirementReceipt,
        });
        return;
      }
      case 'retire': {
        const proof =
          message.proof === 'missing'
            ? undefined
            : async (): Promise<void> => {
                send({ event: 'proof-started', id: message.id });
                if (message.proof === 'reject') {
                  throw new Error('fixture drainage rejected');
                }
                if (message.proof === 'false') {
                  return false as unknown as undefined;
                }
                if (message.proof === 'pause') {
                  await new Promise<void>((resolve) => {
                    resume = resolve;
                  });
                }
              };
        await RootLock.retire(
          message.receipt as LockRetirementReceipt,
          proof as () => Promise<void>
        );
        break;
      }
      case 'resume':
        resume?.();
        resume = undefined;
        break;
      case 'release':
        lock?.release();
        break;
      case 'acknowledge':
        lock?.acknowledgeRetirement();
        break;
      case 'exit':
        process.exit(0);
    }
    send({ event: 'ok', id: message.id, released: lock?.isReleased });
  } catch (error) {
    send({
      event: 'failed',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'unknown',
      released: lock?.isReleased,
    });
  }
}

process.on('message', (message: Command) => {
  void command(message);
});
process.on('disconnect', () => {
  process.exit(0);
});
send({ event: 'ready', identity: { pid: process.pid, start: processStartTime(process.pid) } });
