import liveText from '@brainstrike/test-utils/fixtures/committed-approved-host-run-telemetry.json';
import { Profiler, type ProfilerOnRenderCallback, type ReactElement, version } from 'react';
import { flushSync } from 'react-dom';
// The perf page's Vite config resolves this to React DOM's profiling build, so
// <Profiler> reports actualDuration in a production bundle.
import { createRoot } from 'react-dom/client';
import { conversation, Surface } from '../committed-conversation-surface';
import {
  answerStepLength,
  RecordedCommittedSource,
  recordedBaseline,
  recordedPrompt,
  recordedRunId,
  recordedStore,
} from '../committed-recording-support';
import { LONG_REPLY_TOKENS } from '../long-markdown-reply';
import { instrumentation, waitForQuiescence } from './instrumentation';
import '@brainstrike/ui/globals.css';
import '../../overrides.css';
import '../assistant-conversation-panel.browser.css';

/** Tokens measured one at a time in each window. */
const WINDOW_TOKENS = 40;
export type WindowLabel = '10%' | '50%' | '100%';

export interface WindowMeasurement {
  /** React `actualDuration` of every commit of the conversation while the window's tokens landed. */
  readonly commitDurations: readonly number[];
  /** Commits each token caused anywhere in the page. */
  readonly commitsPerToken: readonly number[];
}

/**
 * The recorded run's live text chunk of `type`. Read from the fixture directly:
 * committed-live-text-support imports the development instrumentation, which
 * would install a second React DevTools hook in this page.
 */
function recordedChunk(type: 'text-delta' | 'text-start') {
  const entry = liveText.find(({ chunk }) => chunk.type === type);
  if (!entry || entry.runId !== recordedRunId) {
    throw new Error(`The recorded telemetry has no ${type} chunk for the recorded run.`);
  }
  return entry.chunk;
}

function mount(element: ReactElement): void {
  const container = document.createElement('div');
  document.body.append(container);
  flushSync(() => createRoot(container).render(element));
}

/**
 * BST-1929 advisory perf lane: stream the long reply through the recorded run's
 * text-delta chunk and record the conversation's commit durations for 40 tokens
 * at 10%, 50% and 100% of it. The runner throttles the page's CPU over CDP.
 * Token completion is two quiet frames: the reveal (Streamdown `animated`) runs
 * in CSS and adds no frame-paced commits.
 */
export async function run(): Promise<{
  readonly react: string;
  readonly tokens: number;
  readonly windows: Readonly<Record<WindowLabel, WindowMeasurement>>;
}> {
  instrumentation.assertInstalled();
  const production = !('_store' in <div />);
  if (!production) {
    throw new Error('The perf lane must measure a production build.');
  }
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(answerStepLength);
  const store = await recordedStore(source, baseline);

  const durations: number[] = [];
  let recording = false;
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    if (recording) {
      durations.push(actualDuration);
    }
  };
  mount(
    <Profiler id="conversation" onRender={onRender}>
      <Surface actions={{ onNew: async () => undefined }} store={store} />
    </Profiler>
  );
  await conversation().ui.findByText(recordedPrompt);
  store.acceptTelemetry(recordedRunId, recordedChunk('text-start'));
  await waitForQuiescence();

  const delta = recordedChunk('text-delta');
  let cursor = 0;
  const publish = (end: number): void => {
    store.acceptTelemetry(recordedRunId, {
      ...delta,
      text: LONG_REPLY_TOKENS.slice(cursor, end).join(''),
    });
    cursor = end;
  };

  const measureWindow = async (fraction: number): Promise<WindowMeasurement> => {
    publish(Math.floor(LONG_REPLY_TOKENS.length * fraction) - WINDOW_TOKENS);
    await waitForQuiescence();
    durations.length = 0;
    const commitsPerToken: number[] = [];
    recording = true;
    for (const end = cursor + WINDOW_TOKENS; cursor < end; ) {
      const before = instrumentation.commits;
      publish(cursor + 1);
      await waitForQuiescence();
      commitsPerToken.push(instrumentation.commits - before);
    }
    recording = false;
    return { commitDurations: [...durations], commitsPerToken };
  };
  // Sequential on purpose: each window streams on from where the last stopped.
  const windows = {
    '10%': await measureWindow(0.1),
    '50%': await measureWindow(0.5),
    '100%': await measureWindow(1),
  };
  return { react: version, tokens: LONG_REPLY_TOKENS.length, windows };
}
