/**
 * BST-1929 production-React benchmark of the shipped committed conversation.
 *
 * Built by `vite.committed-benchmark.config.mts` with React's production build
 * and minification, then driven in Chromium. It mounts the same shipped
 * components over the same recorded captures as Packet B's development suite,
 * but through native `createRoot`: no Testing Library `act` (absent from
 * production React), no Profiler counters, no render attribution (that stays in
 * the functional suite).
 *
 * TIMED INTERVAL (spike s-ui, as in committed-assistant-browser-support.ts):
 * the publication plus a 20-microtask drain, plus every MessageChannel task the
 * publication caused, each timed from handler entry to 20 microtask hops
 * later, until two consecutive quiet animation frames (each followed by a
 * task). Idle time is excluded.
 *
 * COVERAGE CORRECTION (BST-1929 review, support.ts ~775–813): there, any
 * MessageChannel slice covered a commit, including "other" slices that its
 * `reactMs` never charged. Here a commit is covered ONLY by a window that is
 * charged: the publication window or a MessageChannel slice. Every other
 * asynchronous callback the page can run (animation frames, timers, event
 * listeners, Resize/Intersection/Mutation observers) is also wrapped and
 * timed, so a commit landing in one of them is reported as uncharged work,
 * and a commit in no wrapped callback at all is reported as unmeasured.
 * Neither is ever counted as covered. Handler names are minified in this
 * bundle, so React's Scheduler port is identified by behaviour (a probe
 * transition), never by name.
 *
 * EVALUATING THIS MODULE MUST NOT LOAD react-dom OR ITS SCHEDULER before the
 * instrumentation below is installed: React DOM, the components and the
 * captures' decoders are loaded by `import()` after it.
 */
import type { ThreadMessage } from '@assistant-ui/react';
import type { ReactElement } from 'react';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import type { CommittedAssistantStore } from '../committed-assistant-store';
import childRecording from './fixtures/child-continuation-native-wire.json';
import recording from './fixtures/committed-approved-host-run.json';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

// ---- Settings (unchanged from Packet B's development suite) ----

const GATE_MS = 8;
const TRIALS = 40;
const DRAIN_HOPS = 20;
const QUIET_FRAMES = 2;
/** A publication that never goes quiet is a harness failure, not a sample. */
const MAX_SETTLE_FRAMES = 600;
const COMPLETED_TEXT = 'Host run completed.';
const TEXT_KINDS = ['text-start', 'text-delta', 'text-end'] as const;
type TextKind = (typeof TEXT_KINDS)[number];
const VARIANTS = ['unwrapped', 'flushSync'] as const;
type Variant = (typeof VARIANTS)[number];

// ---- Instrumentation, installed before React DOM loads ----

type SliceSource =
  | 'animation-frame'
  | 'event-listener'
  | 'message-channel'
  | 'mutation-observer'
  | 'observer'
  | 'timer';

interface Slice {
  end: number;
  readonly port: number | undefined;
  readonly source: SliceSource;
  readonly start: number;
}

interface ProbeState {
  commitTimes: number[];
  depth: number;
  recording: boolean;
  readonly renderers: unknown[];
  slices: Slice[];
}

const probe: ProbeState = {
  commitTimes: [],
  depth: 0,
  recording: false,
  renderers: [],
  slices: [],
};
const now = (): number => performance.now();
const NativeMessageChannel = globalThis.MessageChannel;
const nativeQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
const nativeRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);

function closeAfterHops(slice: Slice): void {
  let hops = 0;
  const hop = (): void => {
    hops += 1;
    if (hops < DRAIN_HOPS) {
      nativeQueueMicrotask(hop);
      return;
    }
    slice.end = now();
    probe.slices.push(slice);
  };
  nativeQueueMicrotask(hop);
}

/** Times one asynchronous callback; nested (synchronously dispatched) ones belong to their parent. */
function timed<T>(source: SliceSource, port: number | undefined, run: () => T): T {
  if (!probe.recording || probe.depth > 0) {
    probe.depth += 1;
    try {
      return run();
    } finally {
      probe.depth -= 1;
    }
  }
  const slice: Slice = { end: Number.NaN, port, source, start: now() };
  probe.depth += 1;
  try {
    return run();
  } finally {
    probe.depth -= 1;
    closeAfterHops(slice);
  }
}

type Listener = EventListenerOrEventListenerObject;
function invokeListener(target: EventTarget, listener: Listener, event: Event): unknown {
  return typeof listener === 'function'
    ? listener.call(target, event)
    : listener.handleEvent(event);
}

let nextPortId = 0;
const portIds = new WeakMap<MessagePort, number>();
function instrumentPort(port: MessagePort): void {
  nextPortId += 1;
  portIds.set(port, nextPortId);
  const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  const setNative = descriptor?.set;
  const getNative = descriptor?.get;
  if (!(setNative && getNative)) {
    throw new Error('MessagePort.prototype.onmessage is not an accessor in this browser.');
  }
  Object.defineProperty(port, 'onmessage', {
    configurable: true,
    get(this: MessagePort) {
      return getNative.call(this);
    },
    set(this: MessagePort, handler: ((event: MessageEvent) => unknown) | null) {
      if (typeof handler !== 'function') {
        setNative.call(this, handler);
        return;
      }
      setNative.call(this, function onTimedMessage(this: MessagePort, event: MessageEvent) {
        return timed('message-channel', portIds.get(this), () => handler.call(this, event));
      });
    },
  });
}

function installInstrumentation(): void {
  const hookGlobal = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
  if (hookGlobal.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== undefined) {
    throw new Error('A React DevTools hook is already installed; commit times would be ambiguous.');
  }
  // React DOM reports every committed root to this hook in production builds too.
  hookGlobal.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    checkDCE: () => undefined,
    inject: (renderer: unknown): number => probe.renderers.push(renderer),
    onCommitFiberRoot: (): void => {
      if (probe.recording) {
        probe.commitTimes.push(now());
      }
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onScheduleFiberRoot: () => undefined,
    renderers: new Map(),
    setStrictMode: () => undefined,
    supportsFiber: true,
  };

  globalThis.MessageChannel = class TimedMessageChannel extends NativeMessageChannel {
    constructor() {
      super();
      instrumentPort(this.port1);
      instrumentPort(this.port2);
    }
  };

  globalThis.requestAnimationFrame = (callback) =>
    nativeRequestAnimationFrame((time) =>
      timed('animation-frame', undefined, () => callback(time))
    );

  // The DOM signature; the package's test program also loads Node's timer types.
  type BrowserTimer = (handler: TimerHandler, delay?: number, ...args: unknown[]) => number;
  const timer =
    (native: BrowserTimer): BrowserTimer =>
    (handler, delay, ...args) =>
      typeof handler === 'function'
        ? native(() => timed('timer', undefined, () => handler(...args)), delay)
        : native(handler, delay, ...args);
  const timers = globalThis as unknown as { setInterval: BrowserTimer; setTimeout: BrowserTimer };
  timers.setTimeout = timer(timers.setTimeout.bind(globalThis));
  timers.setInterval = timer(timers.setInterval.bind(globalThis));

  const wrappedListeners = new WeakMap<object, Map<string, Listener>>();
  const listenerKey = (type: string, options?: boolean | EventListenerOptions): string =>
    `${type}:${typeof options === 'boolean' ? options : Boolean(options?.capture)}`;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function addTimedListener(
    this: EventTarget,
    type: string,
    listener: Listener | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (!listener) {
      nativeAdd.call(this, type, listener, options);
      return;
    }
    const byKey = wrappedListeners.get(listener) ?? new Map<string, Listener>();
    wrappedListeners.set(listener, byKey);
    const key = listenerKey(type, options);
    const wrapped =
      byKey.get(key) ??
      function onTimedEvent(this: EventTarget, event: Event) {
        return timed('event-listener', undefined, () => invokeListener(this, listener, event));
      };
    byKey.set(key, wrapped);
    nativeAdd.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function removeTimedListener(
    this: EventTarget,
    type: string,
    listener: Listener | null,
    options?: boolean | EventListenerOptions
  ): void {
    const wrapped = listener
      ? wrappedListeners.get(listener)?.get(listenerKey(type, options))
      : undefined;
    nativeRemove.call(this, type, wrapped ?? listener, options);
  };

  const NativeResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class TimedResizeObserver extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => timed('observer', undefined, () => callback(entries, observer)));
    }
  };
  const NativeIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class TimedIntersectionObserver extends (
    NativeIntersectionObserver
  ) {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      super(
        (entries, observer) => timed('observer', undefined, () => callback(entries, observer)),
        options
      );
    }
  };
  const NativeMutationObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class TimedMutationObserver extends NativeMutationObserver {
    constructor(callback: MutationCallback) {
      super((records, observer) =>
        timed('mutation-observer', undefined, () => callback(records, observer))
      );
    }
  };
}

installInstrumentation();

// ---- Harness primitives on uninstrumented native channels and frames ----

function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new NativeMessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

async function drainMicrotasks(): Promise<void> {
  for (let hop = 0; hop < DRAIN_HOPS; hop += 1) {
    await Promise.resolve();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    nativeRequestAnimationFrame(() => resolve());
  });
}

/** Two consecutive frames, each followed by a task, with no new commit and no new slice. */
async function waitForQuiescence(): Promise<void> {
  let quiet = 0;
  for (let frame = 0; quiet < QUIET_FRAMES; frame += 1) {
    if (frame >= MAX_SETTLE_FRAMES) {
      const sources: Record<string, number> = {};
      for (const slice of probe.slices.slice(-50)) {
        const key = `${slice.source}${slice.port === undefined ? '' : `#${slice.port}`}`;
        sources[key] = (sources[key] ?? 0) + 1;
      }
      throw new Error(
        `A publication never went quiet; no sample was taken. Last slices: ${JSON.stringify(sources)}, commits ${probe.commitTimes.length}.`
      );
    }
    const commits = probe.commitTimes.length;
    const slices = probe.slices.length;
    await nextFrame();
    await yieldTask();
    quiet = probe.commitTimes.length === commits && probe.slices.length === slices ? quiet + 1 : 0;
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let frame = 0; !condition(); frame += 1) {
    if (frame >= MAX_SETTLE_FRAMES) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await nextFrame();
  }
}

/** Finite CSS animations/transitions must finish before a sample (as in Packet B's suite). */
async function settleAnimations(root: Element): Promise<void> {
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
    await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    await nextFrame();
  }
  throw new Error('Finite animations kept restarting under the measured element.');
}

/** Nearest-rank percentile of a non-empty sample (as in Packet B's suite). */
function percentile(values: readonly number[], rank: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)];
  if (value === undefined) {
    throw new Error('A percentile needs at least one sample.');
  }
  return value;
}

// ---- Measurement with charged-only coverage ----

interface Window_ {
  readonly end: number;
  readonly start: number;
}

/** Total length of the union of intervals, minus any part inside `charged`. */
function exclusiveMs(intervals: readonly Window_[], charged: readonly Window_[]): number {
  const points = [...intervals, ...charged].flatMap(({ end, start }) => [start, end]);
  const cuts = [...new Set(points)].sort((left, right) => left - right);
  let total = 0;
  for (let index = 1; index < cuts.length; index += 1) {
    const from = cuts[index - 1] ?? 0;
    const to = cuts[index] ?? 0;
    const middle = (from + to) / 2;
    const inside = (list: readonly Window_[]): boolean =>
      list.some(({ end, start }) => middle >= start && middle <= end);
    if (inside(intervals) && !inside(charged)) {
      total += to - from;
    }
  }
  return total;
}

export interface Sample {
  readonly chargedMessageChannelMs: number;
  readonly commits: number;
  /** In the publication window or a charged MessageChannel slice. */
  readonly commitsCovered: number;
  /** Inside a wrapped callback that `reactMs` does not charge. */
  readonly commitsInUnchargedCallbacks: number;
  /** In no wrapped callback at all. */
  readonly commitsUnmeasured: number;
  readonly messageChannelTasks: number;
  readonly otherMessageChannelMs: number;
  readonly publishSyncMs: number;
  /** The gated value: publication window + every MessageChannel slice. */
  readonly reactMs: number;
  readonly schedulerMs: number;
  readonly schedulerTasks: number;
  readonly slices: readonly {
    readonly ms: number;
    readonly port?: number;
    readonly source: SliceSource;
  }[];
  readonly unchargedCallbackMs: Readonly<Record<string, number>>;
  /** Wrapped-callback time outside every charged window (not in `reactMs`). */
  readonly unchargedExclusiveMs: number;
}

let schedulerPort: number | undefined;

async function measurePublication(publish: () => void): Promise<Sample> {
  probe.commitTimes = [];
  probe.slices = [];
  probe.recording = true;
  const start = now();
  publish();
  await drainMicrotasks();
  const publishEnd = now();
  await waitForQuiescence();
  probe.recording = false;
  const slices = [...probe.slices];
  const commitTimes = [...probe.commitTimes];
  const channel = slices.filter((slice) => slice.source === 'message-channel');
  const uncharged = slices.filter((slice) => slice.source !== 'message-channel');
  const charged: Window_[] = [{ end: publishEnd, start }, ...channel];
  const within = (time: number, list: readonly Window_[]): boolean =>
    list.some(({ end, start: from }) => time >= from && time <= end);
  const covered = commitTimes.filter((time) => within(time, charged)).length;
  const inUncharged = commitTimes.filter(
    (time) => !within(time, charged) && within(time, uncharged)
  ).length;
  const duration = ({ end, start: from }: Window_): number => end - from;
  const sum = (list: readonly Window_[]): number =>
    list.reduce((total, slice) => total + duration(slice), 0);
  const scheduler = channel.filter((slice) => slice.port === schedulerPort);
  const bySource: Record<string, number> = {};
  for (const slice of uncharged) {
    bySource[slice.source] = (bySource[slice.source] ?? 0) + duration(slice);
  }
  const chargedMessageChannelMs = sum(channel);
  return {
    chargedMessageChannelMs,
    commits: commitTimes.length,
    commitsCovered: covered,
    commitsInUnchargedCallbacks: inUncharged,
    commitsUnmeasured: commitTimes.length - covered - inUncharged,
    messageChannelTasks: channel.length,
    otherMessageChannelMs: chargedMessageChannelMs - sum(scheduler),
    publishSyncMs: publishEnd - start,
    reactMs: publishEnd - start + chargedMessageChannelMs,
    schedulerMs: sum(scheduler),
    schedulerTasks: scheduler.length,
    slices: slices.map((slice) => ({
      ms: duration(slice),
      source: slice.source,
      ...(slice.port === undefined ? {} : { port: slice.port }),
    })),
    unchargedCallbackMs: bySource,
    unchargedExclusiveMs: exclusiveMs(uncharged, charged),
  };
}

// ---- Recorded workload (the same captures and identities as Packet B's suite) ----

const committedRows: readonly CommittedAssistantLogRow[] = recording;

function eventIndex(type: string, chunk?: string): number {
  const index = committedRows.findIndex(
    ({ event }) =>
      event['type'] === type &&
      (chunk === undefined || (event['chunk'] as { readonly type?: unknown })?.type === chunk)
  );
  if (index < 0) {
    throw new Error(`The committed recording has no ${chunk ?? type} row.`);
  }
  return index;
}

const started = committedRows[eventIndex('run.started')];
const accepted = committedRows.find(
  ({ event }) => event['type'] === 'command.accepted' && event['method'] === 'run/start'
);
const runId = started?.event['runId'];
const promptId = accepted?.event['commandId'];
if (!started || typeof runId !== 'string' || typeof promptId !== 'string') {
  throw new Error('The committed recording is missing its run or prompt identity.');
}
const RUN_ID: string = runId;
const PROMPT_ID: string = promptId;
const THREAD_ID: string = started.threadId;
const PROMPT = String(started.event['prompt']);
const tokenIndex = eventIndex('stream.chunk', 'text-delta');
const TEXT_ROW: Readonly<Record<TextKind, number>> = {
  'text-delta': tokenIndex,
  'text-end': tokenIndex + 1,
  'text-start': tokenIndex - 1,
};
if (eventIndex('stream.chunk', 'text-start') !== TEXT_ROW['text-start']) {
  throw new Error('The committed recording no longer has the expected publication order.');
}

/** Passive publication of a recorded committed prefix; the production store folds it. */
class RecordedPrefix {
  private length = 0;
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = () => ({
    connected: true,
    error: undefined,
    rows: committedRows.slice(0, this.length),
  });
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish(length: number): void {
    this.length = length;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * React DOM ships no types and this package declares none (manifests are out of
 * this benchmark's scope), so the two members it uses are typed here.
 */
interface ReactDomApi {
  readonly flushSync: (run: () => void) => void;
}
interface ReactDomClientApi {
  readonly createRoot: (container: Element) => {
    readonly render: (node: ReactElement) => void;
    readonly unmount: () => void;
  };
}

async function loadWorkload() {
  const [react, reactDomModule, clientModule, ui, conversation, logStore, support, vendor, stream] =
    await Promise.all([
      import('react'),
      // @ts-expect-error TS7016: react-dom is untyped in this package (see ReactDomApi).
      import('react-dom'),
      // @ts-expect-error TS7016: react-dom is untyped in this package (see ReactDomClientApi).
      import('react-dom/client'),
      import('@brainstrike/ui'),
      import('../committed-assistant-conversation'),
      import('../committed-assistant-log-store'),
      import('./committed-assistant-test-support'),
      import('@assistant-ui/react'),
      import('assistant-stream'),
    ]);
  const saved = await support.recordedMessage();
  const baseline = { headId: saved.id, messages: [{ message: saved, parentId: null }] };
  const response = new Response(childRecording.lines.join(''));
  if (!response.body) {
    throw new Error('Missing recorded child response body.');
  }
  const childPublications: ThreadMessage[] = [];
  for await (const snapshot of response.body
    .pipeThrough(new stream.DataStreamDecoder())
    .pipeThrough(new stream.AssistantMessageAccumulator())) {
    childPublications.push(
      vendor.fromThreadMessageLike(
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
  const reactDom = reactDomModule as ReactDomApi;
  const client = clientModule as ReactDomClientApi;
  const [firstChild, ...childProgress] = childPublications;
  if (!firstChild || childProgress.length === 0) {
    throw new Error('The child recording must publish progress more than once.');
  }
  const onNew = async (): Promise<void> => {
    throw new vendor.MessageNotSentError('Thread already has an active root run');
  };
  const rootStore = (source: RecordedPrefix) =>
    new logStore.CommittedAssistantLogStore({
      baseline,
      identifyRun: () => ({
        assistantMessageId: RUN_ID,
        createdAt: new Date('2026-10-06T08:16:33.838Z'),
        metadata: { custom: { hostRunId: RUN_ID } },
        parentMessageId: baseline.headId,
        userMessageId: PROMPT_ID,
      }),
      source,
      threadId: THREAD_ID,
    });
  const surface = (store: CommittedAssistantStore, label: string, height: number): ReactElement => (
    <div style={{ height, width: 900 }}>
      <conversation.CommittedAssistantConversation
        commands={{ onNew }}
        label={label}
        store={store}
      />
    </div>
  );
  return {
    childProgress,
    childStore: () => new support.PublishedConversation('child', [firstChild]),
    createRoot: client.createRoot,
    flushSync: reactDom.flushSync,
    react,
    rootStore,
    surface,
    TooltipProvider: ui.TooltipProvider,
  };
}
type Workload = Awaited<ReturnType<typeof loadWorkload>>;

function mountContainer(): HTMLElement {
  const host = document.getElementById('benchmark');
  if (!host) {
    throw new Error('The benchmark entry has no #benchmark element.');
  }
  const container = document.createElement('div');
  host.append(container);
  return container;
}

/** Identify React's Scheduler port by behaviour: a transition is always Scheduler work. */
async function identifySchedulerPort(workload: Workload): Promise<number> {
  const container = mountContainer();
  const root = workload.createRoot(container);
  probe.slices = [];
  probe.recording = true;
  workload.react.startTransition(() => {
    root.render(<span>probe</span>);
  });
  await waitForQuiescence();
  probe.recording = false;
  root.unmount();
  container.remove();
  const ports = new Set(
    probe.slices.flatMap((slice) => (slice.source === 'message-channel' ? [slice.port] : []))
  );
  const [port] = ports;
  if (ports.size !== 1 || port === undefined) {
    throw new Error(`Expected exactly one Scheduler port, observed ${ports.size}.`);
  }
  return port;
}

interface CoverageControls {
  /** A transition commit: Scheduler work, must read covered. */
  readonly scheduler: Pick<Sample, 'commits' | 'commitsCovered'>;
  /** A commit inside a wrapped animation frame: must read uncharged, never covered. */
  readonly unchargedFrame: Pick<Sample, 'commits' | 'commitsInUnchargedCallbacks'>;
  /** A commit inside an unwrapped frame: must read unmeasured, never covered. */
  readonly unwrappedFrame: Pick<Sample, 'commits' | 'commitsUnmeasured'>;
}

/** Positive controls proving, on this built bundle, that the classifier detects uncovered commits. */
async function coverageControls(workload: Workload): Promise<CoverageControls> {
  const container = mountContainer();
  const root = workload.createRoot(container);
  const commitFrom = (schedule: (callback: () => void) => void, label: string) => (): void => {
    schedule(() => workload.flushSync(() => root.render(<span>{label}</span>)));
  };
  const scheduler = await measurePublication(() =>
    workload.react.startTransition(() => root.render(<span>transition</span>))
  );
  const unchargedFrame = await measurePublication(
    commitFrom((callback) => requestAnimationFrame(callback), 'wrapped frame')
  );
  const unwrappedFrame = await measurePublication(
    commitFrom((callback) => nativeRequestAnimationFrame(callback), 'unwrapped frame')
  );
  root.unmount();
  container.remove();
  const controls: CoverageControls = {
    scheduler: { commits: scheduler.commits, commitsCovered: scheduler.commitsCovered },
    unchargedFrame: {
      commits: unchargedFrame.commits,
      commitsInUnchargedCallbacks: unchargedFrame.commitsInUnchargedCallbacks,
    },
    unwrappedFrame: {
      commits: unwrappedFrame.commits,
      commitsUnmeasured: unwrappedFrame.commitsUnmeasured,
    },
  };
  if (
    !(
      scheduler.commits === 1 &&
      scheduler.commitsCovered === 1 &&
      unchargedFrame.commits === 1 &&
      unchargedFrame.commitsInUnchargedCallbacks === 1 &&
      unwrappedFrame.commits === 1 &&
      unwrappedFrame.commitsUnmeasured === 1
    )
  ) {
    throw new Error(`Coverage controls were misclassified: ${JSON.stringify(controls)}.`);
  }
  return controls;
}

async function mountTrial(workload: Workload, fullRecording: boolean) {
  const source = new RecordedPrefix();
  source.publish(fullRecording ? committedRows.length : TEXT_ROW['text-start']);
  const store = workload.rootStore(source);
  const childStore = workload.childStore();
  const container = mountContainer();
  const root = workload.createRoot(container);
  const { TooltipProvider } = workload;
  root.render(
    <TooltipProvider>
      {workload.surface(store, 'Root', 420)}
      {workload.surface(childStore, 'Child', 320)}
    </TooltipProvider>
  );
  const region = (): Element | null => container.querySelector('section[aria-label="Root"]');
  await waitFor(
    () =>
      Boolean(region()?.querySelector('[data-testid="tool-fallback"]')) &&
      Boolean(region()?.textContent?.includes(PROMPT)),
    'the recorded root conversation'
  );
  await settleAnimations(container);
  return {
    childStore,
    container,
    region,
    source,
    unmount: () => {
      root.unmount();
      container.remove();
      store.dispose();
    },
  };
}

interface Result {
  readonly config: Record<string, unknown>;
  readonly coverageControls: CoverageControls;
  readonly react: {
    readonly actExported: boolean;
    readonly build: string;
    readonly version: string;
  };
  readonly samples: Record<Variant, Record<TextKind, Sample[]>>;
  readonly schedulerPort: number;
  readonly summary: Record<string, unknown>;
  readonly userAgent: string;
}

function summarize(samples: Result['samples']) {
  const summary: Record<string, unknown> = {};
  for (const variant of VARIANTS) {
    for (const kind of TEXT_KINDS) {
      const list = samples[variant][kind];
      const values = list.map((sample) => sample.reactMs);
      summary[`${variant} ${kind}`] = {
        commitsCovered: list.reduce((total, sample) => total + sample.commitsCovered, 0),
        commitsInUnchargedCallbacks: list.reduce(
          (total, sample) => total + sample.commitsInUnchargedCallbacks,
          0
        ),
        commitsTotal: list.reduce((total, sample) => total + sample.commits, 0),
        commitsUnmeasured: list.reduce((total, sample) => total + sample.commitsUnmeasured, 0),
        max: Math.max(...values),
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        samples: values.length,
        schedulerTasksMin: Math.min(...list.map((sample) => sample.schedulerTasks)),
        unchargedExclusiveMsP95: percentile(
          list.map((sample) => sample.unchargedExclusiveMs),
          95
        ),
      };
    }
  }
  return summary;
}

async function run(): Promise<Result> {
  const workload = await loadWorkload();
  if (probe.renderers.length === 0) {
    throw new Error('React DOM did not report to the commit hook; commit coverage is unavailable.');
  }
  const element = workload.react.createElement('div') as object;
  const react = {
    actExported: typeof (workload.react as { act?: unknown }).act === 'function',
    build: '_store' in element ? 'development' : 'production',
    version: workload.react.version,
  };
  if (react.build !== 'production' || react.actExported) {
    throw new Error(`Expected production React, found ${JSON.stringify(react)}.`);
  }
  schedulerPort = await identifySchedulerPort(workload);
  const controls = await coverageControls(workload);

  // Unmeasured warm-up: resolve the lazily loaded markdown renderer once.
  const warm = await mountTrial(workload, true);
  await waitFor(
    () => Boolean(warm.region()?.textContent?.includes(COMPLETED_TEXT)),
    'the warm-up answer'
  );
  warm.unmount();

  const samples = {
    flushSync: { 'text-delta': [], 'text-end': [], 'text-start': [] },
    unwrapped: { 'text-delta': [], 'text-end': [], 'text-start': [] },
  } as Result['samples'];
  // Interleaved so drift lands on both variants equally.
  for (let trial = 0; trial < TRIALS * VARIANTS.length; trial += 1) {
    const variant = VARIANTS[trial % VARIANTS.length] ?? 'unwrapped';
    const handles = await mountTrial(workload, false);
    for (const publication of workload.childProgress) {
      handles.childStore.replaceMessage(publication);
      await drainMicrotasks();
      await yieldTask();
    }
    await waitForQuiescence();
    for (const kind of TEXT_KINDS) {
      const publish = (): void => handles.source.publish(TEXT_ROW[kind] + 1);
      samples[variant][kind].push(
        await measurePublication(
          variant === 'flushSync' ? () => workload.flushSync(publish) : publish
        )
      );
    }
    if (!handles.region()?.textContent?.includes(COMPLETED_TEXT)) {
      throw new Error('The recorded token never became visible.');
    }
    handles.unmount();
  }
  return {
    config: {
      drainHops: DRAIN_HOPS,
      gateMs: GATE_MS,
      quietFrames: QUIET_FRAMES,
      trialsPerVariant: TRIALS,
      viewport: { height: window.innerHeight, width: window.innerWidth },
      warmUp: true,
    },
    coverageControls: controls,
    react,
    samples,
    schedulerPort,
    summary: summarize(samples),
    userAgent: navigator.userAgent,
  };
}

type BenchmarkState =
  | { readonly status: 'running' }
  | { readonly result: Result; readonly status: 'done' }
  | { readonly error: string; readonly status: 'failed' };

declare global {
  interface Window {
    __COMMITTED_BENCHMARK__?: BenchmarkState;
    /** Exposed by the runner (a CDP binding): completion is pushed, never polled. */
    __committedBenchmarkReport?: (state: string) => void;
  }
}

function settle(state: BenchmarkState): void {
  window.__COMMITTED_BENCHMARK__ = state;
  window.__committedBenchmarkReport?.(JSON.stringify(state));
}

settle({ status: 'running' });
run().then(
  (result) => settle({ result, status: 'done' }),
  (error: unknown) =>
    settle({
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      status: 'failed',
    })
);
