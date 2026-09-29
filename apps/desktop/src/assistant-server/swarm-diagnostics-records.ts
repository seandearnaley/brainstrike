import { randomUUID } from 'node:crypto';
import { redactSensitiveLogValue } from '@brainstrike/logging';

/** Structural: satisfied by db-main's handle and by DelegatedConversationDatabase. */
export interface SwarmDiagnosticsDatabase {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type PromptManifestKind = 'root-leg' | 'child-first-step' | 'continuation';
export type SystemContextSource = 'captured' | 'root-leg' | 'none';

export interface PromptManifestRecord {
  readonly delegationPrompt?: string;
  readonly kind: PromptManifestKind;
  readonly model?: string;
  readonly nativeRunId?: string;
  readonly parentToolCallId?: string;
  readonly personaId?: string;
  readonly personaInstructions?: string;
  readonly provider?: string;
  readonly systemContextSource: SystemContextSource;
  readonly systemMessages: readonly { readonly content: string; readonly role: 'system' }[];
  readonly threadId: string;
  readonly toolNames: readonly string[];
}

export type WakeupKind = 'idle-loop' | 'resume-leg' | 'late-overlay' | 'deferred';
export interface WakeupInvocation {
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'late' | 'deferred';
  readonly taskId: string | null;
  readonly toolCallId: string;
  readonly toolName: string | null;
}
export interface WakeupRecord {
  readonly directive: string;
  readonly invocations: readonly WakeupInvocation[];
  readonly kind: WakeupKind;
}

export interface LiveDecisionRecord {
  readonly answeredSiblingTaskIds?: readonly string[];
  readonly decision?: 'approve' | 'decline' | 'resume';
  readonly delegationToolCallId?: string;
  readonly kind: 'approval' | 'resume';
  readonly outcome:
    | 'delivered'
    | 'no-live-run'
    | 'refused'
    | 'failed'
    | 'remembered-answered'
    | 'remembered-failed';
  readonly policySnapshot?: unknown;
  readonly reason?: string;
  readonly source: 'user' | 'remembered-grant';
  readonly taskId?: string;
  readonly toolCallId: string;
  readonly toolName?: string;
}

export type RecordOutcome = 'recorded' | 'run-missing';

export const PROMPT_MANIFEST_LIMITS = {
  instructionsChars: 16_384,
  messageChars: 32_768,
  promptChars: 16_384,
  totalChars: 131_072,
} as const;
export const WAKEUP_DIRECTIVE_MAX_CHARS = 16_384;
const LIVE_DECISION_REASON_MAX_CHARS = 2048;

interface Bounded {
  readonly text: string;
  readonly truncated: boolean;
}

function truncateTo(text: string, max: number): Bounded {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  const dropped = text.length - max;
  return { text: `${text.slice(0, max)}…[truncated ${dropped} chars]`, truncated: true };
}

/**
 * Key-name redaction, the same helper the logging boundary uses, applied to
 * every structured (jsonb) value before insert. Prose columns carry no keys to
 * match; their value shapes are scrubbed by the pack formatter at export time.
 */
function redact<T>(value: T): T {
  return redactSensitiveLogValue(value, [], new WeakMap(), {
    maxDepth: 16,
    onDepthTruncated: () => undefined,
    onRepeatedValue: () => undefined,
    repeatedValue: '[REPEATED]',
  }) as T;
}

/** Root-run insert guard shared by all three: 0 rows means the host run does
 * not exist (or its thread is gone) — reported, never thrown. */
async function insertUnderRun(
  db: SwarmDiagnosticsDatabase,
  sql: string,
  params: unknown[]
): Promise<RecordOutcome> {
  const result = await db.query(sql, params);
  return result.rows.length === 1 ? 'recorded' : 'run-missing';
}

interface BoundedSystemMessages {
  readonly serialized: string;
  readonly truncated: boolean;
}

/** Keep the FIRST messages (host authority comes first); drop the tail. */
function boundSystemMessages(
  messages: readonly { readonly content: string; readonly role: 'system' }[]
): BoundedSystemMessages {
  let truncated = false;
  const bounded = messages.map((message) => {
    const content = truncateTo(message.content, PROMPT_MANIFEST_LIMITS.messageChars);
    truncated ||= content.truncated;
    return { content: content.text, role: 'system' as const };
  });
  const serialized = JSON.stringify(redact(bounded));
  if (serialized.length <= PROMPT_MANIFEST_LIMITS.totalChars) {
    return { serialized, truncated };
  }
  const kept: typeof bounded = [];
  let budget = PROMPT_MANIFEST_LIMITS.totalChars;
  for (const message of bounded) {
    if (budget - message.content.length < 0) {
      break;
    }
    budget -= message.content.length;
    kept.push(message);
  }
  return { serialized: JSON.stringify(redact(kept)), truncated: true };
}

export async function recordPromptManifest(
  db: SwarmDiagnosticsDatabase,
  hostRunId: string,
  record: PromptManifestRecord
): Promise<RecordOutcome> {
  const systemMessages = boundSystemMessages(record.systemMessages);
  const instructions =
    record.personaInstructions === undefined
      ? null
      : truncateTo(record.personaInstructions, PROMPT_MANIFEST_LIMITS.instructionsChars);
  const prompt =
    record.delegationPrompt === undefined
      ? null
      : truncateTo(record.delegationPrompt, PROMPT_MANIFEST_LIMITS.promptChars);
  const totalChars =
    record.systemMessages.reduce((sum, message) => sum + message.content.length, 0) +
    (record.personaInstructions?.length ?? 0) +
    (record.delegationPrompt?.length ?? 0);
  const truncated =
    systemMessages.truncated || Boolean(instructions?.truncated) || Boolean(prompt?.truncated);
  return insertUnderRun(
    db,
    `INSERT INTO brainstrike_assistant_prompt_manifests
      (id, host_run_id, thread_id, kind, native_run_id, parent_tool_call_id, persona_id, provider, model,
       system_context_source, system_messages, persona_instructions, delegation_prompt, tool_names,
       total_chars, truncated)
     SELECT $1, runs.id, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15, $16::boolean
     FROM brainstrike_assistant_thread_runs runs WHERE runs.id = $2
     RETURNING id`,
    [
      randomUUID(),
      hostRunId,
      record.threadId,
      record.kind,
      record.nativeRunId ?? null,
      record.parentToolCallId ?? null,
      record.personaId ?? null,
      record.provider ?? null,
      record.model ?? null,
      record.systemContextSource,
      systemMessages.serialized,
      instructions?.text ?? null,
      prompt?.text ?? null,
      JSON.stringify(record.toolNames),
      totalChars,
      truncated,
    ]
  );
}

export async function recordWakeup(
  db: SwarmDiagnosticsDatabase,
  hostRunId: string,
  record: WakeupRecord
): Promise<RecordOutcome> {
  const directive = truncateTo(record.directive, WAKEUP_DIRECTIVE_MAX_CHARS).text;
  return insertUnderRun(
    db,
    `INSERT INTO brainstrike_delegated_wakeups (id, host_run_id, root_thread_id, kind, directive, invocations)
     SELECT $1, runs.id, runs.thread_id, $3, $4, $5::jsonb
     FROM brainstrike_assistant_thread_runs runs WHERE runs.id = $2
     RETURNING id`,
    [randomUUID(), hostRunId, record.kind, directive, JSON.stringify(redact(record.invocations))]
  );
}

export async function recordLiveDecision(
  db: SwarmDiagnosticsDatabase,
  hostRunId: string,
  record: LiveDecisionRecord
): Promise<RecordOutcome> {
  return insertUnderRun(
    db,
    `INSERT INTO brainstrike_delegated_live_decisions
      (id, host_run_id, root_thread_id, task_id, tool_call_id, delegation_tool_call_id, tool_name,
       kind, decision, source, outcome, reason, answered_sibling_task_ids, policy_snapshot)
     SELECT $1, runs.id, runs.thread_id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb
     FROM brainstrike_assistant_thread_runs runs WHERE runs.id = $2
     RETURNING id`,
    [
      randomUUID(),
      hostRunId,
      record.taskId ?? null,
      record.toolCallId,
      record.delegationToolCallId ?? null,
      record.toolName ?? null,
      record.kind,
      record.decision ?? null,
      record.source,
      record.outcome,
      record.reason === undefined
        ? null
        : truncateTo(record.reason, LIVE_DECISION_REASON_MAX_CHARS).text,
      JSON.stringify(record.answeredSiblingTaskIds ?? []),
      record.policySnapshot === undefined ? null : JSON.stringify(redact(record.policySnapshot)),
    ]
  );
}
