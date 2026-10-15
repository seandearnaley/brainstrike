/**
 * Prompt-composition breakdown, computed at prompt assembly for the renderer's
 * context usage popover and shipped as the TRANSIENT
 * `brainstrike.context-breakdown` aui-data part (see
 * `@brainstrike/assistant-contract/context-breakdown` for the wire contract and
 * the shell-output transience precedent).
 *
 * Counting method (deliberate): the shared chars/4 HEURISTIC
 * (`countTokensHeuristic`) — the same estimator the renderer's conversation
 * walk uses, so client and server figures are comparable. The accurate WASM
 * tokenizer (`countTokensAccurate` in @brainstrike/tokenization) is a lazy async
 * facade owned by the RAG pipeline; prompt assembly is synchronous and
 * latency-sensitive, and the popover's provenance field already labels these
 * figures 'heuristic', so the async tokenizer buys precision the display does
 * not need. Revisit only with a measured need.
 *
 * NO SILENT FALLBACKS: a category that cannot be measured at this seam is an
 * ABSENT field, never a fabricated 0 (contract rule).
 */
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import { countTokensHeuristic } from '@brainstrike/tokenization';
import type { AgentMessage } from '../types';
import type { ToolDefinitionContextBreakdown } from '../token-measurement';

/**
 * Instruction-side counts, computed where the composed system instructions are
 * finalized (createMastraAgentRuntime). `systemInstructionsTokens` excludes the
 * task list note, which gets its own row; tool guidance is interleaved in the
 * instructions and not separable, so it stays counted inside the instructions
 * figure (no separate field until it can be measured honestly).
 */
export interface InstructionBreakdown {
  readonly systemInstructionsTokens: number;
  readonly taskListTokens?: number;
}

/**
 * Compute the instruction-side counts from the final composed instructions and
 * the task list note that was joined into them. The task list figure is
 * subtracted from the composed total (it is a verbatim segment of the composed
 * string), clamped at 0 against chars/4 rounding drift — both figures are
 * heuristic by contract.
 */
export function computeInstructionBreakdown(params: {
  composedInstructions: string;
  taskListNote: string | null;
}): InstructionBreakdown {
  const composedTokens = countTokensHeuristic(params.composedInstructions);
  if (params.taskListNote === null) {
    return { systemInstructionsTokens: composedTokens };
  }
  const taskListTokens = countTokensHeuristic(params.taskListNote);
  return {
    systemInstructionsTokens: Math.max(0, composedTokens - taskListTokens),
    taskListTokens,
  };
}

/**
 * Complete the breakdown with the message-side counts at stream start.
 *
 * - `attachmentsCount` counts the inline file parts actually on the wire (a
 *   measured 0 is honest).
 * - `historyMessagesTokens` is the heuristic over wire text parts, and is
 *   ABSENT for memory-backed runs: Mastra recalls durable history server-side
 *   AFTER this seam (the transport sends only the current turn), so measuring
 *   the wire would understate the conversation. The renderer falls back to its
 *   client-side heuristic walk instead.
 */
export function computePromptBreakdown(params: {
  instructionBreakdown: InstructionBreakdown;
  memoryBacked: boolean;
  messages: readonly AgentMessage[];
  /**
   * Per-tool definition figures from the run's token diagnostics
   * (RunTokenDiagnostics.toolDefinitionContextBreakdown()). Absent when
   * measurement failed — the breakdown then omits the fields entirely.
   */
  toolDefinitions?: ToolDefinitionContextBreakdown | undefined;
}): AssistantContextBreakdown {
  let attachmentsCount = 0;
  let historyTokens = 0;
  for (const message of params.messages) {
    for (const part of message.parts) {
      if (part.type === 'file') {
        attachmentsCount += 1;
      } else if (part.type === 'text') {
        historyTokens += countTokensHeuristic(part.text);
      }
    }
  }
  const toolDefinitions = params.toolDefinitions;
  return {
    attachmentsCount,
    ...(params.memoryBacked ? {} : { historyMessagesTokens: historyTokens }),
    // Whole-breakdown provenance stays 'heuristic' — the instruction/message
    // figures are always chars/4. Tool-definition precision rides its own
    // toolDefinitionsProvenance field so the payload never claims more
    // precision than it has (provenance must never lie).
    provenance: 'heuristic',
    systemInstructionsTokens: params.instructionBreakdown.systemInstructionsTokens,
    ...(params.instructionBreakdown.taskListTokens === undefined
      ? {}
      : { taskListTokens: params.instructionBreakdown.taskListTokens }),
    ...(toolDefinitions
      ? {
          toolDefinitionsByTool: [...toolDefinitions.byTool]
            .sort(
              (left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name)
            )
            .map(({ name, tokens }) => ({ name, tokens })),
          toolDefinitionsProvenance: toolDefinitions.provenance,
          toolDefinitionsTokens: toolDefinitions.totalTokens,
        }
      : {}),
  };
}
