export const ASSISTANT_RUN_ERRORS_TABLE = 'brainstrike_assistant_run_errors';

export interface AssistantRunErrorRecord {
  readonly causeChain: readonly unknown[] | null;
  readonly code: string;
  readonly httpStatus: number | null;
  readonly message: string | null;
  readonly occurredAt: Date;
  readonly providerRequestId: string | null;
  readonly resourceId: string;
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  readonly runId: string;
  readonly threadId: string;
}

/**
 * The repository deliberately does not accept thread/resource ownership from
 * callers. It derives both from the durable renderer-minted parent run so a
 * Mastra-internal run id cannot create an unjoinable forensics row.
 */
export interface RecordAssistantRunErrorInput {
  readonly causeChain?: readonly unknown[] | null;
  readonly code: string;
  readonly httpStatus?: number | null;
  readonly message?: string | null;
  readonly occurredAt: Date;
  readonly providerRequestId?: string | null;
  readonly responseHeaders?: Readonly<Record<string, string>> | null;
  readonly runId: string;
}
