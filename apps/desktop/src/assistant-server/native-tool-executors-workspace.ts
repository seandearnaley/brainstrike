/**
 * Executor entries for the workspace file, context, canvas, artifact, and
 * worktree tools (BST-1646 step c). Each entry builds the request-scoped
 * Mastra registry object for ONE catalog definition;
 * `native-tool-executors.ts` assembles the exhaustive map.
 */

import {
  type DeleteWorkspaceFileInput,
  type ListWorkspaceContextInput,
  type ManageCanvasInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  normalizeManageCanvasInput,
  type ReadToolOutputArtifactCursorInput,
  type ReadWorkspaceContextInput,
  type ReadWorkspaceDirectoryInput,
  type ReadWorkspaceFileInput,
  type RenameWorkspaceFileInput,
  readToolExecutionThreadId,
  readToolOutputArtifact,
  type StringReplaceWorkspaceFileInput,
  type UpdateWorkspaceContextSelectionInput,
  type UpdateWorkspaceTapestrySelectionsInput,
  type WriteWorkspaceFileInput,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { createArtifactReaderModelProjection } from './artifact-reader-model-projection';
import {
  runDeleteWorkspaceFile,
  runRenameWorkspaceFile,
  runStringReplaceWorkspaceFile,
  runWriteWorkspaceFile,
} from './file-mutation-tools';
import { runManageCanvas } from './manage-canvas-tool';
import { executorGroup } from './native-tool-executor-context';
import { runReadWorkspaceDirectory } from './read-workspace-directory-tool';
import { projectReadWorkspaceFileModelOutput } from './read-workspace-file-model-projection';
import { runReadWorkspaceFile } from './read-workspace-file-tool';
import {
  logToolFailure,
  parseToolExecuteInput,
  readToolCallId,
  type ToolExecuteInput,
  type ToolExecuteRunContext,
} from './tool-execute-support';
import { projectListWorkspaceContextModelOutput } from './workspace-context-model-projection';
import {
  runListWorkspaceContext,
  runReadWorkspaceContext,
  runUpdateWorkspaceContextSelection,
  runUpdateWorkspaceTapestrySelections,
} from './workspace-context-tools';
import { readStateScope } from './workspace-file-staleness';
import { buildWorktreeMastraTools } from './worktree-tools';

export const WORKSPACE_TOOL_EXECUTORS = executorGroup({
  [NATIVE_TOOL_ID.readWorkspaceFile]: ({
    readFileCursorRegistry,
    resolveActiveDomainCharBudget,
    resolvedDomainCharBudget,
    runtimeData,
  }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<ReadWorkspaceFileInput>,
      context?: ToolExecuteRunContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceFile],
        input
      );
      try {
        // BST-1188: readWorkspaceFile deliberately does NOT use the plain
        // identical-args repeated-call guard (`withRepeatedCallGuard`)
        // other read/search tools use — an args-only streak has no
        // way to know the file changed between calls, so it would either
        // permanently refuse a legitimate re-read after an edit (the
        // refusal short-circuits BEFORE the file is ever checked) or stamp
        // a "results have not changed" warning on content that in fact did
        // change (PR #2323 review). The mtime-aware `readWorkspaceFile`
        // loop guard below is the ONLY mechanism — it always re-reads the
        // file first, so it can never go stale in that way.
        return await runReadWorkspaceFile(resolvedInput, runtimeData, readFileCursorRegistry, {
          domainModelResultCharBudget: resolvedDomainCharBudget,
          threadScope: readToolExecutionThreadId([input, context]) ?? readStateScope(runtimeData),
        });
      } catch (error) {
        logToolFailure('readWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.readWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceFile],
    toModelOutput: (output: unknown) =>
      projectReadWorkspaceFileModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  // Present only when the request carries a scoped artifact reader: without
  // one there is nothing to page, and the id's absence is the capability
  // result (the enabled-id filter in assistant-tools.ts logs it as such).
  [NATIVE_TOOL_ID.readToolOutputArtifact]: ({ dependencies, resolveActiveDomainCharBudget }) => {
    const toolOutputArtifactReader = dependencies.toolOutputArtifactReader;
    if (!toolOutputArtifactReader) {
      return;
    }
    return {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readToolOutputArtifact],
      execute: async (input: ToolExecuteInput<ReadToolOutputArtifactCursorInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
          input
        );
        try {
          return await readToolOutputArtifact(
            { ...resolvedInput, mode: 'cursor' },
            {
              reader: toolOutputArtifactReader,
            }
          );
        } catch (error) {
          logToolFailure('readToolOutputArtifact failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.readToolOutputArtifact,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
      toModelOutput: createArtifactReaderModelProjection(resolveActiveDomainCharBudget),
    };
  },
  [NATIVE_TOOL_ID.writeWorkspaceFile]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.writeWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<WriteWorkspaceFileInput>,
      context?: ToolExecuteRunContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.writeWorkspaceFile],
        input
      );
      try {
        return await runWriteWorkspaceFile(
          resolvedInput,
          runtimeData,
          readToolCallId(context),
          readToolExecutionThreadId([input, context])
        );
      } catch (error) {
        logToolFailure('writeWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.writeWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.writeWorkspaceFile],
  }),
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<StringReplaceWorkspaceFileInput>,
      context?: ToolExecuteRunContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
        input
      );
      try {
        return await runStringReplaceWorkspaceFile(
          resolvedInput,
          runtimeData,
          readToolCallId(context),
          readToolExecutionThreadId([input, context])
        );
      } catch (error) {
        logToolFailure('stringReplaceWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
  }),
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.deleteWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<DeleteWorkspaceFileInput>,
      context?: ToolExecuteRunContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.deleteWorkspaceFile],
        input
      );
      try {
        return await runDeleteWorkspaceFile(
          resolvedInput,
          runtimeData,
          readToolCallId(context),
          readToolExecutionThreadId([input, context])
        );
      } catch (error) {
        logToolFailure('deleteWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.deleteWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.deleteWorkspaceFile],
  }),
  [NATIVE_TOOL_ID.renameWorkspaceFile]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.renameWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<RenameWorkspaceFileInput>,
      context?: ToolExecuteRunContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.renameWorkspaceFile],
        input
      );
      try {
        return await runRenameWorkspaceFile(
          resolvedInput,
          runtimeData,
          readToolCallId(context),
          readToolExecutionThreadId([input, context])
        );
      } catch (error) {
        logToolFailure('renameWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.renameWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.renameWorkspaceFile],
  }),
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceDirectory],
    execute: async (input: ToolExecuteInput<ReadWorkspaceDirectoryInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceDirectory],
        input
      );
      try {
        return await runReadWorkspaceDirectory(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('readWorkspaceDirectory failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.readWorkspaceDirectory,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceDirectory],
  }),
  [NATIVE_TOOL_ID.listWorkspaceContext]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorkspaceContext],
    execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
        input
      );
      try {
        return runListWorkspaceContext(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('listWorkspaceContext failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.listWorkspaceContext,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
    toModelOutput: (output: unknown) =>
      projectListWorkspaceContextModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.readWorkspaceContext]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceContext],
    execute: async (input: ToolExecuteInput<ReadWorkspaceContextInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
        input
      );
      try {
        return await runReadWorkspaceContext(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('readWorkspaceContext failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.readWorkspaceContext,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
  }),
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
    execute: async (input: ToolExecuteInput<UpdateWorkspaceContextSelectionInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
        input
      );
      try {
        return await runUpdateWorkspaceContextSelection(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('updateWorkspaceContextSelection failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.updateWorkspaceContextSelection,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
  }),
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
    execute: async (input: ToolExecuteInput<UpdateWorkspaceTapestrySelectionsInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
        input
      );
      try {
        return await runUpdateWorkspaceTapestrySelections(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('updateWorkspaceTapestrySelections failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.updateWorkspaceTapestrySelections,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
  }),
  // Omitted for the built-in local provider (same WebGPU-prefill reasoning as
  // the task-list tool and the plan-mode gate).
  [NATIVE_TOOL_ID.manageCanvas]: ({ isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageCanvas],
          execute: async (input: ToolExecuteInput<ManageCanvasInput>) => {
            // Envelope-validate, then narrow to the clean action branch —
            // tolerated cross-action extras are stripped here so the
            // executor/repository receive exactly ManageCanvasInput.
            const resolvedInput = normalizeManageCanvasInput(
              parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCanvas], input)
            );
            try {
              return await runManageCanvas(resolvedInput, runtimeData);
            } catch (error) {
              logToolFailure('manageCanvas failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.manageCanvas,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCanvas],
        },
  // BST-1392. Both worktree ids are absent from LOCAL_DESKTOP_NATIVE_TOOL_IDS,
  // and this gate is what makes that exclusion real at runtime rather than
  // only in the catalog. The two entries are built in `worktree-tools.ts`.
  [NATIVE_TOOL_ID.listWorktrees]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : buildWorktreeMastraTools(runtimeData, dependencies.worktreeTools)[
          NATIVE_TOOL_ID.listWorktrees
        ],
  [NATIVE_TOOL_ID.manageWorktree]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : buildWorktreeMastraTools(runtimeData, dependencies.worktreeTools)[
          NATIVE_TOOL_ID.manageWorktree
        ],
});
