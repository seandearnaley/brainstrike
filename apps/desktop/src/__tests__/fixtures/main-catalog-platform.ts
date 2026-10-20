import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostPlatform, HostStartupContext } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { HostStartOptions } from '@brainstrike/host-lease';

export function createHostPlatform(
  options: HostStartOptions,
  context: HostStartupContext
): HostPlatform {
  const original = context.store.workspaceRoots.bind(context.store);
  context.store.workspaceRoots = async (request) => {
    const reply = await original(request);
    if (request.operation === 'register' && existsSync(join(options.root, 'gate-armed'))) {
      // The real canonical writer already committed. Hold only its caller response.
      await writeFile(
        join(options.root, 'register-committed.json'),
        JSON.stringify({ reply, request })
      );
      while (!existsSync(join(options.root, 'gate-released'))) {
        await delay(5);
      }
      if (existsSync(join(options.root, 'gate-rejected'))) {
        throw new Error('Expected rejected catalog ACK');
      }
    }
    return reply;
  };
  const ledger = context.store.worktreeLedger.bind(context.store);
  context.store.worktreeLedger = async (request) => {
    const reply = await ledger(request);
    if (existsSync(join(options.root, 'ledger-armed'))) {
      await writeFile(
        join(options.root, 'register-committed.json'),
        JSON.stringify({ reply, request })
      );
      while (!existsSync(join(options.root, 'gate-released'))) {
        await delay(5);
      }
    }
    return reply;
  };
  return {
    close: async () => undefined,
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => {
      throw new Error('No assistant run is allowed by the catalog control');
    },
    tools: {},
  };
}
