/**
 * What a project section of the Threads panel can do (ADR-0034 build decisions): name its
 * project, move its folder into another project the panel lists, and locate a folder that moved.
 * Each change goes to the host's root registry, the one writer, and the panel reads the folder
 * rows again once it committed (`notifyRootRecordsChanged`), so the sections regroup.
 *
 * Joining is the person's, from a list of the projects shown: nothing joins folders by a remote
 * URL or a commit, and a joined folder keeps its own trust and approved hooks.
 */
import {
  describeBoundaryFailure,
  isBoundaryFailureError,
} from '@brainstrike/assistant-contract/boundary-failure';
import { type ThreadListView, threadFolderSectionLabel } from '@brainstrike/assistant-data';
import { createContext, useContext, useState } from 'react';
import type { AssistantHostProjects, ThreadProjectFolder } from './assistant-thread-host-context';
import { notifyRootRecordsChanged } from './roots/root-registration-events';

/** A project the panel lists, by the name its section shows. */
export interface ThreadProjectChoice {
  readonly label: string;
  readonly projectId: string;
}

/** Each change resolves true once it committed, and false when it was refused (the panel says why). */
export interface ThreadProjectActions {
  /** Clears the refusal shown, once the form it answered is closed. */
  readonly dismiss: () => void;
  readonly join: (folder: ThreadProjectFolder, projectId: string) => Promise<boolean>;
  /** Every project the panel lists now, in its order. */
  readonly listed: readonly ThreadProjectChoice[];
  /** Null where a located folder could not be shown in the Explorer (no mount by path). */
  readonly locate: ((rootId: string) => Promise<boolean>) | null;
  readonly rename: (projectId: string, name: string) => Promise<boolean>;
}

export const ThreadProjectActionsContext = createContext<ThreadProjectActions | null>(null);

/** The panel's project actions; null outside project grouping or where the host has none. */
export function useThreadProjectActions(): ThreadProjectActions | null {
  return useContext(ThreadProjectActionsContext);
}

function describeFailure(error: unknown): string {
  if (isBoundaryFailureError(error)) {
    return describeBoundaryFailure(error.failure);
  }
  return error instanceof Error ? error.message : String(error);
}

/** The projects a project grouping lists, once each, in section order. */
function listedProjects(view: ThreadListView): ThreadProjectChoice[] {
  if (view.kind !== 'folders') {
    return [];
  }
  const listed: ThreadProjectChoice[] = [];
  for (const { header } of view.sections) {
    // Scratch and No project are no project, so nothing moves into them.
    if (header.kind === 'unassigned' || header.kind === 'scratch') {
      continue;
    }
    const projectId =
      header.kind === 'repository' ? header.repository.projectId : header.folder.projectId;
    if (projectId !== null && !listed.some((choice) => choice.projectId === projectId)) {
      listed.push({ label: threadFolderSectionLabel(header), projectId });
    }
  }
  return listed;
}

/**
 * The project actions for the panel's view, and the latest refusal to show. `showFolder` mounts
 * a located folder in the Explorer by its path, as reopening a recorded folder does.
 */
export function usePanelProjectActions({
  projects,
  showFolder,
  view,
}: {
  readonly projects: AssistantHostProjects | undefined;
  readonly showFolder: ((path: string) => Promise<unknown>) | undefined;
  readonly view: ThreadListView;
}): { readonly actions: ThreadProjectActions | null; readonly error: string | null } {
  const [error, setError] = useState<string | null>(null);
  if (!projects || view.kind !== 'folders') {
    // A refusal answered a project action: it goes with Project grouping, and does not come back.
    if (error !== null) {
      setError(null);
    }
    return { actions: null, error: null };
  }
  const settle = async (change: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await change();
      return true;
    } catch (cause) {
      setError(describeFailure(cause));
      return false;
    } finally {
      // Read the records again whatever happened: Locate commits the relink before the Explorer
      // is asked to show the folder, and that second step can fail on its own.
      notifyRootRecordsChanged();
    }
  };
  return {
    actions: {
      dismiss: () => setError(null),
      join: (folder, projectId) => settle(() => projects.join(folder, projectId)),
      listed: listedProjects(view),
      locate: showFolder
        ? (rootId) =>
            settle(async () => {
              const located = await projects.locate(rootId);
              if (located) {
                await showFolder(located.path);
              }
            })
        : null,
      rename: (projectId, name) => settle(() => projects.rename(projectId, name)),
    },
    error,
  };
}
