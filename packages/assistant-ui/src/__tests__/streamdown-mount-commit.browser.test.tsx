import '@testing-library/jest-dom/vitest';
import { act } from '@brainstrike/test-utils/react-act';
import { render } from '@testing-library/react';
import { Profiler, type ProfilerOnRenderCallback, type ReactElement } from 'react';
import { Streamdown } from 'streamdown';
import { expect, test } from 'vitest';

/**
 * BST-2169: streamdown 2.7.0's caret hook (`useCaretHost`) set a `hydrated`
 * flag with `useState(false)` plus a mount `useEffect`, so every `<Streamdown>`
 * mount rendered twice (vercel/streamdown#673). Our text part mounts Streamdown
 * on its first streamed token, which then cost two message commits and broke
 * the per-token budget in committed-assistant-conversation.browser.test.tsx.
 * Upstream fixed it with `useSyncExternalStore` (vercel/streamdown#677, merged
 * 2026-10-16, unreleased). Paired with patches/streamdown@2.7.0.patch; drop
 * both at the first streamdown release that contains #677.
 */
const TEXT = 'Host run completed.';

function profiled(phases: string[], text: string): ReactElement {
  const onRender: ProfilerOnRenderCallback = (_id, phase) => {
    phases.push(phase);
  };
  return (
    <Profiler id="streamdown" onRender={onRender}>
      <Streamdown mode="streaming">{text}</Streamdown>
    </Profiler>
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

test('a streaming Streamdown mounts in one commit and renders a token in one more', async () => {
  const phases: string[] = [];
  const view = render(profiled(phases, TEXT));
  await act(nextFrame);
  expect(view.container).toHaveTextContent(TEXT);
  expect(
    phases,
    'Streamdown mount commits (patches/streamdown@2.7.0.patch, vercel/streamdown#677)'
  ).toEqual(['mount']);

  phases.length = 0;
  view.rerender(profiled(phases, `${TEXT} Next`));
  await act(nextFrame);
  expect(phases, 'one streamed token').toEqual(['update']);
  view.unmount();
});
