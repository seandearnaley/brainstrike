import {
  type AnyContextAction,
  type CapabilityKey,
  createTestActionRegistry,
  defineContextAction,
} from '@brainstrike/context-actions';
import { addLogListener, type LogRecord } from '@brainstrike/utils';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionContextMenu, ActionRegistryProvider, useContextMenuTarget } from '../context-menu';

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

vi.mock('../use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../use-toast')>();
  return { ...actual, toast: toastSpy };
});

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

function Harness({ localActions = [] }: { localActions?: readonly AnyContextAction[] }) {
  const controller = useContextMenuTarget();
  return (
    <ActionContextMenu controller={controller} localActions={localActions}>
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

function renderHarness(
  options: {
    capabilities?: readonly CapabilityKey[];
    localActions?: readonly AnyContextAction[];
  } = {}
) {
  const { registry, writtenTexts } = createTestActionRegistry({
    actions: [copyName, revealAction],
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  render(
    <ActionRegistryProvider registry={registry}>
      <Harness {...(options.localActions ? { localActions: options.localActions } : {})} />
    </ActionRegistryProvider>
  );
  return { writtenTexts };
}

async function openMenuOnRow(): Promise<void> {
  fireEvent.contextMenu(screen.getByTestId('row-a'), { clientX: 10, clientY: 10 });
  await screen.findByRole('menu');
}

describe('ActionContextMenu', () => {
  const logRecords: LogRecord[] = [];
  let removeLogListener: () => void;

  beforeEach(() => {
    toastSpy.mockClear();
    logRecords.length = 0;
    removeLogListener = addLogListener((record) => {
      if (record.scope === 'ContextActions') {
        logRecords.push(record);
      }
    });
  });

  afterEach(() => {
    removeLogListener();
  });

  it('opens on row right-click and lists applicable actions', async () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByTestId('row-a'), { clientX: 10, clientY: 10 });
    expect(await screen.findByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeInTheDocument();
  });

  it('hides capability-gated actions when the capability is missing', async () => {
    renderHarness({ capabilities: ['clipboard'] });
    fireEvent.contextMenu(screen.getByTestId('row-a'), { clientX: 10, clientY: 10 });
    expect(await screen.findByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).not.toBeInTheDocument();
  });

  it('runs the action with services on item select and toasts the success message', async () => {
    const { writtenTexts } = renderHarness();
    fireEvent.contextMenu(screen.getByTestId('row-a'), { clientX: 10, clientY: 10 });
    const item = await screen.findByRole('menuitem', { name: 'Copy Name' });
    fireEvent.click(item);
    await waitFor(() => {
      expect(writtenTexts).toEqual(['notes.md']);
      expect(toastSpy).toHaveBeenCalledWith({ description: 'Name copied' });
    });
  });

  it('does not open a menu when right-clicking outside any row', () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByTestId('background'), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('toasts destructively and logs when an action resolves a failure outcome', async () => {
    const failing = defineContextAction({
      id: 'file.fail',
      label: 'Fail',
      group: 'danger',
      appliesTo: ['file-entry'] as const,
      run: () => Promise.resolve({ ok: false, error: 'boom' }),
    });
    renderHarness({ localActions: [failing] });
    await openMenuOnRow();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fail' }));
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'boom',
        title: 'Action failed',
        variant: 'destructive',
      });
    });
    expect(logRecords).toHaveLength(1);
    expect(logRecords[0]?.args).toEqual([
      'Context action failed',
      { actionId: 'file.fail', error: 'boom', targetKind: 'file-entry' },
    ]);
  });

  it('surfaces a rejecting action as an unexpected failure', async () => {
    const rejecting = defineContextAction({
      id: 'file.reject',
      label: 'Reject',
      group: 'danger',
      appliesTo: ['file-entry'] as const,
      run: () => Promise.reject(new Error('kaboom')),
    });
    renderHarness({ localActions: [rejecting] });
    await openMenuOnRow();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reject' }));
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'kaboom',
        title: 'Action failed unexpectedly',
        variant: 'destructive',
      });
    });
    expect(logRecords).toHaveLength(1);
    expect(logRecords[0]?.args[0]).toBe('Context action threw');
  });

  it('surfaces a synchronously-throwing action instead of letting it escape onSelect', async () => {
    const throwing = defineContextAction({
      id: 'file.throw',
      label: 'Throw',
      group: 'danger',
      appliesTo: ['file-entry'] as const,
      run: () => {
        throw new Error('sync-kaboom');
      },
    });
    renderHarness({ localActions: [throwing] });
    await openMenuOnRow();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Throw' }));
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'sync-kaboom',
        title: 'Action failed unexpectedly',
        variant: 'destructive',
      });
    });
    expect(logRecords).toHaveLength(1);
    expect(logRecords[0]?.args[0]).toBe('Context action threw');
  });

  it('does not reopen on a background right-click after closing (stale target stays inert)', async () => {
    renderHarness();
    await openMenuOnRow();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('background'), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders gated items disabled and does not run them on click', async () => {
    const gated = defineContextAction({
      id: 'file.copy-gated',
      label: 'Copy (loading)',
      group: 'copy',
      appliesTo: ['file-entry'] as const,
      requiredCapabilities: ['clipboard'] as const,
      isEnabled: () => false,
      run: async (target, services) => {
        await services.clipboard?.writeText(target.name);
        return { ok: true };
      },
    });
    const { writtenTexts } = renderHarness({ localActions: [gated] });
    await openMenuOnRow();
    const item = screen.getByRole('menuitem', { name: 'Copy (loading)' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(writtenTexts).toEqual([]);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('renders a function label computed from the target', async () => {
    const labelled = defineContextAction({
      id: 'file.labelled',
      label: (target) => `Copy "${target.name}"`,
      group: 'copy',
      appliesTo: ['file-entry'] as const,
      run: () => Promise.resolve({ ok: true }),
    });
    renderHarness({ localActions: [labelled] });
    await openMenuOnRow();
    expect(screen.getByRole('menuitem', { name: 'Copy "notes.md"' })).toBeInTheDocument();
  });
});
