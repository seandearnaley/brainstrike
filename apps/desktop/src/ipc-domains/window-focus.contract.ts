/**
 * Pure contract for the native window-focus bridge (BST-1864). Keyboard focus
 * inside the browser pane's `WebContentsView` (or docked DevTools) makes the
 * renderer's own `document.hasFocus()` false while the BrowserWindow is still
 * the focused OS window, so `useAppActive()` reads the NATIVE window instead:
 * `isFocused` is the value now, `onChange` pushes every `focus`/`blur` of the
 * asking window. The derived bridge is pinned to `WindowFocusBridge` in
 * `@brainstrike/utils`, the shape `useAppActive()` consumes. PURE — bundled into
 * the preload and imported by main.
 */
import type { WindowFocusBridge } from '@brainstrike/utils/window-focus-bridge';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
  parseNoArgs,
  pushEvent,
} from '../platform/ipc-contract';

export const windowFocusContract = {
  isFocused: channel<[], boolean>({
    channel: DESKTOP_IPC_CHANNELS.windowFocus.isFocused,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  onChange: pushEvent<boolean>({ channel: DESKTOP_IPC_CHANNELS.windowFocus.changed }),
} satisfies Contract;

export type WindowFocusBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof windowFocusContract, WindowFocusBridge>
>;
