/**
 * BST-2018 (ADR-0021): a run's `@file` mentions, placed by the thread's
 * binding. A mention in a thread folder is read as before. A mention in a
 * live workspace folder outside the thread is attached for this run only:
 * the run reads exactly the mentioned files of that folder, each while the
 * folder is still live, and no folder is granted to the thread.
 */
import type { RuntimeData } from '@brainstrike/agent';
import { parseFileMentionDirectives } from '@brainstrike/agent';
import { refusalError } from '@brainstrike/assistant-contract';
import type { WorkspaceFileReader } from '@brainstrike/assistant-service/ports';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/workspace-text-file-reader';

type RuntimeWorkspaceRoot = NonNullable<RuntimeData['workspaceRoots']>[number];

export interface DesktopMentionedFiles {
  /** The mentioned folder-relative paths in each attached folder, by rootId. */
  readonly attachedPaths: ReadonlyMap<string, ReadonlySet<string>>;
  /** Live workspace folders outside the thread that the run's mentions name. */
  readonly attachedRoots: readonly RuntimeWorkspaceRoot[];
}

function normalizedPath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.?\/+/u, '');
}

export function placeMentionedFiles(
  prompt: string,
  threadRoots: readonly RuntimeWorkspaceRoot[],
  liveRoots: readonly RuntimeWorkspaceRoot[]
): DesktopMentionedFiles {
  const attachedPaths = new Map<string, Set<string>>();
  const attachedRoots: RuntimeWorkspaceRoot[] = [];
  for (const mention of parseFileMentionDirectives(prompt)) {
    if (threadRoots.some((root) => root.rootId === mention.rootId)) {
      continue;
    }
    const live = liveRoots.find((root) => root.rootId === mention.rootId);
    if (!live) {
      continue;
    }
    let paths = attachedPaths.get(live.rootId);
    if (!paths) {
      paths = new Set();
      attachedPaths.set(live.rootId, paths);
      attachedRoots.push(live);
    }
    paths.add(normalizedPath(mention.path));
  }
  return { attachedPaths, attachedRoots };
}

/**
 * Reads one attached file: only a mentioned path of an attached folder, and
 * only while that folder is still a live workspace folder at the same path,
 * checked before and after the read.
 */
export function attachedMentionReader(
  mentioned: DesktopMentionedFiles,
  liveRoots: () => Promise<readonly RuntimeWorkspaceRoot[]>,
  signal: AbortSignal
): WorkspaceFileReader {
  const stillLive = async (root: RuntimeWorkspaceRoot): Promise<void> => {
    signal.throwIfAborted();
    const current = await liveRoots();
    signal.throwIfAborted();
    if (!current.some((live) => live.rootId === root.rootId && live.path === root.path)) {
      throw refusalError(
        'availability',
        'workspace.root-unavailable',
        "The file's workspace folder is no longer open.",
        'Re-add the folder and send the message again.'
      );
    }
  };
  return async (args) => {
    const root = mentioned.attachedRoots.find((candidate) => candidate.path === args.rootPath);
    const paths = root ? mentioned.attachedPaths.get(root.rootId) : undefined;
    if (!(root && paths?.has(normalizedPath(args.requestedPath)))) {
      throw refusalError(
        'authorization',
        'workspace.root-not-admitted',
        'This folder is outside the thread workspace.',
        'Mention the file, or add its folder to this thread.'
      );
    }
    await stillLive(root);
    const result = await readWorkspaceTextFile(args);
    await stillLive(root);
    return result;
  };
}
