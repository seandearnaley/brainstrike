import { createHash } from 'node:crypto';

/**
 * Executable, bounded black-box profile for the MCP Tasks extension
 * (`io.modelcontextprotocol/tasks`, revision 2026-07-28, SEP-2663). The pinned
 * upstream tree has no executable Tasks conformance suite, so this profile is
 * Brainstrike-owned: it is derived from `@brainstrike/mcp-tasks-extension`'s
 * schemas and drives every capability Brainstrike intends to advertise. The
 * reference server consumes this object directly, so its digest is the digest
 * of the behaviour-defining data.
 */
export const TASKS_PROFILE = Object.freeze({
  capabilities: Object.freeze({
    extensions: Object.freeze({ 'io.modelcontextprotocol/tasks': Object.freeze({}) }),
    tools: Object.freeze({ listChanged: false }),
  }),
  extensionId: 'io.modelcontextprotocol/tasks',
  input: Object.freeze({
    key: 'approval',
    request: Object.freeze({
      method: 'elicitation/create',
      params: Object.freeze({
        message: 'Approve the reference task?',
        mode: 'form',
        requestedSchema: Object.freeze({
          properties: Object.freeze({ approved: Object.freeze({ type: 'boolean' }) }),
          required: Object.freeze(['approved']),
          type: 'object',
        }),
      }),
    }),
    response: Object.freeze({ action: 'accept', content: Object.freeze({ approved: true }) }),
  }),
  missingTaskId: 'missing-task',
  notificationMethod: 'notifications/tasks',
  result: Object.freeze({
    content: Object.freeze([Object.freeze({ text: 'done', type: 'text' })]),
  }),
  server: Object.freeze({ name: 'brainstrike-tasks-reference', version: '1.0.0' }),
  spec: '2026-07-28',
  task: Object.freeze({
    createdAt: '2026-09-02T00:00:00.000Z',
    pollIntervalMs: 50,
    ttlMs: 60_000,
  }),
  /** Deterministic observable timeline the black-box matrix asserts. */
  timeline: Object.freeze(['working', 'input_required', 'completed'] as const),
  tool: Object.freeze({
    description: 'Starts a long-running reference task that requires one approval input',
    name: 'start_task',
  }),
} as const);

export const TASKS_PROFILE_SHA256 = createHash('sha256')
  .update(JSON.stringify(TASKS_PROFILE))
  .digest('hex');
