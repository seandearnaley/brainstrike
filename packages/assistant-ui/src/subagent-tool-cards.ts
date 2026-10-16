import { type ToolCallMessagePartComponent, useAuiState } from '@assistant-ui/react';
import {
  BUILT_IN_PERSONAS,
  delegationToolNameForPersona,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from '@brainstrike/assistant-contract/personas';
import { createElement, use, useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  readSubagentConversationAddress,
  readSubagentInvocationRun,
  SubagentApprovalHistoryContext,
  type SubagentChildRun,
  SubagentChildRunContext,
  type SubagentConversationAddress,
  type SubagentInvocationRun,
  SubagentLiveInvocationContext,
} from './subagent-conversation-navigation';
import { SubagentExecutionCard } from './subagent-execution-card';
import { useSubagentNavigation } from './use-subagent-navigation';
import { useSubagentPresentation } from './use-subagent-presentation';

/**
 * The delegated child's committed run, from the conversation owner's source.
 * A card that names a child its owner does not follow fails loudly: without
 * the child's own log, a started background child could only be guessed at.
 */
function useSubagentChildRun(threadId: string | undefined): SubagentChildRun | undefined {
  const source = use(SubagentChildRunContext);
  if (threadId !== undefined && !source) {
    throw new Error('A delegation card with a child conversation requires SubagentChildRunContext');
  }
  const read = useCallback(
    () => (threadId === undefined ? undefined : source?.read(threadId)),
    [source, threadId]
  );
  return useSyncExternalStore(source?.subscribe ?? emptySubscribe, read, read);
}

/**
 * The registered delegation-tool component: resolves this delegation's child
 * conversation from the current message (its result names the child, or the
 * owner's live listing does before the result lands) and threads the child's
 * committed run state, presentation and navigation to the presentational
 * SubagentExecutionCard. Kept out of the card so the card stays
 * render-testable without the assistant-ui store.
 */
const SubagentExecutionCardConnected: ToolCallMessagePartComponent = (props) => {
  const liveInvocations = use(SubagentLiveInvocationContext);
  const invocationJson = useAuiState((state) =>
    JSON.stringify(
      readSubagentInvocationRun(state.message.parts, props.toolCallId, state.message.metadata)
    )
  );
  const invocation = useMemo(
    () => JSON.parse(invocationJson) as SubagentInvocationRun,
    [invocationJson]
  );
  const addressJson = useAuiState((state) =>
    JSON.stringify(
      readSubagentConversationAddress(state.message.parts, props.toolCallId, props.result)
    )
  );
  const persistedAddress = useMemo(
    () => JSON.parse(addressJson) as SubagentConversationAddress,
    [addressJson]
  );
  const getLiveThreadId = useCallback(
    () =>
      invocation.kind === 'available'
        ? liveInvocations?.getThreadId({
            parentRuntimeRunId: invocation.parentRuntimeRunId,
            parentToolCallId: props.toolCallId,
          })
        : undefined,
    [invocation, liveInvocations, props.toolCallId]
  );
  const liveThreadId = useSyncExternalStore(
    liveInvocations?.subscribe ?? emptySubscribe,
    getLiveThreadId,
    getLiveThreadId
  );
  const address: SubagentConversationAddress =
    persistedAddress.kind === 'available' &&
    liveThreadId &&
    persistedAddress.threadId !== liveThreadId
      ? { error: 'Conflicting child conversation addresses.', kind: 'invalid' }
      : persistedAddress.kind === 'unavailable' && liveThreadId
        ? { kind: 'available', threadId: liveThreadId }
        : persistedAddress;
  const { entry: presentation, reload } = useSubagentPresentation(
    address.kind === 'available' ? address.threadId : undefined
  );
  const navigation = useSubagentNavigation(address, invocation, props.toolCallId);
  // BST-1932 (AT-07): the child's answered approvals, from its own committed log.
  const approvalHistory = use(SubagentApprovalHistoryContext);
  const childRun = useSubagentChildRun(address.kind === 'available' ? address.threadId : undefined);
  return createElement(SubagentExecutionCard, {
    // Conditional spread, not `isError: props.isError`: under
    // `exactOptionalPropertyTypes` an optional prop may be absent but never
    // explicitly `undefined`.
    ...(props.isError === undefined ? {} : { isError: props.isError }),
    ...navigation,
    ...(presentation && 'presentation' in presentation
      ? { presentation: presentation.presentation }
      : {}),
    ...(presentation && 'error' in presentation
      ? { onReloadPresentation: reload, presentationError: presentation.error }
      : {}),
    ...(typeof props.args['prompt'] === 'string' ? { task: props.args['prompt'] } : {}),
    ...(approvalHistory && address.kind === 'available'
      ? { approvalHistory: approvalHistory(address.threadId) }
      : {}),
    ...(childRun ? { childRun } : {}),
    result: props.result,
    status: props.status,
    toolCallId: props.toolCallId,
    toolName: props.toolName,
  });
};

const emptySubscribe = () => () => undefined;

/**
 * `agent-<personaId>` delegation tool name → SubagentExecutionCardConnected,
 * generated from the built-in personas. Spread into the panel's tool `by_name`
 * map so each delegation tool part renders as a collapsed subagent card instead
 * of a raw tool card. assistant-ui's `by_name` matches exact tool names (no
 * regex), so every registered persona needs its own key — this keeps that
 * data-driven.
 */
export const SUBAGENT_TOOL_CARDS: Record<string, ToolCallMessagePartComponent> = Object.fromEntries(
  BUILT_IN_PERSONAS.map((persona) => [
    delegationToolNameForPersona(persona.id),
    SubagentExecutionCardConnected,
  ])
);

/**
 * Whether a tool name is a Mastra delegation tool (`agent-<personaId>`).
 * assistant-ui's `by_name` map is exact-match, so USER-DEFINED personas (whose
 * ids are not statically known) cannot be pre-registered — the panel's
 * Fallback uses this predicate to route any delegation part to the
 * SubagentExecutionCard instead of a raw tool card. Mastra reserves the
 * `agent-` prefix for delegation tools; native tools are `brainstrike.*` and
 * MCP tools are namespaced by server, so the prefix cannot collide.
 */
export function isSubagentDelegationToolName(toolName: string | undefined): boolean {
  // The Fallback can render parts with no toolName (e.g. non-tool chain
  // steps); those are never delegation cards.
  return toolName?.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX) === true;
}

/** The connected delegation card, exported for the Fallback router. */
export const SubagentDelegationCard: ToolCallMessagePartComponent = SubagentExecutionCardConnected;
