/**
 * The desktop `brainstrike.stringReplaceWorkspaceFile` tool's REAL execute
 * against a REAL temp-dir workspace: its real fuzzy-match cascade, its real
 * path containment, and the per-path failure-streak escalation.
 *
 * No loop is involved, and none is needed — every claim here is about the
 * tool's own behaviour across repeated calls. That a real loop advertises this
 * tool and dispatches a model call to this execute is proven once, on the
 * production host path, by
 * `src/__tests__/host-live-native-tools.integration.test.ts`.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import {
  EDIT_FAILURE_HINT_MESSAGE,
  resetToolCallLoopGuards,
} from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import { requireToolExecute, singleRootRuntime } from './_tool-test-helpers';

beforeEach(() => {
  resetToolCallLoopGuards();
});

describe('stringReplaceWorkspaceFile (real tool execute)', () => {
  it('escalates the third same-path match failure and resets after success', async () => {
    const workspaceRootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-sr-guard-')
    );
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'config.txt'),
      'enabled=true\n',
      'utf8'
    );

    try {
      const tools = buildHostNativeTools({
        ...singleRootRuntime(workspaceRootPath),
        memory: { resourceId: 'edit-failure-resource', threadId: 'edit-failure-thread' },
      } as RuntimeData);
      const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');
      const missingInput = {
        context: {
          newStr: 'missing=true',
          oldStr: 'missing=false',
          path: '/config.txt',
        },
      };

      await expect(executeTool(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining('Repeated string replacement failures'),
        reason: 'not_found',
      });
      await expect(executeTool(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining('Repeated string replacement failures'),
        reason: 'not_found',
      });
      await expect(
        executeTool({
          context: {
            newStr: 'enabled=true',
            oldStr: 'enabled=true',
            path: '/config.txt',
          },
        })
      ).rejects.toMatchObject({ reason: 'no_op' });
      // The escalated message APPENDS the hint rather than replacing the
      // fuzzy matcher's own diagnostic (PR #2323 review) — the model must
      // still see the specific "no match" detail alongside the recovery
      // guidance, not lose it at the exact moment it has the least ability
      // to guess why oldStr keeps failing.
      let escalatedError: unknown;
      try {
        await executeTool(missingInput);
        throw new Error('expected the third failure to reject');
      } catch (error) {
        escalatedError = error;
      }
      expect(escalatedError).toMatchObject({ reason: 'not_found' });
      expect((escalatedError as Error).message).toContain('No sufficiently close match');
      expect((escalatedError as Error).message).toContain(EDIT_FAILURE_HINT_MESSAGE);

      await executeTool({
        context: {
          newStr: 'enabled=false',
          oldStr: 'enabled=true',
          path: '/config.txt',
        },
      });
      await expect(executeTool(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining('Repeated string replacement failures'),
        reason: 'not_found',
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('resets the failure streak after a successful writeWorkspaceFile to the same path', async () => {
    // Regression for PR #2323 review (claude): a full rewrite via
    // writeWorkspaceFile is the very recovery the escalated hint recommends
    // ("use writeWorkspaceFile when the intended change requires a full
    // rewrite") — it must clear stringReplace's failure streak on that path
    // too, or the NEXT unrelated miss still gets the escalated message even
    // though the model just took the suggested action.
    const workspaceRootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-sr-write-reset-')
    );
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'config.txt'),
      'enabled=true\n',
      'utf8'
    );

    try {
      const tools = buildHostNativeTools({
        ...singleRootRuntime(workspaceRootPath),
        memory: {
          resourceId: 'edit-failure-write-resource',
          threadId: 'edit-failure-write-thread',
        },
      } as RuntimeData);
      const executeReplace = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');
      const executeWrite = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      const missingInput = {
        context: {
          newStr: 'missing=true',
          oldStr: 'missing=false',
          path: '/config.txt',
        },
      };

      await expect(executeReplace(missingInput)).rejects.toMatchObject({ reason: 'not_found' });
      await expect(executeReplace(missingInput)).rejects.toMatchObject({ reason: 'not_found' });

      await executeWrite({
        context: { content: 'enabled=false\nother=1\n', path: '/config.txt' },
      });

      await expect(executeReplace(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining(EDIT_FAILURE_HINT_MESSAGE),
        reason: 'not_found',
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });
});
