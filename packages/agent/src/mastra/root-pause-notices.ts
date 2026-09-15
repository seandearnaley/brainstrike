import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import type {
  ConversationStreamChunk,
  StreamChunk,
  StreamChunkToolApprovalRequired,
  StreamChunkToolSuspendRequired,
} from '../types';
import { makeRunEventChunk } from './stream-run-event-chunks';

type PauseNotice = StreamChunkToolApprovalRequired | StreamChunkToolSuspendRequired;

function readPauseNotice(chunk: StreamChunk | ConversationStreamChunk): PauseNotice | undefined {
  return chunk.type === 'tool-approval-required' || chunk.type === 'tool-suspend-required'
    ? chunk
    : undefined;
}

/**
 * Every parked leaf decision must have a card in the ROOT thread (settled
 * 2026-09-14, do not relitigate).
 *
 * A foreground child's pause suspends the parent run on the delegation call,
 * so Mastra emits a parent-level pause that `decorate()` addresses to the leaf
 * and the root card follows for free. A BACKGROUND child's pause parks a task
 * and suspends nothing in the parent run. Mastra does emit a parent-level
 * pause on the dispatching turn while that turn is still open, but that copy
 * is not the call's delivery and `projectBackgroundStream` drops it (ONE
 * DELIVERY PER BACKGROUND CALL, settled 2026-09-15), so the only trace of the
 * decision in the root stream is the child envelope, which renders in the
 * child view alone. Four specialists parked on reads, the root thread showed
 * no card, and the user approved five stray canvas prompts instead
 * (thread-b629776b, 2026-09-14).
 *
 * At the leg's publish seam the withheld notices hold both shapes, so the rule
 * is mode-agnostic: for every child-scoped notice whose leaf identity has no
 * root-level notice among the held chunks, synthesize one addressed to the
 * ROOT edge (the transport target every resume already uses), naming the leaf
 * tool and carrying the leaf's own args and risk metadata, preceded by the
 * durable "awaiting your approval" row for that delegation call. Held order is
 * preserved; the synthesized cards follow the notices they stand for.
 */
export function withRootPauseNotices(held: readonly StreamChunk[]): StreamChunk[] {
  const rootKeys = new Set<string>();
  for (const chunk of held) {
    const notice = readPauseNotice(chunk);
    if (notice) {
      rootKeys.add(getToolActionIdentityKey(notice));
    }
  }
  const synthesized: StreamChunk[] = [];
  for (const chunk of held) {
    if (chunk.type !== 'delegated-conversation-chunk') {
      continue;
    }
    const notice = readPauseNotice(chunk.chunk);
    const root = notice?.delegation?.path[0];
    if (!(notice && root)) {
      continue;
    }
    const key = getToolActionIdentityKey(notice);
    if (rootKeys.has(key)) {
      continue;
    }
    rootKeys.add(key);
    // Approvals carry the durable "awaiting your approval" row exactly as a
    // native parent pause does (`makeApprovalRequiredChunks`); a typed suspend
    // (question / plan) has no such row anywhere and gets none here either.
    if (notice.type === 'tool-approval-required') {
      synthesized.push(
        makeRunEventChunk('tool.approval.requested', 'running', 'Awaiting your approval', {
          toolCallId: root.parentToolCallId,
          toolName: notice.toolName,
          ...(notice.riskCategory === undefined ? {} : { riskCategory: notice.riskCategory }),
        })
      );
    }
    synthesized.push({
      ...notice,
      runId: root.parentRuntimeRunId,
      toolCallId: root.parentToolCallId,
    });
  }
  return [...held, ...synthesized];
}
