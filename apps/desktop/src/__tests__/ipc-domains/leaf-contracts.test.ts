import { CONTEXT_FILES_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/context-files-bridge';
import { ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/personas-bridge';
import { WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/utils/window-focus-bridge';
import { describe, expect, it } from 'vitest';
import { clipboardArgs } from '../../ipc-clipboard-handlers';
import { clipboardContract } from '../../ipc-domains/clipboard.contract';
import { contextFilesContract } from '../../ipc-domains/context-files.contract';
import { userPersonasContract } from '../../ipc-domains/user-personas.contract';
import { windowFocusContract } from '../../ipc-domains/window-focus.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import { ipcArgsDecoder } from '../../platform/ipc-args';

/**
 * BST-1648: the `X_BRIDGE_REQUIRED_METHODS` resolver pins are
 * `Object.keys(contract)` — the package interface, the resolver's exact set,
 * and the desktop contract cannot drift (the derived bridge is also pinned
 * equal to the package interface at compile time inside each contract).
 */
describe('leaf IPC contracts', () => {
  it.each([
    ['contextFiles', contextFilesContract, CONTEXT_FILES_BRIDGE_REQUIRED_METHODS],
    ['userPersonas', userPersonasContract, ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS],
    ['windowFocus', windowFocusContract, WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS],
  ])('%s keys equal the package required-method pin', (_domain, contract, required) => {
    expect(Object.keys(contract).sort()).toEqual([...required].sort());
  });

  it('binds every method to its manifest entry', () => {
    expect(clipboardContract.writeText).toMatchObject({
      channel: DESKTOP_IPC_CHANNELS.clipboard.writeText,
      envelope: 'ipc-result',
    });
    expect(contextFilesContract.scan.channel).toBe(DESKTOP_IPC_CHANNELS.contextFiles.scan);
    expect(userPersonasContract.list.channel).toBe(DESKTOP_IPC_CHANNELS.userPersonas.list);
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

  it('binds windowFocus to its manifest methods: one invoke and one push', () => {
    expect(windowFocusContract.isFocused).toMatchObject({
      channel: DESKTOP_IPC_CHANNELS.windowFocus.isFocused,
      envelope: 'ipc-result',
      kind: 'invoke',
    });
    expect(windowFocusContract.onChange).toEqual({
      channel: DESKTOP_IPC_CHANNELS.windowFocus.changed,
      kind: 'push',
    });
  });
});
