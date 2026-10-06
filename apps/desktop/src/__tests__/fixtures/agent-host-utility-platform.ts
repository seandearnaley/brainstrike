import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostPlatform, HostStartupContext } from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { HostStartOptions } from '@brainstrike/host-lease';
import { z } from 'zod';

/** Only the model is scripted; the utility kernel, permission, filesystem and writer are real. */
export function createHostPlatform(
  options: HostStartOptions,
  context: HostStartupContext
): HostPlatform {
  const model = scriptedToolSequence([
    { input: { text: 'permitted utility effect' }, toolId: 'write_file' },
  ]);
  return {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      write_file: {
        description: 'Write the owned utility proof file',
        execute: async (input) => {
          if (context.store.root !== options.root) {
            throw new Error('Utility platform did not borrow its canonical root writer');
          }
          const { text } = z.object({ text: z.string() }).parse(input);
          await writeFile(join(options.root, 'utility-permitted.txt'), text);
          return { wrote: true };
        },
        identity: 'owned-native-file-action',
        inputSchema: z.object({ text: z.string() }),
        risk: 'edit',
      },
    },
  };
}
