/**
 * useContextPacker Hook (BST-173)
 *
 * Provides token-budget-aware packing of semantic search results.
 * Uses the ContextPacker from @brainstrike/assistant-contract with optional
 * integration to the token cache for accurate token counts.
 */

import type {
  ContextPackerOptions,
  ContextPackerResult,
} from '@brainstrike/assistant-contract/context-packer';
import { ContextPacker } from '@brainstrike/assistant-contract/context-packer';
import { countTokensHeuristic } from '@brainstrike/text-splitter';
import type { SemanticSearchResult } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useMemo } from 'react';
import {
  formatPackedContext,
  type TokenCountLookup,
  toContextPackerChunks,
} from '../utils/context-packer-utils';

const logger = createLogger('ContextPacker');

const DEFAULT_TOKEN_BUDGET = 4000;

export type PackedSearchResult = ContextPackerResult & {
  /** Formatted context string with source citations */
  formattedContext: string;
};

export interface UseContextPackerOptions {
  /**
   * Token budget for packing (default: 4000)
   */
  budgetTokens?: number;
  /**
   * Custom token estimation function (default: countTokensHeuristic)
   */
  estimateTokens?: (content: string) => number;
  /**
   * Maximum number of chunks to include (optional)
   */
  maxChunks?: number;
  /**
   * Optional function to look up accurate token counts.
   * When omitted, packing uses the explicit estimateTokens strategy configured for this hook.
   */
  tokenCountLookup?: TokenCountLookup;
}

export type ContextPackerFunction = (
  results: readonly SemanticSearchResult[]
) => PackedSearchResult;

/**
 * Hook that provides a memoized context packer function.
 *
 * @example
 * ```tsx
 * const { packResults } = useContextPacker({ budgetTokens: 4000 });
 *
 * // Later, after search completes:
 * const packed = packResults(searchResults);
 * console.log(packed.formattedContext); // Ready for LLM consumption
 * console.log(packed.totalTokens);      // Tokens used
 * console.log(packed.skipped);          // Chunks that didn't fit
 * ```
 */
export function useContextPacker({
  budgetTokens = DEFAULT_TOKEN_BUDGET,
  maxChunks,
  tokenCountLookup,
  estimateTokens = countTokensHeuristic,
}: UseContextPackerOptions = {}): {
  packResults: ContextPackerFunction;
  budgetTokens: number;
} {
  // Memoize packer options to avoid recreating packer on every call
  const packerOptions = useMemo<ContextPackerOptions>(
    () => ({
      budgetTokens,
      estimateTokens,
      ...(maxChunks === undefined ? {} : { maxChunks }),
    }),
    [budgetTokens, maxChunks, estimateTokens]
  );

  const packResults = useCallback<ContextPackerFunction>(
    (results: readonly SemanticSearchResult[]): PackedSearchResult => {
      logger.debug('Packing search results', {
        inputCount: results.length,
        budgetTokens,
        maxChunks,
        hasTokenLookup: !!tokenCountLookup,
      });

      // Convert search results to context packer format
      const chunks = toContextPackerChunks(results, tokenCountLookup);

      // Pack within budget
      const packer = new ContextPacker(packerOptions);
      const packed = packer.pack(chunks);

      // Format for LLM consumption
      const formattedContext = formatPackedContext(packed.chunks);

      logger.debug('Packing complete', {
        inputCount: results.length,
        outputCount: packed.chunks.length,
        totalTokens: packed.totalTokens,
        skipped: packed.skipped,
        remainingTokens: packed.remainingTokens,
      });

      return {
        ...packed,
        formattedContext,
      };
    },
    [packerOptions, tokenCountLookup, budgetTokens, maxChunks]
  );

  return {
    packResults,
    budgetTokens,
  };
}

/**
 * Standalone function to pack search results without React hooks.
 * Useful for utility functions or non-React contexts.
 */
export function packSearchResults(
  results: readonly SemanticSearchResult[],
  options: UseContextPackerOptions = {}
): PackedSearchResult {
  const {
    budgetTokens = DEFAULT_TOKEN_BUDGET,
    maxChunks,
    tokenCountLookup,
    estimateTokens = countTokensHeuristic,
  } = options;

  const chunks = toContextPackerChunks(results, tokenCountLookup);

  const packerOptions: ContextPackerOptions = {
    budgetTokens,
    estimateTokens,
    ...(maxChunks === undefined ? {} : { maxChunks }),
  };

  const packer = new ContextPacker(packerOptions);
  const packed = packer.pack(chunks);
  const formattedContext = formatPackedContext(packed.chunks);

  return {
    ...packed,
    formattedContext,
  };
}
