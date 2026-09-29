import { USER_COMMANDS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/user-commands-bridge';
import { CONTEXT_FILES_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/context-files-bridge';
import { ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/personas-bridge';
import { SKILLS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/skills-bridge';
import { WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/utils/window-focus-bridge';
import { describe, expect, it } from 'vitest';
import { clipboardContract } from '../../ipc-domains/clipboard.contract';
import { contextFilesContract } from '../../ipc-domains/context-files.contract';
import { skillsContract } from '../../ipc-domains/skills.contract';
import { userCommandsContract } from '../../ipc-domains/user-commands.contract';
import { userPersonasContract } from '../../ipc-domains/user-personas.contract';
import { windowFocusContract } from '../../ipc-domains/window-focus.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

/**
 * BST-1648: the `X_BRIDGE_REQUIRED_METHODS` resolver pins are
 * `Object.keys(contract)` — the package interface, the resolver's exact set,
 * and the desktop contract cannot drift (the derived bridge is also pinned
 * equal to the package interface at compile time inside each contract).
 */
describe('leaf IPC contracts', () => {
  it.each([
    ['contextFiles', contextFilesContract, CONTEXT_FILES_BRIDGE_REQUIRED_METHODS],
    ['skills', skillsContract, SKILLS_BRIDGE_REQUIRED_METHODS],
    ['userCommands', userCommandsContract, USER_COMMANDS_BRIDGE_REQUIRED_METHODS],
    ['userPersonas', userPersonasContract, ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS],
    ['windowFocus', windowFocusContract, WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS],
  ])('%s keys equal the package required-method pin', (_domain, contract, required) => {
    expect(Object.keys(contract).sort()).toEqual([...required].sort());
  });

  it('binds every channel to its manifest entry with a visible-UI-only role set', () => {
    expect(clipboardContract.writeText).toMatchObject({
      channel: DESKTOP_IPC_CHANNELS.clipboard.writeText,
      envelope: 'ipc-result',
      roles: ['visible-ui'],
    });
    expect(contextFilesContract.scan.channel).toBe(DESKTOP_IPC_CHANNELS.contextFiles.scan);
    expect(skillsContract.scan.channel).toBe(DESKTOP_IPC_CHANNELS.skills.scan);
    expect(userCommandsContract.list.channel).toBe(DESKTOP_IPC_CHANNELS.userCommands.list);
    expect(userPersonasContract.list.channel).toBe(DESKTOP_IPC_CHANNELS.userPersonas.list);
    for (const contract of [
      contextFilesContract,
      skillsContract,
      userCommandsContract,
      userPersonasContract,
    ]) {
      for (const spec of Object.values(contract)) {
        expect(spec.roles).toEqual(['visible-ui']);
      }
    }
  });

  it('parses clipboard.writeText input in main and throws on a non-string payload', () => {
    expect(clipboardContract.writeText.parseArgs(['docs/notes.ts'])).toEqual(['docs/notes.ts']);
    expect(clipboardContract.writeText.parseArgs([''])).toEqual(['']);
    for (const payload of [42, null, undefined, { text: 'x' }, ['x'], true]) {
      expect(() => clipboardContract.writeText.parseArgs([payload])).toThrow(
        'clipboard writeText requires a string payload'
      );
    }
  });

  it('parses the no-argument scans and lists to an empty tuple', () => {
    expect(skillsContract.scan.parseArgs(['ignored'])).toEqual([]);
    expect(userCommandsContract.list.parseArgs([])).toEqual([]);
    expect(userPersonasContract.list.parseArgs([])).toEqual([]);
    expect(contextFilesContract.scan.parseArgs([])).toEqual([]);
  });

  it('binds windowFocus to its manifest channels: one visible-UI invoke and one push', () => {
    expect(windowFocusContract.isFocused).toMatchObject({
      channel: DESKTOP_IPC_CHANNELS.windowFocus.isFocused,
      envelope: 'ipc-result',
      kind: 'invoke',
      roles: ['visible-ui'],
    });
    expect(windowFocusContract.onChange).toEqual({
      channel: DESKTOP_IPC_CHANNELS.windowFocus.changed,
      kind: 'push',
    });
    expect(windowFocusContract.isFocused.parseArgs([])).toEqual([]);
  });
});
