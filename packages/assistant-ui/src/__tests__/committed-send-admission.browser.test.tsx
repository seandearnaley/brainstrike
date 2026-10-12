import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (React DevTools hook).
import './committed-assistant-browser-support';
import { act, render, waitFor } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { CommittedAssistantCommands } from '../committed-assistant-store';
import { settleAnimations, settleFrames } from './committed-assistant-browser-support';
import { conversation, Surface } from './committed-conversation-surface';
import {
  committedRows,
  RecordedCommittedSource,
  RUN_REFUSED,
  recordedBaseline,
  recordedStore,
} from './committed-recording-support';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/** The recorded HostCore run, completed, under the shipped committed conversation. */
async function mountCompleted(actions: CommittedAssistantCommands) {
  const { baseline } = await recordedBaseline();
  const source = new RecordedCommittedSource();
  source.publishPrefix(committedRows.length);
  const store = await recordedStore(source, baseline, baseline.headId);
  onTestFinished(() => store.dispose());
  render(<Surface actions={actions} store={store} />);
  const surface = conversation();
  await surface.ui.findByText('Host run completed.');
  await settleAnimations(surface.region);
  return surface;
}

test('a second send while the first run start is in flight stays in the composer and is never dispatched', async () => {
  // BST-1981: the committed fold shows a run only after the host admits it,
  // and `run/start` stays pending for that whole admission. The host refuses
  // a second start in that window, after the composer has cleared its draft.
  const admission = Promise.withResolvers<void>();
  const onNew = vi
    .fn<NonNullable<CommittedAssistantCommands['onNew']>>()
    .mockImplementationOnce(() => admission.promise)
    .mockRejectedValue(new Error(RUN_REFUSED));
  const surface = await mountCompleted({ onNew });
  const send = surface.ui.getByRole('button', { name: 'Send' });
  await act(async () => {
    surface.input.focus();
    // Two Enters milliseconds apart, as a fast typist sends them.
    await userEvent.keyboard('First message{Enter}Second message{Enter}');
  });
  await waitFor(() => expect(onNew).toHaveBeenCalledOnce());
  await settleFrames();
  expect(onNew).toHaveBeenCalledOnce();
  expect(surface.input).toHaveValue('Second message');
  expect(send).toBeDisabled();
  expect(surface.host.queryByRole('alert', { name: 'Agent command error' })).toBeNull();

  await act(async () => admission.resolve());
  await waitFor(() => expect(send).toBeEnabled());
  expect(onNew).toHaveBeenCalledOnce();
  expect(surface.input).toHaveValue('Second message');
});
