import { MessageNotSentError } from '@assistant-ui/react';
import liveText from '@brainstrike/test-utils/fixtures/committed-approved-host-run-telemetry.json';
import { screen, waitFor } from '@testing-library/react';
import { Profiler, type ReactElement, useCallback, version } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  type CommittedAssistantSnapshot,
  type CommittedAssistantStore,
  selectCommittedAssistantMessage,
  selectCommittedAssistantTool,
} from '../../committed-assistant-store';
import { ToolFallback } from '../../tool-fallback';
import { ToolResultRendererProvider } from '../../tool-result-renderer-context';
import { useCommittedAssistantSelector } from '../../use-committed-assistant-runtime';
import type { ToolResultRenderer } from '../../use-tool-result-renderers';
import { PublishedConversation } from '../committed-assistant-test-support';
import { conversation, Surface } from '../committed-conversation-surface';
import { ATTRIBUTION_TRIALS, TRIALS } from '../committed-publication-config';
import {
  drainMicrotasks,
  nextFrame,
  type PublicationTiming,
  yieldTask,
} from '../committed-publication-instrumentation';
import {
  answerStepLength,
  CHILD_THREAD_ID,
  committedRows,
  RecordedCommittedSource,
  recordedBaseline,
  recordedChildPublications,
  recordedPrompt,
  recordedPromptId,
  recordedRunId,
  recordedStore,
  recordedToolCallId,
  recordedToolResult,
} from '../committed-recording-support';
import { instrumentation, measurePublication, waitForQuiescence } from './instrumentation';
import '@brainstrike/ui/globals.css';
import '../../overrides.css';
import '../assistant-conversation-panel.browser.css';

const COMPLETED_TEXT = 'Host run completed.';
type RenderCounts = Record<'approval' | 'prompt' | 'saved' | 'tool', number>;
function count<Key extends string>(counts: Record<Key, number>, key: Key): void {
  counts[key] += 1;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
const onNew = async () => {
  throw new MessageNotSentError('Thread already has an active root run');
};
function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(element));
  return {
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
      assert(!container.isConnected, 'Owned container remains after unmount');
    },
  };
}
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
function CountedSelector({
  store,
  select,
  onRender,
}: {
  readonly store: CommittedAssistantStore;
  readonly select: (snapshot: CommittedAssistantSnapshot) => unknown;
  readonly onRender: () => void;
}): null {
  useCommittedAssistantSelector(store, select);
  onRender();
  return null;
}

/** One shipped-selector subscriber per card/row, as BST-1929's "selector per card". */
function SelectorProbes({
  counts,
  savedId,
  store,
}: {
  readonly counts: RenderCounts;
  readonly savedId: string;
  readonly store: CommittedAssistantStore;
}): ReactElement {
  const saved = useCallback(
    (snapshot: CommittedAssistantSnapshot) => selectCommittedAssistantMessage(snapshot, savedId),
    [savedId]
  );
  return (
    <>
      <CountedSelector onRender={() => count(counts, 'saved')} select={saved} store={store} />
      <CountedSelector
        onRender={() => count(counts, 'prompt')}
        select={selectPrompt}
        store={store}
      />
      <CountedSelector onRender={() => count(counts, 'tool')} select={selectTool} store={store} />
      <CountedSelector
        onRender={() => count(counts, 'approval')}
        select={selectApproval}
        store={store}
      />
    </>
  );
}

const selectPrompt = (snapshot: CommittedAssistantSnapshot) =>
  selectCommittedAssistantMessage(snapshot, recordedPromptId);
const selectTool = (snapshot: CommittedAssistantSnapshot) =>
  selectCommittedAssistantTool(snapshot, recordedRunId, recordedToolCallId);
const selectApproval = (snapshot: CommittedAssistantSnapshot) => selectTool(snapshot)?.approval;

export async function run() {
  assert(!('_store' in <div />), 'Diagnostic did not build production React');
  const { baseline, saved } = await recordedBaseline();
  const [firstChild, ...childProgress] = await recordedChildPublications();
  assert(firstChild, 'Missing first actual child publication');
  const source = new RecordedCommittedSource();
  source.publishPrefix(committedRows.length);
  const warmStore = await recordedStore(source, baseline);
  const warm = mount(<Surface actions={{ onNew }} store={warmStore} />);
  await screen.findByText(COMPLETED_TEXT);
  warm.unmount();
  warmStore.dispose();
  instrumentation.assertInstalled();
  assert(PerformanceObserver.supportedEntryTypes.includes('longtask'), 'No long-task observer');
  const longTasks: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()));
  observer.observe({ type: 'longtask' });
  instrumentation.reset();
  instrumentation.setRecording(true);
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const started = performance.now();
      while (performance.now() - started < 80) {
        /* unchanged long-task control work */
      }
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
  await drainMicrotasks();
  await yieldTask();
  instrumentation.setRecording(false);
  const channelControl = [...instrumentation.tasks];
  assert(
    channelControl.some((task) => task.end - task.start >= 80),
    'Channel timing failed to include80ms control'
  );
  for (let i = 0; i < 3; i += 1) {
    await nextFrame();
  }
  longTasks.push(...observer.takeRecords());
  assert(longTasks.length > 0, 'Long-task positive control was not reported');
  const control = longTasks.map((entry) => entry.duration);
  longTasks.length = 0;
  const timings: PublicationTiming[] = [];
  const attribution: PublicationTiming[] = [];
  const childPhases = [];
  for (let trial = 0; trial < ATTRIBUTION_TRIALS + TRIALS; trial += 1) {
    const recorded = new RecordedCommittedSource();
    recorded.publishPrefix(answerStepLength);
    const store = await recordedStore(recorded, baseline);
    const childStore = new PublishedConversation(CHILD_THREAD_ID, [firstChild]);
    const counts: RenderCounts = { approval: 0, prompt: 0, saved: 0, tool: 0 };
    const views = { child: 0, root: 0, toolCard: 0 };
    const renderer: ToolResultRenderer = {
      Component: (props) => {
        views.toolCard += 1;
        return <ToolFallback {...props} />;
      },
      kind: 'committed-browser-counted-tool-card',
      matches: (result) => result === recordedToolResult,
    };
    const mounted = mount(
      <ToolResultRendererProvider renderers={[renderer]}>
        <SelectorProbes counts={counts} savedId={saved.id} store={store} />
        <Profiler id="root" onRender={() => count(views, 'root')}>
          <Surface actions={{ onNew }} height={420} label="Root" store={store} />
        </Profiler>
        <Profiler id="child" onRender={() => count(views, 'child')}>
          <Surface actions={{ onNew }} height={320} label="Child" store={childStore} />
        </Profiler>
      </ToolResultRendererProvider>
    );
    try {
      const root = conversation('Root');
      await root.ui.findByText(recordedPrompt);
      await waitFor(() => assert(views.toolCard > 0, 'Tool card did not render'));
      await settleAnimations(document.body);
      const answer = root.viewport.querySelector(`[data-message-id="${recordedRunId}"]`);
      assert(answer, 'Missing actual recorded answer');
      const savedRow = root.viewport.querySelector(`[data-message-id="${saved.id}"]`);
      const promptRow = root.viewport.querySelector(`[data-message-id="${recordedPromptId}"]`);
      assert(savedRow && promptRow, 'Missing actual recorded saved/prompt rows');
      const beforeChild = { ...counts };
      const commitsBeforeChild = instrumentation.commits;
      for (const publication of childProgress) {
        childStore.replaceMessage(publication);
        await drainMicrotasks();
        await yieldTask();
      }
      await waitForQuiescence();
      assert(
        JSON.stringify(counts) === JSON.stringify(beforeChild),
        'Child changed root selectors'
      );
      assert(
        instrumentation.commits > commitsBeforeChild,
        'Actual child publications rendered no commits'
      );
      assert(views.child === 0 && views.root === 0, 'Production Profiler unexpectedly enabled');
      childPhases.push({ profilerCallbacks: { ...views }, publications: childProgress.length });
      for (const chunk of liveText) {
        const unrelated = watchUnchanged({
          composer: root.ui.getByTestId('assistant-composer-shell'),
          prompt: promptRow,
          saved: savedRow,
          toolCard: root.ui.getByTestId('tool-fallback'),
        });
        const before = { ...counts };
        const toolBefore = views.toolCard;
        const timing = await measurePublication(
          () => store.acceptTelemetry(chunk.runId, chunk.chunk),
          trial < ATTRIBUTION_TRIALS
        );
        const unrelatedDom = unrelated.read();
        unrelated.stop();
        assert(unrelatedDom.length === 0, 'Text mutated unrelated DOM');
        assert(
          JSON.stringify(counts) === JSON.stringify(before),
          'Text changed unrelated selectors'
        );
        assert(views.toolCard === toolBefore, 'Text rerendered the tool card');
        assert(
          timing.commitsOutsideTimedWork === 0,
          'A production commit escaped the timed interval'
        );
        if (chunk.chunk.type === 'text-delta') {
          assert(timing.commits > 0, 'No production commit was observed for the actual token');
          assert(timing.deferredTasks > 0, 'No deferred channel task observed for actual token');
          if (trial < ATTRIBUTION_TRIALS) {
            assert(
              Object.hasOwn(timing.rendersByOwner, recordedRunId),
              'Attribution missed the actual streaming row'
            );
            assert(!Object.hasOwn(timing.rendersByOwner, saved.id), 'Token rendered saved row');
            assert(
              !Object.hasOwn(timing.rendersByOwner, recordedPromptId),
              'Token rendered prompt row'
            );
          }
          (trial < ATTRIBUTION_TRIALS ? attribution : timings).push(timing);
        }
      }
      assert(answer.textContent?.includes(COMPLETED_TEXT), 'Actual token never became visible');
    } finally {
      mounted.unmount();
      store.dispose();
    }
  }
  longTasks.push(...observer.takeRecords());
  observer.disconnect();
  assert(timings.length === TRIALS, 'Expected the unchanged40 measured trials');
  const values = timings.map((timing) => timing.reactMs).sort((left, right) => left - right);
  const p95 = values[Math.ceil(values.length * 0.95) - 1];
  assert(p95 !== undefined, 'Missing p95');
  return {
    attribution,
    browser: navigator.userAgent,
    channelControl,
    childPhases,
    control,
    limit: 8,
    longTasks: longTasks.map((task) => ({ duration: task.duration, startTime: task.startTime })),
    methodology: 'all-instrumented-message-channel-tasks',
    p95,
    passed: p95 <= 8,
    production: true,
    react: version,
    timings,
    viewport: {
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      width: window.innerWidth,
    },
    visibility: document.visibilityState,
  };
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
