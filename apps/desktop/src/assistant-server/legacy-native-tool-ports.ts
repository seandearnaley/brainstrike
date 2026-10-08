import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import type { HostWorkspaceEditTracker } from '@brainstrike/agent-host';
import type { NativeEditCall, NativeToolPorts } from '@brainstrike/host-capabilities/native-tools';
import { createDesktopCanvasStore } from './canvas-repository';
import {
  beforeStateToCapture,
  captureBeforeState,
  recordEditCheckpointForTool,
} from './edit-checkpoint-capture';
import { getEditDiagnostics } from './lsp-diagnostics';
import {
  triggerEditedFileReindex,
  triggerFileDeletionInvalidation,
  triggerRenamedDestinationReindex,
} from './reindex-side-effects';
import { createDesktopTaskListStore } from './task-list-repository';

/** The journal's normalized workspace path: root-relative, forward slashes, leading slash. */
function journalPath(rootPath: string, absolutePath: string): string {
  return `/${path.relative(rootPath, absolutePath).split(path.sep).join('/')}`;
}

/**
 * Legacy threads' attribution: the PGlite journal row the snapshot-backed
 * undo engine reads. Restores come from the turn-start snapshot, so only the
 * before/after identity is recorded; a rename keeps its no-content capture.
 */
function journalEditTracker(
  runtimeData: RuntimeData | undefined,
  call: NativeEditCall
): HostWorkspaceEditTracker {
  return {
    track: async (edit, mutate) => {
      const before = edit.op === 'rename' ? undefined : await captureBeforeState(edit.absolutePath);
      const result = await mutate();
      const after = edit.op === 'delete' ? undefined : await captureBeforeState(edit.absolutePath);
      await recordEditCheckpointForTool({
        afterExisted: edit.op !== 'delete',
        afterHash: after?.kind === 'present' ? after.hash : null,
        before: before
          ? beforeStateToCapture(before)
          : { beforeExisted: true, beforeHash: null, beforeSize: null, captureStatus: 'rename' },
        executionThreadId: call.executionThreadId,
        ...(edit.fromAbsolutePath
          ? { fromPath: journalPath(edit.rootPath, edit.fromAbsolutePath) }
          : {}),
        op: edit.op,
        path: journalPath(edit.rootPath, edit.absolutePath),
        rootId: edit.rootId,
        runtimeData,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      });
      return result;
    },
  };
}

/** Legacy (Main-executed) threads keep their PGlite journal, index maintenance and stores. */
export function legacyNativeToolPorts(runtimeData: RuntimeData | undefined): NativeToolPorts {
  const memory = runtimeData?.memory;
  const thread =
    memory?.threadId && memory.resourceId
      ? { resourceId: memory.resourceId, threadId: memory.threadId }
      : undefined;
  return {
    canvas: thread ? createDesktopCanvasStore(thread) : undefined,
    fileMutations: {
      diagnostics: (args) => getEditDiagnostics(args),
      edits: (call) => journalEditTracker(runtimeData, call),
      index: {
        deleted: (args) => triggerFileDeletionInvalidation({ ...args, runtimeData }),
        edited: (args) => triggerEditedFileReindex({ ...args, runtimeData }),
        renamed: (args) => triggerRenamedDestinationReindex({ ...args, runtimeData }),
      },
    },
    taskList: thread ? createDesktopTaskListStore(thread) : undefined,
  };
}
