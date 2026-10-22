export const ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT = 80;

export interface AssistantHistoryMessage {
  readonly content: unknown;
  readonly createdAt: Date;
  readonly id: string;
  /** Undefined only for legacy rows written before durable branch topology. */
  readonly parentId?: string | null;
  readonly role: string;
}

export interface AssistantThreadMessageListOptions {
  /** Exclusive native message cursor, scoped to the same thread and resource. */
  readonly beforeMessageId?: string;
  readonly limitLatest?: number;
  /** Stop a targeted read if its same-owner native message was deleted or hidden. */
  readonly targetMessageId?: string;
}

export interface AssistantThreadRunEventListOptions {
  readonly limitLatestRuns?: number;
}
