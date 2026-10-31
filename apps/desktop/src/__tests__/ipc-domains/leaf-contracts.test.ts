import { WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/window-focus-bridge';
import { describe, expect, it } from 'vitest';
import { clipboardArgs } from '../../ipc-clipboard-handlers';
import { windowFocusContract } from '../../ipc-domains/window-focus.contract';
import { ipcArgsDecoder } from '../../platform/ipc-args';

/**
 * BST-1648: the `X_BRIDGE_REQUIRED_METHODS` resolver pins are
 * `Object.keys(contract)` — the package interface, the resolver's exact set,
 * and the desktop contract cannot drift (the derived bridge is also pinned
 * equal to the package interface at compile time inside each contract).
 */
describe('leaf IPC contracts', () => {
  it('windowFocus keys equal the package required-method pin', () => {
    expect(Object.keys(windowFocusContract).sort()).toEqual(
      [...WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS].sort()
    );
  });

  it('decodes clipboard.writeImage only as PNG bytes', () => {
    const decode = ipcArgsDecoder('clipboard:write-image', clipboardArgs.writeImage);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    expect(decode([png])).toEqual([png]);
    const notPng = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73]);
    for (const payload of [new Uint8Array(), notPng, 'png', [137, 80], null, undefined]) {
      expect(() => decode([payload])).toThrow(TypeError);
    }
    expect(() => decode([png, png])).toThrow();
  });
});
