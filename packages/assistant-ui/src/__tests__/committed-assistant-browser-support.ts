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
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import type {
  CommittedAssistantLogSource,
  CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '../committed-assistant-log-store';
import type { CommittedAssistantCommands } from '../committed-assistant-store';
// Actual production desktop child continuation wire, the same capture
// recordedMessage() decodes. Its own child thread identity is "child".
import childRecording from './fixtures/child-continuation-native-wire.json';
// Actual HostCore + native StateStore + pinned AI SDK approved-run capture
// (see committed-assistant-log-projection.test.ts). Payloads and IDs unchanged.
import recording from './fixtures/committed-approved-host-run.json';

// ---- React instrumentation (spike s-ui, aisdk-b4-ui report "How it was measured") ----

interface Fiber {
  readonly alternate: Fiber | null;
  readonly child: Fiber | null;
  readonly flags: number;
  readonly memoizedProps: unknown;
  readonly return: Fiber | null;
  readonly sibling: Fiber | null;
  readonly tag: number;
  readonly type: unknown;
}

export interface TimedTask {
  end: number;
  readonly label: 'assistant-ui/tap' | 'other' | 'react-scheduler';
  readonly start: number;
}

interface InstrumentationState {
  commits: number;
  commitTimes: number[];
  readonly handlerLabels: Set<TimedTask['label']>;
  recording: boolean;
  readonly rendered: Map<string, Map<string, number>>;
  readonly renderers: Map<number, unknown>;
  readonly tasks: TimedTask[];
  walk: boolean;
}

const state: InstrumentationState = {
  commits: 0,
  commitTimes: [],
  handlerLabels: new Set(),
  recording: false,
  rendered: new Map(),
  renderers: new Map(),
  tasks: [],
  walk: false,
};

// React DevTools' "did render" rule: function, class, forwardRef and simple
// memo fibers render iff they are new or carry PerformedWork (flags & 1); the
// walk descends only where a child list was re-created in this commit.
const COMPONENT_TAGS = new Set([0, 1, 11, 15]);
const HOST_COMPONENT_TAG = 5;
const PERFORMED_WORK = 1;

function nameOf(fiber: Fiber): string {
  const type = fiber.type as {
    readonly displayName?: string;
    readonly name?: string;
    readonly render?: { readonly displayName?: string; readonly name?: string };
  } | null;
  return (
    type?.displayName ||
    type?.name ||
    type?.render?.displayName ||
    type?.render?.name ||
    `tag${fiber.tag}`
  );
}

function messageIdOf(fiber: Fiber | null): string | undefined {
  if (fiber?.tag !== HOST_COMPONENT_TAG) {
    return undefined;
  }
  const id = (fiber.memoizedProps as Record<string, unknown> | null)?.['data-message-id'];
  return typeof id === 'string' ? id : undefined;
}

/** The committed message a fiber renders for, or "outside" any message row. */
function ownerOf(fiber: Fiber): string {
  for (let ancestor = fiber.return; ancestor; ancestor = ancestor.return) {
    const id = messageIdOf(ancestor);
    if (id) {
      return id;
    }
  }
  // A message's own components sit above its root element: follow component
  // fibers down to the first host element and attribute by that element only.
  let descendant = fiber.child;
  while (descendant && descendant.tag !== HOST_COMPONENT_TAG) {
    descendant = descendant.child;
  }
  return messageIdOf(descendant) ?? 'outside';
}

function walk(root: Fiber): void {
  const stack: Fiber[] = [root];
  for (let fiber = stack.pop(); fiber; fiber = stack.pop()) {
    const previous = fiber.alternate;
    if (
      COMPONENT_TAGS.has(fiber.tag) &&
      (previous === null || (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK)
    ) {
      const name = previous === null ? `${nameOf(fiber)} (mount)` : nameOf(fiber);
      const names = state.rendered.get(ownerOf(fiber)) ?? new Map<string, number>();
      names.set(name, (names.get(name) ?? 0) + 1);
      state.rendered.set(ownerOf(fiber), names);
    }
    if (previous === null || fiber.child !== previous.child) {
      for (let child = fiber.child; child; child = child.sibling) {
        stack.push(child);
      }
    }
  }
}

const hookGlobal = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
if (hookGlobal.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== undefined) {
  throw new Error('A React DevTools hook is already installed; render counts would be ambiguous.');
}
hookGlobal.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  checkDCE: () => undefined,
  inject: (renderer: unknown): number => {
    const id = state.renderers.size + 1;
    state.renderers.set(id, renderer);
    return id;
  },
  onCommitFiberRoot: (_id: number, root: { readonly current: Fiber }): void => {
    state.commits += 1;
    if (state.recording) {
      state.commitTimes.push(performance.now());
    }
    if (state.walk) {
      walk(root.current);
    }
  },
  onCommitFiberUnmount: () => undefined,
  onPostCommitFiberRoot: () => undefined,
  onScheduleFiberRoot: () => undefined,
  renderers: state.renderers,
  setStrictMode: () => undefined,
  supportsFiber: true,
};

/**
 * Every MessageChannel `onmessage` handler is wrapped. A task runs from handler
 * entry until 20 chained microtask hops after it, because React's sync-lane
 * renders run in microtasks the handler queued. The Scheduler's handler is
 * `performWorkUntilDeadline`; assistant-ui tap's is `flushScheduled`.
 */
const NativeMessageChannel = globalThis.MessageChannel;
const onmessageProperty = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
const nativeSetOnmessage = onmessageProperty?.set;
const nativeGetOnmessage = onmessageProperty?.get;
if (!(nativeSetOnmessage && nativeGetOnmessage)) {
  throw new Error('MessagePort.prototype.onmessage is not an accessor in this browser.');
}
type PortHandler = (this: MessagePort, event: MessageEvent) => unknown;

function labelOf(handler: PortHandler): TimedTask['label'] {
  if (handler.name === 'performWorkUntilDeadline') {
    return 'react-scheduler';
  }
  return /flushScheduled/.test(String(handler)) ? 'assistant-ui/tap' : 'other';
}

function instrumentPort(port: MessagePort): void {
  Object.defineProperty(port, 'onmessage', {
    configurable: true,
    get(this: MessagePort) {
      return nativeGetOnmessage?.call(this);
    },
    set(this: MessagePort, handler: PortHandler | null) {
      if (typeof handler !== 'function') {
        nativeSetOnmessage?.call(this, handler);
        return;
      }
      const label = labelOf(handler);
      state.handlerLabels.add(label);
      nativeSetOnmessage?.call(this, function timed(this: MessagePort, event: MessageEvent) {
        if (!state.recording) {
          return handler.call(this, event);
        }
        const task: TimedTask = { end: Number.NaN, label, start: performance.now() };
        try {
          return handler.call(this, event);
        } finally {
          let hops = 0;
          const hop = (): void => {
            hops += 1;
            if (hops < 20) {
              queueMicrotask(hop);
              return;
            }
            task.end = performance.now();
            state.tasks.push(task);
          };
          queueMicrotask(hop);
        }
      });
    },
  });
}

class InstrumentedMessageChannel extends NativeMessageChannel {
  constructor() {
    super();
    instrumentPort(this.port1);
    instrumentPort(this.port2);
  }
}
globalThis.MessageChannel = InstrumentedMessageChannel;

export const instrumentation = {
  /** Fails loudly unless React DOM and its Scheduler loaded AFTER installation. */
  assertInstalled(): void {
    if (state.renderers.size === 0) {
      throw new Error('React DOM loaded before the DevTools hook; render counts are unavailable.');
    }
    if (!state.handlerLabels.has('react-scheduler')) {
      throw new Error('The React Scheduler channel was created before instrumentation.');
    }
  },
  get commits(): number {
    return state.commits;
  },
  get commitTimes(): readonly number[] {
    return state.commitTimes;
  },
  /** Component renders per committed message ("outside" = not in any row) since `reset`. */
  rendered(): ReadonlyMap<string, ReadonlyMap<string, number>> {
    return state.rendered;
  },
  reset(): void {
    state.commitTimes = [];
    state.rendered.clear();
    state.tasks.length = 0;
  },
  /**
   * Record timed tasks and commit times; `walk` also attributes rendered
   * components to rows. The walk runs inside each commit, so timing samples
   * are taken with it off and attribution samples are never timed.
   */
  setRecording(recording: boolean, walkCommits = false): void {
    state.recording = recording;
    state.walk = recording && walkCommits;
  },
  get tasks(): readonly TimedTask[] {
    return state.tasks;
  },
};

/** Yield one macrotask on an uninstrumented channel (no timer clamping). */
export function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new NativeMessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

export async function drainMicrotasks(): Promise<void> {
  for (let hop = 0; hop < 20; hop += 1) {
    await Promise.resolve();
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

// ---- Recorded committed host run ----

export const committedRows: readonly CommittedAssistantLogRow[] = recording;

/**
 * Owner failure texts copied verbatim from the host source; the view must show
 * them truthfully instead of an empty successful transcript (BST-1929).
 */
export const HOST_FAILURES = [
  // packages/agent-host/src/client.ts: attach refuses another protocol/version.
  { kind: 'version', text: 'Host has an incompatible protocol or version' },
  // packages/agent-host/src/runtime.ts: the platform runtime is not acquired.
  { kind: 'runtime', text: 'Host platform has not been acquired' },
  // packages/agent-host/src/run-admission.ts: an absent admission capability.
  { kind: 'capability', text: 'Host platform has no complete run admission capability' },
] as const;

/** packages/agent-host/src/run-admission.ts: run/start refused before admission. */
export const RUN_REFUSED = 'Thread already has an active root run';
/** packages/agent-host/src/core.ts: interaction/respond refused for a stale decision. */
export const STALE_INTERACTION = 'Human interaction is stale or belongs to another run';

function rowIndex(predicate: (row: CommittedAssistantLogRow) => boolean, label: string): number {
  const index = committedRows.findIndex(predicate);
  if (index < 0) {
    throw new Error(`The committed recording has no ${label} row.`);
  }
  return index;
}

/** Index of the first recorded row with this host event type. */
export function eventIndex(type: string): number {
  return rowIndex(({ event }) => event['type'] === type, type);
}

/** Index of the first recorded `stream.chunk` row carrying this chunk type. */
export function chunkIndex(type: string): number {
  return rowIndex(
    ({ event }) =>
      event['type'] === 'stream.chunk' &&
      (event['chunk'] as { readonly type?: unknown } | undefined)?.type === type,
    `stream.chunk ${type}`
  );
}

const started = committedRows[eventIndex('run.started')];
const accepted = committedRows.find(
  ({ event }) => event['type'] === 'command.accepted' && event['method'] === 'run/start'
);
const requested = committedRows[eventIndex('interaction.requested')];
if (
  !(started && accepted && requested) ||
  typeof started.event['runId'] !== 'string' ||
  typeof started.event['prompt'] !== 'string' ||
  typeof accepted.event['commandId'] !== 'string' ||
  typeof requested.event['interactionId'] !== 'string' ||
  typeof requested.event['toolCallId'] !== 'string' ||
  typeof requested.event['toolId'] !== 'string'
) {
  throw new Error('The committed recording is missing its run, prompt or interaction identities.');
}
export const recordedThreadId = started.threadId;
export const recordedRunId = started.event['runId'];
export const recordedPrompt = started.event['prompt'];
export const recordedPromptId = accepted.event['commandId'];
export const recordedInteractionId = requested.event['interactionId'];
export const recordedToolCallId = requested.event['toolCallId'];
export const recordedToolName = requested.event['toolId'];
/** The authoritative effect output object; the projection keeps this exact reference. */
export const recordedToolResult = committedRows[eventIndex('effect.finished')]?.event['output'];

/** Prefix while the host waits for the decision: through the recorded tool-call chunk. */
export const pendingApprovalLength = committedRows.findIndex(
  ({ event }) => event['type'] === 'command.accepted' && event['method'] === 'interaction/respond'
);
/** The committed response suffix ends with the host's `interaction.responded`. */
export const respondedLength = eventIndex('interaction.responded') + 1;
/** Prefix through `text-start`: the answer's text part exists and is still empty. */
export const textStartLength = chunkIndex('text-start') + 1;
/** The recorded run's single text token. */
export const tokenIndex = chunkIndex('text-delta');
if (
  pendingApprovalLength <= eventIndex('interaction.requested') ||
  respondedLength <= pendingApprovalLength ||
  tokenIndex !== textStartLength ||
  recordedToolResult === undefined
) {
  throw new Error('The committed recording no longer has the expected publication order.');
}

/**
 * Passive publication of already committed prefixes plus the owner's connection
 * view. It never folds, appends, invents rows or answers commands: the store's
 * production projection does all folding, and a prefix can only grow.
 */
export class RecordedCommittedSource implements CommittedAssistantLogSource {
  private prefix = 0;
  private connected = true;
  private error: string | undefined;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => ({
    connected: this.connected,
    error: this.error,
    rows: committedRows.slice(0, this.prefix),
  });

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Publish the committed prefix that ends before `length`; it never shrinks. */
  publishPrefix(length: number): void {
    if (length < this.prefix || length > committedRows.length) {
      throw new Error('A committed prefix can only grow within the recording.');
    }
    this.prefix = length;
    this.notify();
  }

  /** The owner's connection view. A failure carries the owner's error text. */
  setConnection(connected: boolean, error?: string): void {
    this.connected = connected;
    this.error = error;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * The production store over the recorded source. The run identity resolver is
 * test-owned, exactly as in the projection tests; there is no production alias.
 */
export async function recordedStore(
  source: RecordedCommittedSource,
  baseline?: ExportedMessageRepository,
  parentMessageId: string | null = baseline?.headId ?? null
): Promise<CommittedAssistantLogStore> {
  const { CommittedAssistantLogStore: Store } = await import('../committed-assistant-log-store');
  return new Store({
    ...(baseline ? { baseline } : {}),
    identifyRun: () => ({
      assistantMessageId: recordedRunId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      metadata: { custom: { hostRunId: recordedRunId } },
      parentMessageId,
      userMessageId: recordedPromptId,
    }),
    source,
    threadId: recordedThreadId,
  });
}

/** The saved child-continuation answer as the committed baseline before the recorded run. */
export async function recordedBaseline(): Promise<{
  readonly baseline: ExportedMessageRepository;
  readonly saved: ThreadMessage;
}> {
  const { recordedMessage } = await import('./committed-assistant-test-support');
  const saved = await recordedMessage();
  return { baseline: { headId: saved.id, messages: [{ message: saved, parentId: null }] }, saved };
}

export const CHILD_THREAD_ID = 'child';

/**
 * Every snapshot the native child wire produces, in recorded order: the
 * child's own progressive publications. recordedMessage() keeps only the last.
 */
export async function recordedChildPublications(): Promise<readonly ThreadMessage[]> {
  const [{ fromThreadMessageLike }, { AssistantMessageAccumulator, DataStreamDecoder }] =
    await Promise.all([import('@assistant-ui/react'), import('assistant-stream')]);
  const response = new Response(childRecording.lines.join(''));
  if (!response.body) {
    throw new Error('Missing recorded child response body.');
  }
  const publications: ThreadMessage[] = [];
  for await (const snapshot of response.body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(new AssistantMessageAccumulator())) {
    publications.push(
      fromThreadMessageLike(
        {
          content: snapshot.parts,
          createdAt: new Date('2026-09-12T10:51:09.660Z'),
          id: 'parent-outcome-message',
          metadata: snapshot.metadata,
          role: 'assistant',
          status: snapshot.status,
        },
        'parent-outcome-message',
        snapshot.status
      )
    );
  }
  if (publications.length < 2) {
    throw new Error('The child recording must publish progress more than once.');
  }
  return publications;
}

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
export const TRIALS = 40;
/** Extra mounts whose commits are walked for per-row render attribution; never timed. */
export const ATTRIBUTION_TRIALS = 5;

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
export const TEXT_ROW: Readonly<Record<TextKind, number>> = {
  'text-delta': tokenIndex,
  'text-end': tokenIndex + 1,
  'text-start': tokenIndex - 1,
};

export interface PublicationTiming {
  readonly commits: number;
  /** Commits that landed outside every timed slice (would be uncounted work). */
  readonly commitsOutsideTimedWork: number;
  readonly deferredOtherMs: number;
  readonly deferredSchedulerMs: number;
  readonly deferredTapMs: number;
  readonly deferredTasks: number;
  readonly end: number;
  readonly publishSyncMs: number;
  /** Spike s-ui's per-token `react`: publishSync + deferred Scheduler + tap tasks. */
  readonly reactMs: number;
  readonly rendersByOwner: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly start: number;
}

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

/** Two consecutive animation frames, each followed by a task, with no new commit or timed task. */
export async function waitForQuiescence(): Promise<void> {
  for (let quiet = 0; quiet < 2; ) {
    const commits = instrumentation.commits;
    const tasks = instrumentation.tasks.length;
    await nextFrame();
    await yieldTask();
    quiet =
      instrumentation.commits === commits && instrumentation.tasks.length === tasks ? quiet + 1 : 0;
  }
}

/**
 * MEASURED INTERVAL (spike s-ui, aisdk-b4-ui report line ~218): the owner's
 * publication plus a 20-microtask drain, plus every React Scheduler and
 * assistant-ui tap MessageChannel task it caused, each timed from handler entry
 * to 20 microtask hops later, until quiescence. Quiescence here is two
 * consecutive animation frames (each followed by a task) with no new commit and
 * no new timed task, so the vendor's requestAnimationFrame-paced
 * smooth-streaming reveal is inside the interval. Idle time is not counted.
 *
 * The spike wrapped the publication in `flushSync`. This package declares no
 * React DOM types, so the publication runs unwrapped: every update it causes is
 * a useSyncExternalStore update, which React always renders on the sync lane in
 * the microtask the drain covers. That is also the owner's production path.
 * `commitsOutsideTimedWork` proves no commit escaped the timed slices.
 */
export async function measurePublication(
  publish: () => void,
  attributeRenders: boolean
): Promise<PublicationTiming> {
  instrumentation.reset();
  instrumentation.setRecording(true, attributeRenders);
  const commitsBefore = instrumentation.commits;
  const start = performance.now();
  publish();
  await drainMicrotasks();
  const publishEnd = performance.now();
  await waitForQuiescence();
  const end = performance.now();
  instrumentation.setRecording(false);
  const tasks = [...instrumentation.tasks];
  const sum = (label: TimedTask['label']): number =>
    tasks
      .filter((task) => task.label === label)
      .reduce((total, task) => total + (task.end - task.start), 0);
  const timed = (time: number): boolean =>
    (time >= start && time <= publishEnd) ||
    tasks.some((task) => time >= task.start && time <= task.end);
  const rendersByOwner: Record<string, Record<string, number>> = {};
  for (const [owner, names] of instrumentation.rendered()) {
    rendersByOwner[owner] = Object.fromEntries(names);
  }
  return {
    commits: instrumentation.commits - commitsBefore,
    commitsOutsideTimedWork: instrumentation.commitTimes.filter((time) => !timed(time)).length,
    deferredOtherMs: sum('other'),
    deferredSchedulerMs: sum('react-scheduler'),
    deferredTapMs: sum('assistant-ui/tap'),
    deferredTasks: tasks.length,
    end,
    publishSyncMs: publishEnd - start,
    reactMs: publishEnd - start + sum('react-scheduler') + sum('assistant-ui/tap') + sum('other'),
    rendersByOwner,
    start,
  };
}

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
  readonly publishRow: (length: number) => void;
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
 * recorded text-start, token and text-end rows, measuring each publication.
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
            () => handles.publishRow(TEXT_ROW[kind] + 1),
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
