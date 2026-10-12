/**
 * Real-Chromium support for committed-assistant-conversation.browser.test.tsx.
 *
 * EVALUATING THIS MODULE MUST NOT LOAD react-dom OR ITS SCHEDULER. The test
 * imports it before anything that does, so the instrumentation below is in
 * place when React DOM injects into the DevTools hook and the Scheduler opens
 * its MessageChannel (spike s-ui's method; this lane has no setup slot for it).
 * React, assistant-ui and Testing Library are therefore only type-imported
 * here, and loaded by `import()` inside the helpers that need them.
 */
import type { ExportedMessageRepository, ThreadMessage } from '@assistant-ui/react';
import { expect, onTestFinished, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import type { CommittedAssistantCommands } from '../committed-assistant-store';

import { ATTRIBUTION_TRIALS, TRIALS } from './committed-publication-config';

export { ATTRIBUTION_TRIALS, TRIALS } from './committed-publication-config';

import {
  createPublicationInstrumentation,
  drainMicrotasks,
  nextFrame,
  type PublicationTiming,
  yieldTask,
} from './committed-publication-instrumentation';

export {
  drainMicrotasks,
  nextFrame,
  type PublicationTiming,
  type TimedTask,
  yieldTask,
} from './committed-publication-instrumentation';

import {
  RUN_REFUSED,
  recordedBaseline,
  recordedChildPublications,
} from './committed-recording-support';

export {
  answerStepLength,
  CHILD_THREAD_ID,
  committedRows,
  eventIndex,
  HOST_FAILURES,
  pendingApprovalLength,
  RecordedCommittedSource,
  RUN_REFUSED,
  recordedBaseline,
  recordedChildPublications,
  recordedInteractionId,
  recordedPrompt,
  recordedPromptId,
  recordedRunId,
  recordedStore,
  recordedThreadId,
  recordedToolCallId,
  recordedToolName,
  recordedToolResult,
  respondedLength,
  STALE_INTERACTION,
} from './committed-recording-support';

// ---- React instrumentation (spike s-ui, aisdk-b4-ui report "How it was measured") ----

const { instrumentation, measurePublication, waitForQuiescence } =
  createPublicationInstrumentation('named-vendor');

export { instrumentation, measurePublication, waitForQuiescence };

// ---- Browser interaction and geometry helpers ----

export function describeFocus(): string {
  const active = document.activeElement;
  if (!active || active === document.body) {
    return 'BODY';
  }
  return `${active.tagName}:${active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 40) ?? ''}`;
}

/** Where keyboard focus sits relative to one conversation surface. */
export function focusPlacement(conversation: HTMLElement): string {
  const active = document.activeElement;
  return active && active !== document.body && conversation.contains(active)
    ? 'inside the conversation'
    : `lost to ${describeFocus()}`;
}

/** Keyboard-only navigation: real Tab presses until `target` has focus. */
export async function tabTo(
  target: HTMLElement,
  direction: 'backward' | 'forward',
  limit = 24
): Promise<readonly string[]> {
  const { act } = await import('@testing-library/react');
  const path: string[] = [];
  for (let step = 0; step < limit && document.activeElement !== target; step += 1) {
    await act(async () => {
      await userEvent.keyboard(direction === 'forward' ? '{Tab}' : '{Shift>}{Tab}{/Shift}');
    });
    path.push(describeFocus());
  }
  if (document.activeElement !== target) {
    throw new Error(`Keyboard focus never reached the target: ${path.join(' → ')}`);
  }
  return path;
}

/** Outlast the follow engine's coalesced animation-frame measurement. */
export async function settleFrames(count = 3): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await nextFrame();
  }
}

/**
 * Wait for every finite CSS animation/transition under `root` (message and card
 * entrances, disclosures) to finish. Infinite ones (thinking pulse) never do.
 * A geometry baseline read mid-entrance would measure the animation, not layout.
 */
export async function settleAnimations(root: Element): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const running = root
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY &&
          (animation.playState === 'running' || animation.pending)
      );
    if (running.length === 0) {
      return;
    }
    // A replaced/cancelled animation rejects `finished`; it no longer moves anything.
    await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    await nextFrame();
  }
  throw new Error('Finite animations kept restarting under the measured element.');
}

/** Nearest-rank percentile of a non-empty sample. */
export function percentile(values: readonly number[], rank: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)];
  if (value === undefined) {
    throw new Error('A percentile needs at least one sample.');
  }
  return value;
}

export function distanceFromBottom(element: HTMLElement): number {
  return Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight);
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateReducedMotion: (options: { enabled: boolean | null }) => Promise<void>;
  }
}

export function messageRoots(viewport: HTMLElement): ReadonlyMap<string, HTMLElement> {
  return new Map(
    Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]'), (row) => [
      row.dataset['messageId'] ?? '',
      row,
    ])
  );
}

/** The owner refuses run/start before admission with the host's own text. */
export function rejectingNew(): CommittedAssistantCommands['onNew'] {
  return vi.fn(async () => {
    const { MessageNotSentError } = await import('@assistant-ui/react');
    throw new MessageNotSentError(RUN_REFUSED);
  });
}

export async function useViewport(width: number): Promise<void> {
  const previous = { height: window.innerHeight, width: window.innerWidth };
  await page.viewport(width, 800);
  onTestFinished(() => page.viewport(previous.width, previous.height));
  expect(window.innerWidth).toBe(width);
}

export async function useReducedMotion(enabled: boolean): Promise<void> {
  await commands.emulateReducedMotion({ enabled });
  onTestFinished(() => commands.emulateReducedMotion({ enabled: null }));
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(enabled);
}

/** Converts an uncaught browser exception into an explicit assertion of this test. */
export function captureUncaught(): string[] {
  const uncaught: string[] = [];
  const listener = (event: ErrorEvent): void => {
    uncaught.push(event.message);
    event.preventDefault();
  };
  window.addEventListener('error', listener);
  onTestFinished(() => window.removeEventListener('error', listener));
  return uncaught;
}

export async function press(target: HTMLElement, key = '{Enter}'): Promise<void> {
  const { act } = await import('@testing-library/react');
  await act(async () => {
    target.focus();
    await userEvent.keyboard(key);
  });
}

// ---- Render-cost measurement (spike s-ui interval) ----

/** Independent mounts, one recorded token each: enough for a nearest-rank p95. */

/** Extra mounts whose commits are walked for per-row render attribution; never timed. */

export type RenderCounts = Record<'approval' | 'prompt' | 'saved' | 'tool', number>;

export function count<Key extends string>(counts: Record<Key, number>, key: Key): void {
  counts[key] += 1;
}

/** DOM records under elements that a publication must not touch. */
export function watchUnchanged(elements: Readonly<Record<string, Element>>) {
  const touched: string[] = [];
  const observers = Object.entries(elements).map(([name, element]) => {
    const observer = new MutationObserver((records) => {
      touched.push(...records.map((record) => `${name}:${record.type}`));
    });
    observer.observe(element, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return observer;
  });
  return {
    read: (): readonly string[] => {
      for (const observer of observers) {
        touched.push(
          ...observer.takeRecords().map((record) => `${record.target.nodeName}:${record.type}`)
        );
      }
      return [...touched];
    },
    stop: () => {
      for (const observer of observers) {
        observer.disconnect();
      }
    },
  };
}

export const TEXT_KINDS = ['text-start', 'text-delta', 'text-end'] as const;
/** The shipped tool card's own components (tool-fallback*.tsx). */
export const TOOL_CARD_COMPONENTS = new Set([
  'ToolFallback',
  'ToolFallbackBody',
  'ToolFallbackRow',
]);
export type TextKind = (typeof TEXT_KINDS)[number];

export interface PublicationSample extends PublicationTiming {
  readonly selectorRenders: RenderCounts;
  readonly toolCardRenders: number;
  readonly unrelatedDom: readonly string[];
}

export interface ChildPhase {
  readonly childCommits: number;
  readonly publications: number;
  readonly rootCommits: number;
  readonly rootSelectorRenders: RenderCounts;
}

export function setActEnvironment(enabled: boolean): boolean {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = scope.IS_REACT_ACT_ENVIRONMENT ?? false;
  scope.IS_REACT_ACT_ENVIRONMENT = enabled;
  return previous;
}

export const ZERO_COUNTS: RenderCounts = { approval: 0, prompt: 0, saved: 0, tool: 0 };
export const countsSince = (now: RenderCounts, before: RenderCounts): RenderCounts => ({
  approval: now.approval - before.approval,
  prompt: now.prompt - before.prompt,
  saved: now.saved - before.saved,
  tool: now.tool - before.tool,
});

export interface Measurement {
  /** Walked (attribution) samples; their timing includes the walk and is not used. */
  readonly attributed: Readonly<Record<TextKind, readonly PublicationSample[]>>;
  readonly child: readonly ChildPhase[];
  readonly frames: readonly PerformanceEntry[];
  readonly loafSupported: boolean;
  readonly longTaskControl: readonly PerformanceEntry[];
  readonly longTasks: readonly PerformanceEntry[];
  readonly samples: Readonly<Record<TextKind, readonly PublicationSample[]>>;
  readonly savedId: string;
}

const REPORTED_METRICS = [
  'commits',
  'commitsOutsideTimedWork',
  'deferredOtherMs',
  'deferredSchedulerMs',
  'deferredTapMs',
  'deferredTasks',
  'publishSyncMs',
  'reactMs',
] as const;

/** The measurement as a JSON-ready receipt, including every interval definition. */
export function report(measurement: Measurement, react: string): Record<string, unknown> {
  const round = (value: number): number => Number(value.toFixed(3));
  const summary = (values: readonly number[]) =>
    values.length === 0
      ? { samples: 0 }
      : {
          max: round(Math.max(...values)),
          median: round(percentile(values, 50)),
          min: round(Math.min(...values)),
          p95: round(percentile(values, 95)),
          samples: values.length,
        };
  const tokens = measurement.samples['text-delta'];
  const overlapping = (entries: readonly PerformanceEntry[]) =>
    entries
      .filter((entry) =>
        tokens.some(
          (token) => entry.startTime < token.end && entry.startTime + entry.duration > token.start
        )
      )
      .map((entry) => ({ duration: round(entry.duration), startTime: round(entry.startTime) }));
  return {
    browser: navigator.userAgent,
    childPhases: {
      childCommits: summary(measurement.child.map((phase) => phase.childCommits)),
      publicationsPerTrial: measurement.child[0]?.publications,
      rootCommits: measurement.child.map((phase) => phase.rootCommits),
    },
    interval:
      'spike s-ui: publish (sync-lane, uSES) + 20-microtask drain + every React Scheduler/tap MessageChannel task (entry -> +20 microtask hops) until two quiet animation frames; idle excluded',
    longAnimationFrames: measurement.loafSupported
      ? {
          observed: measurement.frames.map((entry) => ({
            blockingDuration: (entry as PerformanceEntry & { blockingDuration?: number })
              .blockingDuration,
            duration: round(entry.duration),
          })),
          overlappingTokens: overlapping(measurement.frames),
        }
      : 'unsupported',
    longTasks: {
      observed: measurement.longTasks.map((entry) => round(entry.duration)),
      overlappingTokens: overlapping(measurement.longTasks),
      positiveControl: measurement.longTaskControl.map((entry) => round(entry.duration)),
    },
    perKind: Object.fromEntries(
      TEXT_KINDS.map((kind) => [
        kind,
        {
          ...Object.fromEntries(
            REPORTED_METRICS.map((metric) => [
              metric,
              summary(measurement.samples[kind].map((sample) => sample[metric])),
            ])
          ),
          rendersByOwner: measurement.attributed[kind][0]?.rendersByOwner,
        },
      ])
    ),
    react,
    tokenPublishSyncMs: tokens.map((token) => round(token.publishSyncMs)),
    tokenReactMs: tokens.map((token) => round(token.reactMs)),
    trials: TRIALS,
  };
}

export interface TrialHandles {
  readonly answer: HTMLElement;
  readonly composer: HTMLElement;
  readonly counts: RenderCounts;
  readonly promptRow: HTMLElement;
  readonly publishChild: (message: ThreadMessage) => void;
  /** Deliver one recorded live text chunk to the trial's store. */
  readonly publishText: (kind: TextKind) => void;
  readonly savedRow: HTMLElement;
  readonly toolCard: HTMLElement;
  readonly unmount: () => void;
  /** Root/child Profiler commits and memoized tool-part router renders. */
  readonly views: Record<'child' | 'root' | 'toolCard', number>;
}

export type MountTrial = (recorded: {
  readonly baseline: ExportedMessageRepository;
  readonly firstChild: ThreadMessage;
  readonly saved: ThreadMessage;
}) => Promise<TrialHandles>;

/**
 * Mounts ATTRIBUTION_TRIALS walked trials then TRIALS timed trials. Each trial
 * delivers the child's recorded progress (root must not render), then the
 * recorded text-start, token and text-end telemetry, measuring each publication.
 */
export async function measureRecordedTextPublications(
  mountTrial: MountTrial,
  tokenText: string
): Promise<Measurement> {
  instrumentation.assertInstalled();
  if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    throw new Error('This Chromium does not report long tasks.');
  }
  const { baseline, saved } = await recordedBaseline();
  const [firstChild, ...childProgress] = await recordedChildPublications();
  if (!firstChild) {
    throw new Error('Missing the first recorded child publication.');
  }
  const longTasks: PerformanceEntry[] = [];
  const frames: PerformanceEntry[] = [];
  const longTaskObserver = new PerformanceObserver((list) => {
    longTasks.push(...list.getEntries());
  });
  longTaskObserver.observe({ type: 'longtask' });
  const loafSupported = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
  const frameObserver = new PerformanceObserver((list) => {
    frames.push(...list.getEntries());
  });
  if (loafSupported) {
    frameObserver.observe({ type: 'long-animation-frame' });
  }
  // Positive control: a known 80 ms busy task must be reported, or "no long
  // task overlapped a token" would mean nothing.
  const controlStart = performance.now();
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      const busy = performance.now();
      while (performance.now() - busy < 80) {
        // busy: the control task itself
      }
      resolve();
    }, 0);
  });
  await settleFrames();
  longTasks.push(...longTaskObserver.takeRecords());
  const longTaskControl = longTasks.filter((entry) => entry.startTime >= controlStart);
  longTasks.length = 0;

  const byKind = (): Record<TextKind, PublicationSample[]> => ({
    'text-delta': [],
    'text-end': [],
    'text-start': [],
  });
  const samples = byKind();
  const attributed = byKind();
  const child: ChildPhase[] = [];
  try {
    for (let trial = 0; trial < ATTRIBUTION_TRIALS + TRIALS; trial += 1) {
      const attributeRenders = trial < ATTRIBUTION_TRIALS;
      const target = attributeRenders ? attributed : samples;
      const handles = await mountTrial({ baseline, firstChild, saved });
      const { counts, views } = handles;
      const previousActEnvironment = setActEnvironment(false);
      try {
        // Independent child source: its own recorded progress, concurrently mounted.
        const rootBefore = views.root;
        const childBefore = views.child;
        const countsBefore = { ...counts };
        for (const publication of childProgress) {
          handles.publishChild(publication);
          await drainMicrotasks();
          await yieldTask();
        }
        await waitForQuiescence();
        child.push({
          childCommits: views.child - childBefore,
          publications: childProgress.length,
          rootCommits: views.root - rootBefore,
          rootSelectorRenders: countsSince(counts, countsBefore),
        });
        for (const kind of TEXT_KINDS) {
          const unrelated = watchUnchanged({
            composer: handles.composer,
            prompt: handles.promptRow,
            saved: handles.savedRow,
            toolCard: handles.toolCard,
          });
          const before = { ...counts };
          const toolCardBefore = views.toolCard;
          const timing = await measurePublication(
            () => handles.publishText(kind),
            attributeRenders
          );
          const unrelatedDom = unrelated.read();
          unrelated.stop();
          target[kind].push({
            ...timing,
            selectorRenders: countsSince(counts, before),
            toolCardRenders: views.toolCard - toolCardBefore,
            unrelatedDom,
          });
        }
      } finally {
        setActEnvironment(previousActEnvironment);
      }
      if (!handles.answer.textContent?.includes(tokenText)) {
        throw new Error('The recorded token never became visible.');
      }
      handles.unmount();
    }
  } finally {
    longTasks.push(...longTaskObserver.takeRecords());
    frames.push(...frameObserver.takeRecords());
    longTaskObserver.disconnect();
    frameObserver.disconnect();
  }
  return {
    attributed,
    child,
    frames,
    loafSupported,
    longTaskControl,
    longTasks,
    samples,
    savedId: saved.id,
  };
}
