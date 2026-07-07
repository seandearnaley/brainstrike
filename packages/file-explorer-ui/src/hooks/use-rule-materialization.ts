/**
 * useRuleMaterialization
 *
 * Hook that materializes selection rules against the file tree.
 * When in 'rules' mode with a valid ruleSetJson, this hook:
 * 1. Parses the rules and creates a SelectionRuleEngine
 * 2. Builds a TreeAdapter from the current file tree
 * 3. Evaluates the rules and stores materialized paths
 *
 * This enables automatic re-indexing when rules change.
 */

import {
  createSelectionRuleEngine,
  deserializeRuleSet,
  type TreeAdapter,
} from '@brainstrike/selection-rules';
import type { IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useMemo, useRef } from 'react';
import { useFileExplorerStoreSelector } from '../shell/file-explorer-provider';

const logger = createLogger('useRuleMaterialization');
const SLASH_CODE = '/'.charCodeAt(0);

function isEqualOrDescendantPath(path: string, root: string): boolean {
  return (
    path === root ||
    (path.length > root.length &&
      path.charCodeAt(root.length) === SLASH_CODE &&
      path.startsWith(root))
  );
}

function exceedsRelativeDepth(relativePath: string, maxDepth: number): boolean {
  let depth = 0;
  for (let index = 0; index < relativePath.length; index += 1) {
    if (relativePath.charCodeAt(index) !== SLASH_CODE) {
      continue;
    }
    depth += 1;
    if (depth > maxDepth) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates rules and returns the matched paths, or null on failure.
 */
function evaluateRules(
  ruleSetJson: string,
  treeAdapter: TreeAdapter
): {
  paths: Set<string>;
  warnings: Array<{ message: string; code: string; ruleId?: string }>;
} | null {
  try {
    const ruleSet = deserializeRuleSet(ruleSetJson);
    const engine = createSelectionRuleEngine(ruleSet);
    const result = engine.materialize(treeAdapter);

    logger.info('Rules evaluated', {
      appliedRules: result.appliedRules,
      capped: result.capped,
      matchedCount: result.paths.size,
      warnings: result.warnings.length,
    });

    return { paths: result.paths, warnings: result.warnings };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Rule evaluation failed', { error: err.message });
    return null;
  }
}

/**
 * Creates a TreeAdapter from IFileNode tree structure.
 */
function createTreeAdapterFromNodes(nodes: IFileNode[]): TreeAdapter {
  const allFilePaths = new Set<string>();
  const allDirectoryPaths = new Set<string>();

  function collectPaths(nodeList: IFileNode[]): void {
    for (const node of nodeList) {
      if (node.type === 'file') {
        allFilePaths.add(node.path);
      } else if (node.type === 'directory') {
        allDirectoryPaths.add(node.path);
        if (node.children) {
          collectPaths(node.children);
        }
      }
    }
  }

  collectPaths(nodes);

  return {
    getAllFilePaths(): Iterable<string> {
      return allFilePaths;
    },

    getFilesUnderRoot(root: string, maxDepth?: number): Iterable<string> {
      const result: string[] = [];
      const normalizedRoot = root.replace(/\/$/, '');

      for (const path of allFilePaths) {
        // Root rules run over every file path; avoid allocating `${root}/` and
        // stop depth scans as soon as the rule boundary is exceeded.
        if (isEqualOrDescendantPath(path, normalizedRoot)) {
          if (maxDepth !== undefined) {
            const relativePath = path.slice(normalizedRoot.length + 1);
            if (exceedsRelativeDepth(relativePath, maxDepth)) {
              continue;
            }
          }
          result.push(path);
        }
      }

      return result;
    },

    getTotalFileCount(): number {
      return allFilePaths.size;
    },

    pathExists(path: string): boolean {
      return allFilePaths.has(path) || allDirectoryPaths.has(path);
    },
  };
}

export interface UseRuleMaterializationProps {
  /** Whether materialization is enabled (can be disabled during loading) */
  enabled?: boolean;
  /** The file tree to evaluate rules against */
  fileTree: IFileNode[];
}

export interface UseRuleMaterializationReturn {
  /** Error from rule evaluation, if any */
  evaluationError: Error | null;
  /** Whether rules are currently being evaluated */
  isEvaluating: boolean;
  /** Number of files matched by current rules */
  matchedCount: number;
}

/**
 * Hook that materializes selection rules against the file tree.
 *
 * When the selection mode is 'rules' and ruleSetJson is defined,
 * this hook evaluates the rules and stores the matched paths.
 */
export function useRuleMaterialization({
  fileTree,
  enabled = true,
}: UseRuleMaterializationProps): UseRuleMaterializationReturn {
  // Use separate selectors to avoid array reference instability with useSyncExternalStore
  const selectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);
  const setMaterializedPaths = useFileExplorerStoreSelector((s) => s.setMaterializedPaths);

  const isEvaluatingRef = useRef(false);
  const evaluationErrorRef = useRef<Error | null>(null);

  // Memoize tree adapter to avoid recreating on every render
  const treeAdapter = useMemo(() => {
    if (fileTree.length === 0) {
      return null;
    }
    return createTreeAdapterFromNodes(fileTree);
  }, [fileTree]);

  // Evaluate rules when mode is 'rules' and ruleSetJson changes
  useEffect(() => {
    // Guard: skip evaluation when disabled or not in rules mode
    const shouldEvaluate = enabled && selectionModel.mode === 'rules';
    if (!shouldEvaluate) {
      return;
    }

    // Clear materialized paths when no rules defined
    if (!selectionModel.ruleSetJson) {
      setMaterializedPaths(new Set());
      return;
    }

    // Skip when no file tree is available
    if (!treeAdapter) {
      logger.debug('Skipping rule evaluation - no file tree');
      return;
    }

    // Evaluate rules
    isEvaluatingRef.current = true;
    evaluationErrorRef.current = null;

    const result = evaluateRules(selectionModel.ruleSetJson, treeAdapter);

    if (result) {
      // Log warnings
      for (const warning of result.warnings) {
        logger.warn(`Rule warning: ${warning.message}`, {
          code: warning.code,
          ruleId: warning.ruleId,
        });
      }
      setMaterializedPaths(result.paths);
    } else {
      evaluationErrorRef.current = new Error('Rule evaluation failed');
      setMaterializedPaths(new Set());
    }

    isEvaluatingRef.current = false;
  }, [enabled, selectionModel.mode, selectionModel.ruleSetJson, treeAdapter, setMaterializedPaths]);

  return {
    evaluationError: evaluationErrorRef.current,
    isEvaluating: isEvaluatingRef.current,
    matchedCount: selectionModel.materializedPaths?.size ?? 0,
  };
}
