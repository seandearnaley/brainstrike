import { useAuiState } from '@assistant-ui/react';
import { createContext, type ReactNode, use, useMemo } from 'react';
import { shouldShowBackgroundActivity } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import type { AssistantRunEventDisplayStatus } from './assistant-run-event-derivation';
import { deriveAssistantRunEventRows } from './assistant-run-event-derivation';
import { useStableRecord } from './use-stable-record';

interface AssistantRunEventDerivations {
  readonly renderPlanKeys: Record<string, string>;
  readonly statuses: Record<string, AssistantRunEventDisplayStatus>;
}

const EMPTY_DERIVATIONS: AssistantRunEventDerivations = {
  renderPlanKeys: {},
  statuses: {},
};

const AssistantRunEventContext = createContext<AssistantRunEventDerivations>(EMPTY_DERIVATIONS);

export function AssistantRunEventProvider({ children }: { readonly children: ReactNode }) {
  const { detailLevel } = useAssistantDetailLevel();
  const active = shouldShowBackgroundActivity(detailLevel);
  const messages = useAuiState((state) => state.thread.messages);
  const derived = useMemo(
    () => (active ? deriveAssistantRunEventRows(messages) : EMPTY_DERIVATIONS),
    [active, messages]
  );
  const renderPlanKeys = useStableRecord(derived.renderPlanKeys);
  const statuses = useStableRecord(derived.statuses);
  const value = useMemo(() => ({ renderPlanKeys, statuses }), [renderPlanKeys, statuses]);

  return (
    <AssistantRunEventContext.Provider value={value}>{children}</AssistantRunEventContext.Provider>
  );
}

export function useAssistantRunEventDerivation(data: unknown): {
  readonly renderPlanKey: string;
  readonly status: AssistantRunEventDisplayStatus | undefined;
} {
  const derivations = use(AssistantRunEventContext);
  const id =
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    typeof (data as { id?: unknown }).id === 'string'
      ? (data as { id: string }).id
      : undefined;
  return {
    renderPlanKey: id ? (derivations.renderPlanKeys[id] ?? 'visible:1') : 'visible:1',
    status: id ? derivations.statuses[id] : undefined,
  };
}
