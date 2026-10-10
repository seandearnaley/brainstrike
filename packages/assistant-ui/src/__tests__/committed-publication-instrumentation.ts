/** Installs before React DOM loads. Production counts every channel task, because
 * minified vendor handler names cannot identify Scheduler/tap work. The named
 * development mode preserves the original diagnostic and attribution tests. */
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
  /** Publication plus vendor tasks in development, every channel task in production. */
  readonly reactMs: number;
  readonly rendersByOwner: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly start: number;
}

const NativeMessageChannel = globalThis.MessageChannel;

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

export function createPublicationInstrumentation(mode: 'named-vendor' | 'all-channels') {
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
    throw new Error(
      'A React DevTools hook is already installed; render counts would be ambiguous.'
    );
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
  const onmessageProperty = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  const nativeSetOnmessage = onmessageProperty?.set;
  const nativeGetOnmessage = onmessageProperty?.get;
  if (!(nativeSetOnmessage && nativeGetOnmessage)) {
    throw new Error('MessagePort.prototype.onmessage is not an accessor in this browser.');
  }
  type PortHandler = (this: MessagePort, event: MessageEvent) => unknown;

  function labelOf(handler: PortHandler): TimedTask['label'] {
    if (mode === 'all-channels') {
      return 'other';
    }
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

  const instrumentation = {
    /** Fails loudly unless React DOM and its Scheduler loaded AFTER installation. */
    assertInstalled(): void {
      if (state.renderers.size === 0) {
        throw new Error(
          'React DOM loaded before the DevTools hook; render counts are unavailable.'
        );
      }
      if (mode === 'named-vendor' && !state.handlerLabels.has('react-scheduler')) {
        throw new Error('The React Scheduler channel was created before instrumentation.');
      }
      if (state.handlerLabels.size === 0) {
        throw new Error('No MessageChannel handler was instrumented.');
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

  /** Two consecutive animation frames, each followed by a task, with no new commit or timed task. */
  async function waitForQuiescence(): Promise<void> {
    for (let quiet = 0; quiet < 2; ) {
      const commits = instrumentation.commits;
      const tasks = instrumentation.tasks.length;
      await nextFrame();
      await yieldTask();
      quiet =
        instrumentation.commits === commits && instrumentation.tasks.length === tasks
          ? quiet + 1
          : 0;
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
   * Production counts all instrumented channel tasks, a strict superset of the
   * named development Scheduler/tap slices. Publication stays unwrapped: every
   * update it causes is a useSyncExternalStore update, rendered on the sync lane in
   * the microtask the drain covers. That is also the owner's production path.
   * `commitsOutsideTimedWork` proves no commit escaped the timed slices.
   */
  async function measurePublication(
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
      reactMs:
        publishEnd -
        start +
        sum('react-scheduler') +
        sum('assistant-ui/tap') +
        (mode === 'all-channels' ? sum('other') : 0),
      rendersByOwner,
      start,
    };
  }

  return { instrumentation, measurePublication, waitForQuiescence };
}
