import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROMPT_MANIFEST_LIMITS,
  recordLiveDecision,
  recordPromptManifest,
  recordWakeup,
} from '../../assistant-server/swarm-diagnostics-records';

describe('swarm diagnostics records', () => {
  let database: PGlite;
  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://swarm-diagnostics-records');
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at, turn_message_id)
      VALUES ('leg', 'owner', 'root', 'openrouter', 'z-ai/glm-5.2', 'desktop', 'running', NOW(), NOW(), NOW(), 'turn');`);
  }, 30_000);
  afterEach(async () => {
    await database.close();
  });

  it('stores a prompt manifest with caps applied and counts the untruncated size', async () => {
    const outcome = await recordPromptManifest(database, 'leg', {
      delegationPrompt: 'x'.repeat(PROMPT_MANIFEST_LIMITS.promptChars + 500),
      kind: 'child-first-step',
      parentToolCallId: 'call-1',
      personaId: 'explore',
      personaInstructions: 'Explore the workspace and report back.',
      systemContextSource: 'root-leg',
      systemMessages: [],
      threadId: 'root',
      toolNames: ['brainstrike.grepSearch'],
    });
    expect(outcome).toBe('recorded');
    const rows = (
      await database.query(
        'SELECT delegation_prompt, persona_instructions, total_chars, truncated FROM brainstrike_assistant_prompt_manifests'
      )
    ).rows as {
      delegation_prompt: string;
      persona_instructions: string;
      total_chars: number;
      truncated: boolean;
    }[];
    expect(rows[0]?.truncated).toBe(true);
    expect(rows[0]?.delegation_prompt.length).toBeLessThan(
      PROMPT_MANIFEST_LIMITS.promptChars + 100
    );
    expect(rows[0]?.delegation_prompt).toMatch(/\[truncated 500 chars\]$/);
    expect(rows[0]?.persona_instructions).toBe('Explore the workspace and report back.');
    expect(rows[0]?.total_chars).toBe(
      PROMPT_MANIFEST_LIMITS.promptChars + 500 + 'Explore the workspace and report back.'.length
    );
  });

  it('stores wakeups and live decisions with key-shaped secrets redacted, and reports a missing run instead of throwing', async () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    expect(
      await recordWakeup(database, 'leg', {
        directive: 'Background invocation call-a (agent-explore) has returned.',
        invocations: [
          { outcome: 'completed', taskId: 't1', toolCallId: 'call-a', toolName: 'agent-explore' },
        ],
        kind: 'idle-loop',
      })
    ).toBe('recorded');
    expect(
      await recordLiveDecision(database, 'leg', {
        answeredSiblingTaskIds: ['t2'],
        decision: 'approve',
        kind: 'approval',
        outcome: 'delivered',
        policySnapshot: {
          apiKey,
          policies: { read: 'allow' },
          sessionGrants: ['read'],
          yolo: false,
        },
        source: 'user',
        taskId: 't1',
        toolCallId: 'call-a',
        toolName: 'brainstrike.readWorkspaceFile',
      })
    ).toBe('recorded');
    expect(
      await recordWakeup(database, 'ghost', { directive: 'x', invocations: [], kind: 'deferred' })
    ).toBe('run-missing');
    const wakeups = (
      await database.query('SELECT root_thread_id, invocations FROM brainstrike_delegated_wakeups')
    ).rows;
    expect(wakeups).toEqual([
      {
        invocations: [
          { outcome: 'completed', taskId: 't1', toolCallId: 'call-a', toolName: 'agent-explore' },
        ],
        root_thread_id: 'root',
      },
    ]);
    const decisions = (
      await database.query(
        'SELECT root_thread_id, answered_sibling_task_ids, policy_snapshot FROM brainstrike_delegated_live_decisions'
      )
    ).rows;
    expect(decisions).toEqual([
      {
        answered_sibling_task_ids: ['t2'],
        policy_snapshot: {
          apiKey: '[REDACTED]',
          policies: { read: 'allow' },
          sessionGrants: ['read'],
          yolo: false,
        },
        root_thread_id: 'root',
      },
    ]);
    expect(JSON.stringify(decisions)).not.toContain(apiKey);
  });
});
