import { describe, expect, it, vi } from 'vitest';
import type { ActionOutcome } from '../../types.js';
import { createCommandRegistry } from '../command-registry.js';
import { createTabCommands, type TabCommandStrip } from '../tab-commands.js';
import type { Command, CommandContext, RunCommand } from '../types.js';

const CTX: CommandContext = { capabilities: new Set(), services: {} };

function strip(ids: readonly string[], activeId: string | null, closedTabs = 1) {
  return {
    activate: vi.fn<(id: string) => void>(),
    close: vi.fn<(id: string) => void>(),
    getActiveId: () => activeId,
    getTabs: () => ids.map((id) => ({ id, label: `Tab ${id}` })),
    hasClosedTabs: () => closedTabs > 0,
    reopenClosed: vi.fn<() => Promise<ActionOutcome>>(() => Promise.resolve({ ok: true })),
  } satisfies TabCommandStrip;
}

function command(commands: readonly Command[], id: string): Command {
  const found = commands.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no command ${id}`);
  }
  return found;
}

function runnable(candidate: Command): RunCommand {
  if (candidate.page) {
    throw new Error(`${candidate.id} opens a page`);
  }
  return candidate;
}

const TAB_COMMAND_IDS = ['tab.close', 'tab.reopen-closed', 'tab.next', 'tab.previous', 'tab.go-to'];

describe('createTabCommands', () => {
  it('offers Close, Reopen Closed, Next, Previous and Go to Tab… when a strip is in scope', () => {
    const commands = createTabCommands(() => strip(['a', 'b'], 'a'));
    const available = createCommandRegistry(commands).available(CTX);

    expect(available.map((candidate) => [candidate.id, candidate.label])).toEqual([
      ['tab.close', 'Close Tab'],
      ['tab.reopen-closed', 'Reopen Closed Tab'],
      ['tab.next', 'Next Tab'],
      ['tab.previous', 'Previous Tab'],
      ['tab.go-to', 'Go to Tab…'],
    ]);
  });

  it('hides every tab command when no strip is in scope', () => {
    const commands = createTabCommands(() => undefined);
    const available = createCommandRegistry(commands).available(CTX);

    expect(available.filter((candidate) => TAB_COMMAND_IDS.includes(candidate.id))).toEqual([]);
  });

  it('Close Tab closes the active tab, and reports when none is open', async () => {
    const withActive = strip(['a', 'b'], 'b');
    await expect(
      runnable(
        command(
          createTabCommands(() => withActive),
          'tab.close'
        )
      ).run(CTX)
    ).resolves.toEqual({ ok: true });
    expect(withActive.close).toHaveBeenCalledExactlyOnceWith('b');

    const empty = strip([], null);
    await expect(
      runnable(
        command(
          createTabCommands(() => empty),
          'tab.close'
        )
      ).run(CTX)
    ).resolves.toEqual({ error: 'No tab is open', ok: false });
    expect(empty.close).not.toHaveBeenCalled();
  });

  it('hides Reopen Closed Tab while the scoped strip has no closed tab', () => {
    const available = createCommandRegistry(
      createTabCommands(() => strip(['a'], 'a', 0))
    ).available(CTX);

    expect(available.map((candidate) => candidate.id)).not.toContain('tab.reopen-closed');
    expect(available.map((candidate) => candidate.id)).toContain('tab.close');
  });

  it('Reopen Closed Tab reports the strip outcome', async () => {
    const scoped = strip(['a'], 'a');
    scoped.reopenClosed.mockResolvedValueOnce({ error: 'No closed tab to reopen', ok: false });

    await expect(
      runnable(
        command(
          createTabCommands(() => scoped),
          'tab.reopen-closed'
        )
      ).run(CTX)
    ).resolves.toEqual({ error: 'No closed tab to reopen', ok: false });
  });

  it('Next and Previous Tab move by position and wrap', async () => {
    const scoped = strip(['a', 'b', 'c'], 'c');
    const commands = createTabCommands(() => scoped);

    await runnable(command(commands, 'tab.next')).run(CTX);
    await runnable(command(commands, 'tab.previous')).run(CTX);

    expect(scoped.activate.mock.calls).toEqual([['a'], ['b']]);
  });

  it('Go to Tab… opens a page of the strip tabs, in order, each activating its tab', async () => {
    const scoped = strip(['a', 'b'], 'a');
    const goTo = command(
      createTabCommands(() => scoped),
      'tab.go-to'
    );
    if (!goTo.page) {
      throw new Error('Go to Tab… must open a page');
    }

    const page = goTo.page(CTX);
    expect(page.placeholder).toBe('Go to tab…');
    expect(page.commands.map((item) => item.label)).toEqual(['Tab a', 'Tab b']);
    await expect(page.commands[1]?.run(CTX)).resolves.toEqual({ ok: true });
    expect(scoped.activate).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('reports a strip that left scope between listing and running', async () => {
    let scoped: TabCommandStrip | undefined = strip(['a'], 'a');
    const commands = createTabCommands(() => scoped);
    scoped = undefined;

    await expect(runnable(command(commands, 'tab.next')).run(CTX)).resolves.toEqual({
      error: 'No tab strip is in scope',
      ok: false,
    });
  });

  it('reads the strip at run time, not when the commands were built', async () => {
    let scoped = strip(['a', 'b'], 'a');
    const commands = createTabCommands(() => scoped);
    scoped = strip(['x', 'y'], 'y');

    await runnable(command(commands, 'tab.close')).run(CTX);

    expect(scoped.close).toHaveBeenCalledExactlyOnceWith('y');
  });
});
