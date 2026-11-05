import { appendFileSync } from 'node:fs';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { z } from 'zod';
import type { HostPlatform } from '../../src/ports.ts';
import { scriptedToolSequence } from '../../src/test-fixtures/scripted-model.ts';

/** The one gated action of the approval crash sweep: it appends one line to `effectFile`. */
export const APPEND_LINE_TOOL = 'append_line';

/**
 * The crash host's `killAt` that dies inside the effect: after the tool's line is written and
 * before `effect.finished` commits, the window no commit boundary reaches.
 */
export const KILL_INSIDE_EFFECT = -2;

/**
 * The host the sweep kills and the host that reopens its root: one run whose
 * scripted model calls the edit-risk tool once, so the default policy asks
 * before it runs, then answers. Both processes build it from the same file.
 */
export function approvalCrashPlatform(
  effectFile: string,
  options: { readonly dieAfterEffect?: boolean } = {}
): HostPlatform {
  return {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () =>
      scriptedToolSequence([{ input: { line: 'approved effect' }, toolId: APPEND_LINE_TOOL }]),
    tools: {
      [APPEND_LINE_TOOL]: {
        description: 'Append one line to the side-effect file',
        execute: async (input) => {
          appendFileSync(effectFile, `${(input as { line: string }).line}\n`);
          if (options.dieAfterEffect) {
            process.kill(process.pid, 'SIGKILL');
          }
          return { appended: true };
        },
        identity: 'append-line-generation-1',
        inputSchema: z.object({ line: z.string() }),
        risk: 'edit',
      },
    },
  };
}
