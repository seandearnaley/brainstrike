/**
 * BST-2534: a project's Memory panel, which the host's root registry serves with the project's
 * other requests. The person lists, writes and deletes the project's notes through the one
 * writer, `ProjectMemoryNotes`, whether or not the project's folder is trusted: ADR-0032 decides
 * what a run loads, never what the person may read. A project the store no longer has is
 * refused, so its folder is never made again.
 */
import type { HostRootRegistry } from '@brainstrike/agent-host';
import { refusalError, ToolInputError } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { ProjectMemoryNotes, ProjectMemoryRefusal } from './memory-notes.ts';

export type ProjectMemoryPanel = Pick<
  HostRootRegistry,
  'projects/memory/delete' | 'projects/memory/list' | 'projects/memory/write'
>;

/** The refusals the notes give the model, as the person's refusals: their words, typed. */
async function refusedAsTyped<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (cause) {
    if (cause instanceof ProjectMemoryRefusal) {
      const { reason } = cause.refusal;
      throw refusalError(
        'input',
        'memory.secret',
        `Not saved: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`
      );
    }
    if (cause instanceof ToolInputError) {
      throw refusalError('input', 'memory.refused', cause.message.replace(/^Error: /u, ''));
    }
    throw cause;
  }
}

export function projectMemoryPanel(
  store: Pick<StateStore, 'root' | 'workspaceRoots'>
): ProjectMemoryPanel {
  const notesOf = async (projectId: string): Promise<ProjectMemoryNotes> => {
    const { projects = [] } = await store.workspaceRoots({
      operation: 'project-folders',
      projectId,
    });
    if (projects.length === 0) {
      throw refusalError(
        'conflict',
        'memory.project-gone',
        'This project no longer exists, so its memory was not read or changed.'
      );
    }
    return await ProjectMemoryNotes.open(store.root, projectId);
  };
  return {
    'projects/memory/delete': ({ path, projectId }) =>
      refusedAsTyped(async () => {
        const notes = await notesOf(projectId);
        await notes.execute({ command: 'delete', path }, { untrusted: false });
        return null;
      }),
    'projects/memory/list': ({ projectId }) =>
      refusedAsTyped(async () => ({ notes: await (await notesOf(projectId)).list() })),
    'projects/memory/write': ({ path, projectId, text }) =>
      refusedAsTyped(async () => await (await notesOf(projectId)).save({ path, text })),
  };
}
