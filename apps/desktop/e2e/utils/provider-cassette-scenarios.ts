/**
 * The recorded provider scenarios: what each asks a real model, and what its
 * cassette must show for the scenario to mean anything. The host-level lane
 * (src/__tests__/provider-cassettes.integration.test.ts) records and replays
 * every scenario on the standalone host; the desktop E2E replays the ones it
 * names through the real app. Prompts name workspace-relative paths and no
 * root, so a recording never carries the recording machine's paths.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type ProviderCassette,
  type ProviderCassetteKnob,
  parseProviderCassette,
} from '@brainstrike/test-utils/provider-cassette';

export type CassetteProvider = 'anthropic' | 'openai' | 'openrouter';

export interface ProviderCassetteScenario {
  /** Background children the scenario waits for, and the parent's wakes after them. */
  readonly children?: number;
  /** Record with the recorder's own key, or a deliberately invalid one (a real provider refusal). */
  readonly credential: 'invalid' | 'recorder';
  /**
   * Proof that a fresh recording shows the provider behavior the scenario exists
   * for; a recording without it is refused, never saved.
   */
  readonly exhibits?: {
    readonly behavior: string;
    readonly holds: (cassette: ProviderCassette) => boolean;
  };
  readonly files?: Readonly<Record<string, string>>;
  /** The fix this scenario was written to guard, if any. */
  readonly guards?: string;
  readonly id: string;
  /** `provider::model` from the canonical catalog. */
  readonly model: string;
  /** Replay pacing (`ProviderCassetteReplayOptions.pace`): concurrent children keep their recorded order. */
  readonly pace?: number;
  readonly prompt: string;
  /** Stop the run once its answer is streaming. */
  readonly stop?: true;
}

const NO_ROOT = 'Use workspace-relative paths and do not pass a root.';

/** One response's SSE `data:` payloads, parsed. */
function responseFrames(body: string): readonly unknown[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Some response of the cassette has at least `count` frames matching `matches`. */
function someResponseHas(
  cassette: ProviderCassette,
  count: number,
  matches: (frame: Record<string, unknown>) => boolean
): boolean {
  return cassette.exchanges.some(
    (exchange) =>
      responseFrames(exchange.response.body).filter((frame) => isRecord(frame) && matches(frame))
        .length >= count
  );
}

/** An Anthropic response with two or more text content blocks in one message. */
function splitsAnswerIntoTextBlocks(cassette: ProviderCassette): boolean {
  return someResponseHas(
    cassette,
    2,
    (frame) =>
      frame['type'] === 'content_block_start' &&
      isRecord(frame['content_block']) &&
      frame['content_block']['type'] === 'text'
  );
}

/** The chat-completions tool-call deltas of one frame. */
function toolCallDeltas(frame: Record<string, unknown>): readonly Record<string, unknown>[] {
  const choices = Array.isArray(frame['choices']) ? frame['choices'] : [];
  return choices.flatMap((choice) =>
    isRecord(choice) && isRecord(choice['delta']) && Array.isArray(choice['delta']['tool_calls'])
      ? choice['delta']['tool_calls'].filter(isRecord)
      : []
  );
}

/** A chat-completions tool call that opens with empty `arguments`, as OpenRouter streams them. */
function opensToolCallWithEmptyArguments(cassette: ProviderCassette): boolean {
  return someResponseHas(cassette, 1, (frame) =>
    toolCallDeltas(frame).some(
      (call) => isRecord(call['function']) && call['function']['arguments'] === ''
    )
  );
}

/** One streamed Responses step that adds two or more function calls. */
function callsToolsInParallel(cassette: ProviderCassette): boolean {
  return someResponseHas(
    cassette,
    2,
    (frame) =>
      frame['type'] === 'response.output_item.added' &&
      isRecord(frame['item']) &&
      frame['item']['type'] === 'function_call'
  );
}

/** An Anthropic response that streamed a thinking block and then a tool call. */
function thinksBeforeCallingATool(cassette: ProviderCassette): boolean {
  return cassette.exchanges.some((exchange) => {
    const blocks = responseFrames(exchange.response.body).flatMap((frame) =>
      isRecord(frame) && frame['type'] === 'content_block_start' && isRecord(frame['content_block'])
        ? [String(frame['content_block']['type'])]
        : []
    );
    const thinking = blocks.indexOf('thinking');
    return thinking >= 0 && blocks.indexOf('tool_use', thinking) > thinking;
  });
}

/** One frame's streamed kinds: an Anthropic block, a Responses item, or chat delta parts. */
function frameKinds(frame: Record<string, unknown>): readonly string[] {
  if (frame['type'] === 'content_block_start' && isRecord(frame['content_block'])) {
    return [String(frame['content_block']['type'])];
  }
  if (frame['type'] === 'response.output_item.added' && isRecord(frame['item'])) {
    return [String(frame['item']['type'])];
  }
  const [choice] = Array.isArray(frame['choices']) ? frame['choices'] : [];
  const delta = isRecord(choice) && isRecord(choice['delta']) ? choice['delta'] : {};
  return [
    ...(delta['reasoning'] || delta['reasoning_details'] ? ['reasoning'] : []),
    ...(delta['content'] ? ['text'] : []),
    ...(toolCallDeltas(frame).length > 0 ? ['tool_call'] : []),
  ];
}

/**
 * What a recording holds, for a refusal: each exchange's status and route,
 * then its streamed block or frame kinds, repeats collapsed. Never text.
 */
export function describeRecording(cassette: ProviderCassette): string {
  return cassette.exchanges
    .map((exchange) => {
      const kinds = responseFrames(exchange.response.body)
        .filter(isRecord)
        .flatMap(frameKinds)
        .filter((kind, index, all) => kind !== all[index - 1]);
      return `${exchange.response.status ?? 'unanswered'} ${exchange.key.knob}${exchange.key.route} ${exchange.key.stream ? 'stream' : 'one-shot'}: ${kinds.join(' ') || '-'}`;
    })
    .join('\n');
}

/** A streamed response the client hung up on (a Stop). */
function isCutOffByStop(cassette: ProviderCassette): boolean {
  return cassette.exchanges.some((exchange) => exchange.response.ended === 'client-aborted');
}

/** A provider HTTP refusal (4xx/5xx) answered a model step. */
function refusesTheRequest(cassette: ProviderCassette): boolean {
  return cassette.exchanges.some(
    (exchange) => exchange.key.stream && (exchange.response.status ?? 0) >= 400
  );
}

export const PROVIDER_CASSETTE_SCENARIOS: readonly ProviderCassetteScenario[] = [
  {
    credential: 'recorder',
    guards: '#3720',
    id: 'openrouter-plain-answer',
    model: 'openrouter::qwen/qwen3.8-flash',
    prompt:
      'In two short paragraphs, explain why a regression test should replay real provider responses. No headings or lists, and do not use any tools.',
  },
  {
    credential: 'recorder',
    exhibits: { behavior: 'two function calls in one step', holds: callsToolsInParallel },
    files: {
      'alpha.md': '# Alpha\n\nAlpha holds the first fixture sentence.\n',
      'beta.md': '# Beta\n\nBeta holds the second fixture sentence.\n',
    },
    id: 'openai-parallel-tool-calls',
    model: 'openai::gpt-6-luna',
    prompt: `Issue two read tool calls together in your first response, one for alpha.md and one for beta.md, before you see either result. Do not read them one at a time. Then say in one sentence what each file holds. ${NO_ROOT}`,
  },
  {
    credential: 'recorder',
    exhibits: { behavior: 'a thinking block before a tool call', holds: thinksBeforeCallingATool },
    files: { 'one.md': '# One\n', 'three.txt': 'three\n', 'two.md': '# Two\n' },
    id: 'anthropic-reasoning-tools',
    // Haiku 5.5 thinks by default (adaptive); Haiku 4.5 does not.
    model: 'anthropic::claude-haiku-5-5',
    prompt: `Think about how to answer first, then use the glob tool to find the markdown files in the workspace, and answer with how many there are. ${NO_ROOT}`,
  },
  {
    credential: 'recorder',
    exhibits: {
      behavior: 'one answer split into several text content blocks',
      holds: splitsAnswerIntoTextBlocks,
    },
    // As live (2026-10-16): the split answer was a long summary written after reading files.
    files: {
      'CHANGELOG.md':
        '# Changelog\n\n## 0.3.0\n- Paced replay keeps background children in order.\n- Tool sets are stored once per cassette.\n\n## 0.2.0\n- Stop is recorded as a client-aborted stream.\n\n## 0.1.0\n- First recorder and replay.\n',
      'docs/guide.md':
        '# Guide\n\n## Record\nRun `cassette-player record --out <file>` and point your client at the printed URL.\n\n## Replay\nRun `cassette-player replay <file>`; unmatched requests get a 401 naming their key.\n\n## Matching\nRequests match by route, model, the first user message and their item count.\n',
      'README.md':
        '# cassette-player\n\nA command-line tool that records HTTP exchanges once and replays them byte for byte. It keeps chunk boundaries, refuses requests it never recorded, and never stores credentials.\n',
    },
    guards: '#3725',
    id: 'anthropic-long-multiblock-answer',
    model: 'anthropic::claude-sonnet-5',
    prompt: `Read README.md, docs/guide.md and CHANGELOG.md, then write a detailed summary of the project of about 500 words: what it is, how recording and replay work, how matching works, and its version history, with headings and bullet lists. ${NO_ROOT}`,
  },
  {
    credential: 'recorder',
    exhibits: {
      behavior: 'a tool call opened with empty arguments',
      holds: opensToolCallWithEmptyArguments,
    },
    files: { 'notes.md': '# Notes\n\nThe cassette harness replays recorded provider streams.\n' },
    guards: '#3713',
    id: 'openrouter-empty-args-tool-call',
    model: 'openrouter::z-ai/glm-5.3-flash',
    // At the provider's own pace the call's input deltas commit before the call
    // completes, as they do live; served at once, the completed call lands first.
    pace: 1,
    prompt: `Read notes.md and summarize it in one sentence. ${NO_ROOT}`,
  },
  {
    children: 2,
    credential: 'recorder',
    files: {
      'notes.md': '# Notes\n\nThe cassette harness replays recorded provider streams.\n',
      'plan.md': '# Plan\n\nRecord, replay, check invariants.\n',
    },
    guards: '#3719',
    id: 'openai-background-delegation',
    model: 'openai::gpt-6-luna',
    pace: 1,
    prompt: `In one step, start two background Explorer agents: one that reads notes.md, and one that reads plan.md. When both results arrive, report each in one sentence. ${NO_ROOT}`,
  },
  {
    credential: 'recorder',
    exhibits: { behavior: 'a stream cut off by Stop', holds: isCutOffByStop },
    id: 'openai-stop-mid-stream',
    model: 'openai::gpt-6-luna',
    prompt:
      'Write a 1,500-word story about a lighthouse keeper who records the sea. Do not use any tools.',
    stop: true,
  },
  {
    credential: 'invalid',
    exhibits: { behavior: 'a provider refusing the model step', holds: refusesTheRequest },
    id: 'openrouter-provider-error',
    model: 'openrouter::qwen/qwen3.8-flash',
    prompt: 'Say hello in one short sentence.',
  },
];

export function providerOf(scenario: ProviderCassetteScenario): CassetteProvider {
  const provider = scenario.model.slice(0, scenario.model.indexOf('::'));
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openrouter') {
    throw new Error(`${scenario.id} names a provider with no base-URL knob: ${provider}`);
  }
  return provider;
}

export const KNOB_OF_PROVIDER: Readonly<Record<CassetteProvider, ProviderCassetteKnob>> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
};

/** Where every cassette lives (packages/test-utils/fixtures/provider-cassettes/<id>.json). */
export const PROVIDER_CASSETTE_DIRECTORY = resolve(
  import.meta.dirname,
  '../../../../packages/test-utils/fixtures/provider-cassettes'
);

export function cassetteFile(scenario: ProviderCassetteScenario): string {
  return join(PROVIDER_CASSETTE_DIRECTORY, `${scenario.id}.json`);
}

/** The scenario's committed cassette; a missing one fails, naming how to record it. */
export function readScenarioCassette(scenario: ProviderCassetteScenario): ProviderCassette {
  const file = cassetteFile(scenario);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `No cassette for ${scenario.id} at ${file}. Record it: see docs/agents/provider-cassettes.md.`,
      { cause: error }
    );
  }
  return parseProviderCassette(text, file);
}
