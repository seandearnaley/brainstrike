/**
 * The provider cassette pipeline itself, with no provider traffic: the
 * scripted model-provider shim stands in for the real provider behind the
 * recorder, so record mode, sanitizing, Stop, paced replay and structural
 * matching all run through the real standalone host. A recording must replay
 * to the conversation it recorded, claiming every exchange exactly once.
 */
import {
  PROVIDER_CASSETTE_UPSTREAMS,
  type ProviderCassetteKnob,
} from '@brainstrike/test-utils/provider-cassette';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type ModelProviderScriptSelector,
  type ModelProviderShim,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';
import type { ProviderCassetteScenario } from '../../e2e/utils/provider-cassette-scenarios';
import { recordScenario, replayScenario } from './helpers/provider-cassette-lane';

const KNOBS = Object.keys(PROVIDER_CASSETTE_UPSTREAMS) as ProviderCassetteKnob[];
const shims: ModelProviderShim[] = [];
afterEach(async () => {
  await Promise.all(shims.splice(0).map((shim) => shim.close()));
});

async function standIn(select: ModelProviderScriptSelector) {
  const shim = await startModelProviderShim(select);
  shims.push(shim);
  return {
    shim,
    upstreams: Object.fromEntries(KNOBS.map((knob) => [knob, shim.baseUrlFor(knob)])) as Record<
      ProviderCassetteKnob,
      string
    >,
  };
}

async function roundTrip(scenario: ProviderCassetteScenario, select: ModelProviderScriptSelector) {
  const { upstreams } = await standIn(select);
  const recorded = await recordScenario(scenario, 'stand-in-key', upstreams);
  expect(recorded.findings).toEqual([]);
  expect(recorded.secretScan).toBe('');
  expect(recorded.violations).toEqual([]);
  const replayed = await replayScenario(scenario, recorded.cassette);
  expect(replayed.refusals).toEqual([]);
  expect(replayed.unserved).toEqual([]);
  expect(replayed.violations).toEqual([]);
  expect(replayed.shape).toEqual(recorded.shape);
  return { recorded, replayed };
}

describe('provider cassette pipeline', () => {
  test('records and replays parallel tool calls and two background children on the Responses wire', {
    timeout: 120_000,
  }, async () => {
    const { recorded, replayed } = await roundTrip(
      {
        children: 2,
        credential: 'recorder',
        files: { 'notes.md': '# Notes\n' },
        id: 'pipeline-delegation',
        model: 'openai::gpt-5.4-mini',
        pace: 1,
        prompt: 'Read notes and delegate.',
      },
      (request) => {
        if (request.toolNames.length === 0) {
          return { finalText: 'Stand-in title' };
        }
        if (!request.toolNames.includes('agent-explore')) {
          return {
            finalText: 'Child done.',
            toolCall: { arguments: { pattern: '*.md' }, name: 'brainstrike_globWorkspace' },
          };
        }
        if (JSON.stringify(request.messages).includes('Background invocations of this turn')) {
          return { finalText: 'Both explorers finished.' };
        }
        return {
          finalText: 'Delegated.',
          toolCallStages: [
            [
              { arguments: { path: 'notes.md' }, name: 'brainstrike_readWorkspaceFile' },
              { arguments: { pattern: '*.md' }, name: 'brainstrike_globWorkspace' },
            ],
            [
              { arguments: { prompt: 'Explore fixture one.' }, name: 'agent-explore' },
              { arguments: { prompt: 'Explore fixture two.' }, name: 'agent-explore' },
            ],
          ],
        };
      }
    );
    // The request keeps no credential, and the disposable workspace became a placeholder.
    const text = JSON.stringify(recorded.cassette);
    expect(text).not.toContain('stand-in-key');
    expect(text).toContain('<workspace>');
    expect(replayed.shape.children).toEqual([
      { outcome: 'completed', toolCalls: 1 },
      { outcome: 'completed', toolCalls: 1 },
    ]);
    expect(replayed.shape.title).toBe('before-first-run-finished');
  });

  test('records a Stop as a client-aborted stream and replays it held until the next Stop', {
    timeout: 120_000,
  }, async () => {
    const { recorded, replayed } = await roundTrip(
      {
        credential: 'recorder',
        id: 'pipeline-stop',
        model: 'openai::gpt-5.4-mini',
        prompt: 'Tell a long story.',
        stop: true,
      },
      (request) =>
        request.toolNames.length === 0
          ? { finalText: 'Stand-in title' }
          : {
              beforeFinalText: new Promise<void>(() => undefined),
              finalText: 'never sent',
              streamedBeforeHold: 'Once upon a time. '.repeat(200),
            }
    );
    expect(recorded.cassette.exchanges.map((exchange) => exchange.response.ended)).toContain(
      'client-aborted'
    );
    expect(replayed.shape.runs.map((run) => run.outcome)).toEqual(['stopped']);
  });

  test('matches an OpenRouter chat-completions tool call that opens with empty arguments', {
    timeout: 120_000,
  }, async () => {
    const { replayed } = await roundTrip(
      {
        credential: 'recorder',
        files: { 'notes.md': '# Notes\n' },
        id: 'pipeline-openrouter',
        model: 'openrouter::qwen/qwen3.8-flash',
        prompt: 'Read notes.md.',
      },
      (request) =>
        request.toolNames.length === 0
          ? { finalText: 'Stand-in title' }
          : {
              finalText: 'It is a notes file.',
              toolCall: { arguments: { path: 'notes.md' }, name: 'brainstrike_readWorkspaceFile' },
            }
    );
    expect(replayed.shape.runs[0]?.rows).toEqual(['Read done']);
  });
});
