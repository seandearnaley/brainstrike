export const ASSISTANT_RUN_EVENT_DATA_NAME = 'brainstrike.run-event';

export type AssistantRunEventKind =
  | 'context.budget'
  | 'context.prepared'
  | 'context.selection'
  | 'memory.configured'
  | 'memory.history.loaded'
  | 'memory.observation.completed'
  | 'memory.observation.started'
  | 'memory.reflection.completed'
  | 'memory.reflection.started'
  | 'memory.semantic.completed'
  | 'memory.semantic.started'
  | 'memory.working.loaded'
  | 'memory.working.updated'
  | 'run.cancelled'
  | 'run.failed'
  | 'run.finished'
  | 'run.started'
  | 'run.step.finished'
  | 'run.step.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.started';

export type AssistantRunEventStatus = 'cancelled' | 'completed' | 'failed' | 'info' | 'running';

export type AssistantRunEventJson =
  | AssistantRunEventJson[]
  | boolean
  | null
  | number
  | string
  | { [key: string]: AssistantRunEventJson };

export type AssistantRunEventMetadata = Record<string, AssistantRunEventJson>;

export interface AssistantRunEvent {
  readonly detail?: string;
  readonly durationMs?: number;
  readonly id: string;
  readonly kind: AssistantRunEventKind;
  readonly label: string;
  readonly metadata?: AssistantRunEventMetadata;
  readonly runId?: string;
  readonly sequence?: number;
  readonly status: AssistantRunEventStatus;
  readonly timestamp: string;
}
