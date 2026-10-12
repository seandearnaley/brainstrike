/**
 * The retrieval tools (queryEmbeddingSpace, hybridSearch, listEmbeddingSpaces)
 * over a caller-supplied store and native index: Main binds its own PGlite
 * catalog and index capability, the desktop agent host binds typed reads of
 * them. This module must not import Electron or Main's database: the host
 * bundle loads it.
 */
import {
  type HybridSearchInput,
  type ListEmbeddingSetsInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type QueryEmbeddingSpaceInput,
  resolveGuardedToolSignal,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  type NativeToolBuildContext,
  type NativeToolExecutor,
  parseToolExecuteInput,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import type { z } from 'zod';
import { runHybridSearchWith } from './hybrid-search-core';
import { runListEmbeddingSpacesWith } from './list-embedding-spaces-core';
import {
  NATIVE_HYBRID_RETRIEVAL_DESCRIPTION,
  NATIVE_SEMANTIC_RETRIEVAL_DESCRIPTION,
  NativeHybridSearchInputSchema,
  NativeQueryEmbeddingSpaceInputSchema,
} from './native-retrieval-schemas';
import { type RetrievalToolDependencies, runQueryEmbeddingSpaceWith } from './retrieval-core';
import type { RetrievalStore } from './retrieval-store';
import {
  projectHybridSearchModelOutput,
  projectQueryEmbeddingSpaceModelOutput,
} from './workspace-retrieval-model-projections';

/** What one request's retrieval tools read: the native index, query embeddings and the catalog. */
export interface RetrievalToolServices {
  readonly dependencies: RetrievalToolDependencies;
  readonly store: RetrievalStore;
}

export function retrievalToolExecutors(
  services: (context: NativeToolBuildContext) => RetrievalToolServices
): {
  readonly [NATIVE_TOOL_ID.hybridSearch]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.listEmbeddingSpaces]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.queryEmbeddingSpace]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.queryEmbeddingSpace]: (context) => {
      const { dependencies, store } = services(context);
      const { resolveActiveDomainCharBudget, runtimeData } = context;
      const inputSchema: z.ZodType<QueryEmbeddingSpaceInput> = dependencies.nativeIndexSearch
        ? NativeQueryEmbeddingSpaceInputSchema
        : NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryEmbeddingSpace];
      return {
        description: dependencies.nativeIndexSearch
          ? NATIVE_SEMANTIC_RETRIEVAL_DESCRIPTION
          : TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.queryEmbeddingSpace],
        execute: async (
          input: ToolExecuteInput<QueryEmbeddingSpaceInput>,
          options?: ToolExecuteContext
        ) => {
          const resolvedInput = parseToolExecuteInput(inputSchema, input);
          try {
            return await runQueryEmbeddingSpaceWith(
              resolvedInput,
              runtimeData,
              dependencies,
              store,
              resolveGuardedToolSignal(options)
            );
          } catch (error) {
            logToolFailure('queryEmbeddingSpace failed', error, resolvedInput);
            throw error;
          }
        },
        id: NATIVE_TOOL_ID.queryEmbeddingSpace,
        inputSchema,
        toModelOutput: (output: unknown) =>
          projectQueryEmbeddingSpaceModelOutput(output, resolveActiveDomainCharBudget()),
      };
    },
    [NATIVE_TOOL_ID.hybridSearch]: (context) => {
      const { dependencies, store } = services(context);
      const { resolveActiveDomainCharBudget, runtimeData } = context;
      const inputSchema: z.ZodType<HybridSearchInput> = dependencies.nativeIndexSearch
        ? NativeHybridSearchInputSchema
        : NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.hybridSearch];
      return {
        description: dependencies.nativeIndexSearch
          ? NATIVE_HYBRID_RETRIEVAL_DESCRIPTION
          : TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.hybridSearch],
        execute: async (
          input: ToolExecuteInput<HybridSearchInput>,
          options?: ToolExecuteContext
        ) => {
          const resolvedInput = parseToolExecuteInput(inputSchema, input);
          try {
            return await runHybridSearchWith(
              resolvedInput,
              runtimeData,
              dependencies,
              store,
              resolveGuardedToolSignal(options)
            );
          } catch (error) {
            logToolFailure('hybridSearch failed', error, resolvedInput);
            throw error;
          }
        },
        id: NATIVE_TOOL_ID.hybridSearch,
        inputSchema,
        toModelOutput: (output: unknown) =>
          projectHybridSearchModelOutput(output, resolveActiveDomainCharBudget()),
      };
    },
    [NATIVE_TOOL_ID.listEmbeddingSpaces]: (context) => {
      const { dependencies, store } = services(context);
      const { runtimeData } = context;
      return {
        description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listEmbeddingSpaces],
        execute: async (input: ToolExecuteInput<ListEmbeddingSetsInput>) => {
          const resolvedInput = parseToolExecuteInput(
            NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listEmbeddingSpaces],
            input
          );
          try {
            return await runListEmbeddingSpacesWith(
              resolvedInput,
              runtimeData,
              dependencies.nativeIndexSearch,
              store
            );
          } catch (error) {
            logToolFailure('listEmbeddingSpaces failed', error, resolvedInput);
            throw error;
          }
        },
        id: NATIVE_TOOL_ID.listEmbeddingSpaces,
        inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listEmbeddingSpaces],
      };
    },
  };
}
