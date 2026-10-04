import type { UIMessage, UIMessageChunk } from 'ai';

export type RunStatus = 'completed' | 'interrupted' | 'failed';
export type Decision = 'approve' | 'deny' | 'grant-session' | McpElicitationAction;
/** B4: an MCP elicitation answer (ElicitResult.action) */
export type McpElicitationAction = 'accept' | 'decline' | 'cancel';
/** root interactions are durable (survive restart); child interactions are awaited gates (interrupted on restart) */
export type InteractionKind = 'approval' | 'ask' | 'plan' | 'mcp-elicitation';

/** Brainstrike's usage model (message-finish usage + billed cost), mapped from AI SDK LanguageModelUsage. */
export interface BrainstrikeStepUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  billedCost: { kind: 'absent' } | { kind: 'malformed'; reason: string } | { kind: 'reported'; usd: number };
}

export type HostEvent =
  /** parentId: undefined = append to the current head (linear); null = new root (edit of the first message). */
  | { type: 'ui.message'; message: UIMessage; parentId?: string | null }
  | { type: 'run.started'; runId: string; parentRunId: string | null; depth: number; messageId: string; trigger: 'user' | 'wake' | 'child' | 'replay'; parentThreadId?: string; background?: boolean; provider?: string; sdkProvider?: string; modelId?: string; parentMessageId?: string | null; label?: string; sessionId?: string; historyCutoffId?: string | null }
  | { type: 'ui.chunk'; runId: string; chunks: UIMessageChunk[] }
  | { type: 'interaction.requested'; interactionId: string; runId: string; toolCallId: string; toolName: string; input: unknown; kind?: InteractionKind; durable?: boolean; approvalId?: string }
  | { type: 'interaction.responded'; interactionId: string; decision: Decision | 'interrupted'; reason?: string; answer?: unknown }
  | { type: 'run.suspended'; runId: string; interactionIds: string[] }
  | { type: 'run.resumed'; runId: string; leg: number }
  /** written (and flushed) immediately before a durable root tool's effect runs: the exactly-once fence */
  | { type: 'tool.exec.started'; runId: string; toolCallId: string; toolName: string }
  | { type: 'run.finished'; runId: string; status: RunStatus; error?: string }
  | { type: 'run.usage'; runId: string; step: number; provider: string; usage: BrainstrikeStepUsage }
  | { type: 'thread.head'; headId: string }
  | { type: 'child.terminal'; childRunId: string; childThreadId: string; status: RunStatus; text: string; background: boolean }
  | { type: 'run.segment'; runId: string; reason: string }
  /** B4: the model view of a tool result whose LOGGED output is a transcript projection (Mastra kept the same thing in
   *  providerMetadata.mastra.modelOutput, and MessageList keys the prompt off it). Later steps/turns/reloads replay it. */
  | { type: 'tool.model-output'; runId: string; toolCallId: string; modelOutput: unknown }
  | { type: 'om.observations'; runId: string; observedMessageIds: string[]; observations: string; generationCount: number; observerInputChars: number; usage: { inputTokens?: number; outputTokens?: number }; record?: unknown };
