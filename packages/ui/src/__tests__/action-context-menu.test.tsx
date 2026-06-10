import { createTestActionRegistry, defineContextAction } from '@brainstrike/context-actions';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionContextMenu, ActionRegistryProvider, useContextMenuTarget } from '../context-menu';

const copyName = defineContextAction({
  id: 'file.copy-name',
  label: 'Copy Name',
  group: 'copy',
  appliesTo: ['file-entry'] as const,
  requiredCapabilities: ['clipboard'] as const,
  run: async (target, services) => {
    if (!services.clipboard) {
      return { ok: false, error: 'Clipboard service unavailable' };
    }
    const outcome = await services.clipboard.writeText(target.name);
    return outcome.ok ? { ok: true, message: 'Name copied' } : outcome;
  },
});

const revealAction = defineContextAction({
  id: 'file.reveal',
  label: 'Reveal in Finder',
  group: 'navigate',
  appliesTo: ['file-entry'] as const,
  requiredCapabilities: ['fs.reveal'] as const,
  run: () => Promise.resolve({ ok: true }),
});

function Harness() {
  const controller = useContextMenuTarget();
  return (
    <ActionContextMenu controller={controller} localActions={[]}>
      <div onContextMenuCapture={() => controller.setTarget(null)} role="treegrid">
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: test harness exercising right-click target claiming */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: test harness exercising right-click target claiming */}
        <div
          data-testid="row-a"
          onContextMenu={() =>
            controller.setTarget({
              kind: 'file-entry',
              name: 'notes.md',
              relativePath: 'docs/notes.md',
              absolutePath: '/root/docs/notes.md',
              entryType: 'file',
              rootFolderId: '/root',
            })
          }
        >
          notes.md
        </div>
        <div data-testid="background">background</div>
      </div>
    </ActionContextMenu>
  );
}

function renderHarness(capabilities?: readonly ('clipboard' | 'fs.reveal')[]) {
  const { registry, writtenTexts } = createTestActionRegistry({
    actions: [copyName, revealAction],
    ...(capabilities ? { capabilities } : {}),
  });
  render(
    <ActionRegistryProvider registry={registry}>
      <Harness />
    </ActionRegistryProvider>
  );
  return { writtenTexts };
}

describe('ActionContextMenu', () => {
  it('opens on row right-click and lists applicable actions', async () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByTestId('row-a'), { clientX: 10, clientY: 10 });
    expect(await screen.findByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeInTheDocument();
  });

  it('hides capability-gated actions when the capability is missing', async () => {
    renderHarness(['clipboard']);
    fireEvent.contextMenu(screen.getByTestId('row-a'), { clientX: 10, clientY: 10 });
    expect(await screen.findByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).not.toBeInTheDocument();
  });

  it('runs the action with services on item select', async () => {
    const { writtenTexts } = renderHarness();
    fireEvent.contextMenu(screen.getByTestId('row-a'), { clientX: 10, clientY: 10 });
    const item = await screen.findByRole('menuitem', { name: 'Copy Name' });
    fireEvent.click(item);
    await waitFor(() => {
      expect(writtenTexts).toEqual(['notes.md']);
    });
  });

  it('does not open a menu when right-clicking outside any row', () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByTestId('background'), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
