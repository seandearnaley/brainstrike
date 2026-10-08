import type { FindWorkspaceSymbolInput, RuntimeData } from '@brainstrike/agent';
import { resolveWorkspaceRoot } from '@brainstrike/assistant-service/node-workspace-services';
import { findSymbolMatches } from './find-workspace-symbol.js';
import { readWorkspaceTextFile } from './workspace-text-file-reader.js';

/** findWorkspaceSymbol: a bounded textual symbol scan of one file through the checked reader. */
export async function runFindWorkspaceSymbol(
  input: FindWorkspaceSymbolInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  rootName: string;
  path: string;
  totalMatches: number;
  truncated: boolean;
  matches: ReturnType<typeof findSymbolMatches>['matches'];
}> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Route through the checked reader so the same guards apply (isFile, 2 MB size
  // cap, NUL-byte binary probe). Symbol scanning returns only a tiny bounded
  // result, so a multi-MB bundle or binary file must error cleanly rather than
  // be loaded and scanned in full on the main process.
  const file = await readWorkspaceTextFile({ requestedPath: input.path, rootPath: root.path });
  const { matches, totalMatches, truncated } = findSymbolMatches(file.content, input.query, {
    contextLines: input.contextLines ?? 2,
    maxMatches: input.maxMatches ?? 5,
  });
  return { matches, path: file.path, rootName: root.displayName, totalMatches, truncated };
}
