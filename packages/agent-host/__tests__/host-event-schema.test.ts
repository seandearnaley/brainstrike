/**
 * The committed event schema is the log's one reader: every recorded runtime
 * row parses to itself, and a row the schema never accepted still rejects.
 */
import approved from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import granted from '@brainstrike/test-utils/fixtures/committed-host-granted-run.json' with {
  type: 'json',
};
import hookBlocked from '@brainstrike/test-utils/fixtures/committed-host-hook-blocked.json' with {
  type: 'json',
};
import hooksSkipped from '@brainstrike/test-utils/fixtures/committed-host-hooks-skipped.json' with {
  type: 'json',
};
import mcpUnavailable from '@brainstrike/test-utils/fixtures/committed-host-mcp-unavailable.json' with {
  type: 'json',
};
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import question from '@brainstrike/test-utils/fixtures/committed-host-question.json' with {
  type: 'json',
};
import rewinds from '@brainstrike/test-utils/fixtures/committed-host-rewinds.json' with {
  type: 'json',
};
import attempts from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json' with {
  type: 'json',
};
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { HostEventSchema } from '../src/protocol.js';

const RECORDINGS = {
  approved,
  attempts,
  granted,
  hookBlocked,
  hooksSkipped,
  mcpUnavailable,
  plan,
  question,
  rewinds,
  rich,
};
const recordedEvents = Object.entries(RECORDINGS).flatMap(([name, rows]) =>
  z
    .array(z.object({ event: z.record(z.string(), z.unknown()) }))
    .parse(rows)
    .map(({ event }, index) => ({ event, name: `${name}[${index}] ${String(event['type'])}` }))
);

describe('the committed host event schema', () => {
  // A child's origin-shaped thread.started is recorded by no fixture; the
  // child-run integration suites commit and read it back through this schema.
  test('the recordings cover both interaction.responded shapes, which share a type', () => {
    const keys = recordedEvents
      .filter(({ event }) => event['type'] === 'interaction.responded')
      .map(({ event }) => Object.keys(event));
    expect(keys.some((shape) => shape.includes('decision'))).toBe(true);
    expect(keys.some((shape) => shape.includes('resumeData'))).toBe(true);
  });

  test.each(recordedEvents)('$name parses to itself', ({ event }) => {
    expect(HostEventSchema.parse(event)).toEqual(event);
  });

  const runId = 'run-1';
  const breakdown = {
    attachmentsCount: 0,
    historyMessagesTokens: 12,
    provenance: 'heuristic',
    systemInstructionsTokens: 300,
    toolDefinitionsProvenance: 'heuristic',
    toolDefinitionsTokens: 900,
  };
  const prepared = {
    accounting: {},
    breakdown,
    modelId: 'openai::gpt-6-sol',
    provider: 'openai',
    runId,
    type: 'provider.request.prepared',
  };
  const toolCalls = {
    toolCallsByTool: [{ calls: 1, tokens: 40, toolName: 'brainstrike.grepSearch' }],
    toolCallsTokens: 40,
  };
  const toolCallWindow = {
    base: 'run-start',
    removed: [],
    upserted: [
      {
        inputTokens: 4,
        output: 'full',
        outputTokens: 36,
        toolCallId: 'call-1',
        toolName: 'brainstrike.grepSearch',
      },
    ],
  };

  test.each([
    ['a prepared request measured before tool calls were attributed', prepared],
    [
      'a prepared request with its tool calls and window',
      { ...prepared, breakdown: { ...breakdown, ...toolCalls }, toolCallWindow },
    ],
  ])('%s parses to itself', (_, event) => {
    expect(HostEventSchema.parse(event)).toEqual(event);
  });

  test.each([
    [
      'a tool-call total without its per-tool rows',
      { ...prepared, breakdown: { ...breakdown, toolCallsTokens: 40 } },
    ],
    [
      'a window entry with an unknown output',
      {
        ...prepared,
        toolCallWindow: {
          ...toolCallWindow,
          upserted: [{ ...toolCallWindow.upserted[0], output: 'partial' }],
        },
      },
    ],
    [
      'a window with an unknown base',
      { ...prepared, toolCallWindow: { ...toolCallWindow, base: 'thread-start' } },
    ],
    ['an unknown type', { runId, type: 'run.unknown' }],
    ['no type', { runId }],
    ['a key no member has', { commandId: 'c-1', extra: true, type: 'thread.started' }],
    [
      'both thread.started shapes at once',
      { commandId: 'c-1', origin: {}, type: 'thread.started' },
    ],
    [
      'both interaction.responded shapes at once',
      {
        decision: 'approve',
        interactionId: 'i-1',
        resumeData: {},
        runId,
        type: 'interaction.responded',
      },
    ],
    ['a missing required field', { outcome: 'completed', type: 'run.finished' }],
    ['a value outside its enum', { outcome: 'done', runId, type: 'run.finished' }],
    ['a non-object', 'run.finished'],
  ])('%s rejects', (_, event) => {
    expect(HostEventSchema.safeParse(event).success).toBe(false);
  });
});
