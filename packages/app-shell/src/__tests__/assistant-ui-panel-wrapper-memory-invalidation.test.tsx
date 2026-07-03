import './assistant-ui-panel-wrapper-test-support';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { ASSISTANT_MEMORY_INVALIDATED_EVENT } from '../assistant-memory-invalidation';
import { renderAssistantThreadPanel } from './assistant-ui-panel-wrapper-test-support';

test('dispatches OM snapshot invalidation when an observational-memory write reaches the wrapper', async () => {
  const invalidated = new Promise<unknown>((resolve) => {
    window.addEventListener(
      ASSISTANT_MEMORY_INVALIDATED_EVENT,
      (event) => resolve(event instanceof CustomEvent ? event.detail : null),
      { once: true }
    );
  });

  await renderAssistantThreadPanel(['openai'], 'thread-existing', async () => {
    await userEvent.click(await screen.findByTestId('emit-observational-memory-updated'));
  });

  await expect(invalidated).resolves.toMatchObject({
    kind: 'observational-memory',
    lookupKey: 'thread:thread-existing',
    resourceId: '/tmp/test-workspace',
    threadId: 'thread-existing',
  });
});
