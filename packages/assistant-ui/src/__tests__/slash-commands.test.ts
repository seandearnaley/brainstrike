import { describe, expect, it, vi } from 'vitest';
import {
  buildSlashCommandIconMap,
  type SlashCommand,
  toSlashCommandAdapterOptions,
} from '../slash-commands';

const FakeIcon = (_props: { className?: string }) => null;

function makeCommand(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    execute: vi.fn(),
    id: 'thread.new',
    label: 'New thread',
    ...overrides,
  };
}

describe('toSlashCommandAdapterOptions', () => {
  it('maps the command id to the library item id and preserves the label + execute', () => {
    const execute = vi.fn();
    const options = toSlashCommandAdapterOptions([
      makeCommand({ execute, id: 'fs.reveal', label: 'Reveal in Finder' }),
    ]);

    expect(options.commands).toHaveLength(1);
    const [command] = options.commands;
    expect(command?.id).toBe('fs.reveal');
    expect(command?.label).toBe('Reveal in Finder');

    command?.execute?.();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('produces an empty command list for no commands (web with nothing to show)', () => {
    expect(toSlashCommandAdapterOptions([]).commands).toEqual([]);
  });

  it('sets removeOnExecute so selecting a command clears the "/command" text (pre-0.12.26 parity)', () => {
    expect(toSlashCommandAdapterOptions([makeCommand()]).removeOnExecute).toBe(true);
  });
});

describe('buildSlashCommandIconMap', () => {
  it('keys icon components by command id and omits icon-less commands', () => {
    const iconMap = buildSlashCommandIconMap([
      makeCommand({ icon: FakeIcon, id: 'thread.new' }),
      makeCommand({ id: 'nav.settings', label: 'Settings' }),
    ]);

    expect(iconMap.get('thread.new')).toBe(FakeIcon);
    expect(iconMap.has('nav.settings')).toBe(false);
  });
});
