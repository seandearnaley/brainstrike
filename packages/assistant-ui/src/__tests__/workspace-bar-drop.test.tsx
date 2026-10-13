import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceBar, type WorkspaceBarProps } from '../workspace-bar/workspace-bar';

function baseProps(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    primaryRoot: { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' },
    recentRoots: [],
    secondaryRoots: [],
    workspaceFolders: [],
    ...overrides,
  };
}

function dataTransfer(types: readonly string[], items: readonly unknown[] = []) {
  return { items, types };
}

describe('WorkspaceBar drop zone', () => {
  let onDropItems: ReturnType<typeof vi.fn<(items: readonly DataTransferItem[]) => void>>;

  beforeEach(() => {
    onDropItems = vi.fn<(items: readonly DataTransferItem[]) => void>();
  });

  it('arms the drop ring only for a drag that carries files', () => {
    render(<WorkspaceBar {...baseProps({ onDropItems })} />);
    const zone = screen.getByTestId('workspace-bar-drop-zone');
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['text/plain']) });
    expect(zone.className).not.toContain('ring-2');
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['Files']) });
    expect(zone.className).toContain('ring-2');
  });

  it('hands the drop items straight through, exactly once', () => {
    const items = [{ kind: 'file' }];
    render(<WorkspaceBar {...baseProps({ onDropItems })} />);
    fireEvent.drop(screen.getByTestId('workspace-bar-drop-zone'), {
      dataTransfer: dataTransfer(['Files'], items),
    });
    expect(onDropItems).toHaveBeenCalledExactlyOnceWith(items);
  });

  it('ignores a drop with no files and never calls the handler', () => {
    render(<WorkspaceBar {...baseProps({ onDropItems })} />);
    fireEvent.drop(screen.getByTestId('workspace-bar-drop-zone'), {
      dataTransfer: dataTransfer(['text/plain'], [{ kind: 'string' }]),
    });
    expect(onDropItems).not.toHaveBeenCalled();
  });

  it('renders NO drop affordance without the handler (web)', () => {
    // Capability gating by omission: the ring, the listeners and the testid
    // are all absent — not a disabled zone.
    render(<WorkspaceBar {...baseProps()} />);
    expect(screen.queryByTestId('workspace-bar-drop-zone')).not.toBeInTheDocument();
  });

  // happy-dom 20.11.2 defines `DragEvent = Event` verbatim
  // (BrowserWindow.js:520) rather than a MouseEvent subclass, so
  // `relatedTarget` passed through fireEvent's init dict is silently dropped
  // (@testing-library/dom's createEvent() has no generic passthrough for
  // unrecognized init keys — only dataTransfer/clipboardData/target.value/
  // target.files are special-cased, and everything else goes straight to
  // `new EventConstructor(type, init)`). happy-dom's FocusEvent IS a real
  // implementation, which is why tree-table.tsx:1248's identical
  // `relatedTarget instanceof Node && currentTarget.contains(relatedTarget)`
  // guard can be exercised via `fireEvent.blur(...)` — that route does not
  // exist for a drag event. Dispatching a raw Event and defining
  // `relatedTarget` on it directly (bypassing fireEvent's createEvent
  // entirely) reaches the real handler with a real relatedTarget, so this
  // still falsifies the actual guard rather than assuming it.
  function dragLeaveWithRelatedTarget(zone: HTMLElement, relatedTarget: Element | null): void {
    const event = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
    act(() => {
      zone.dispatchEvent(event);
    });
  }

  it('clears the ring on dragleave from the zone itself, not from a child chip', () => {
    render(<WorkspaceBar {...baseProps({ onDropItems })} />);
    const zone = screen.getByTestId('workspace-bar-drop-zone');
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['Files']) });
    dragLeaveWithRelatedTarget(zone, zone.firstElementChild);
    expect(zone.className).toContain('ring-2');
    dragLeaveWithRelatedTarget(zone, null);
    expect(zone.className).not.toContain('ring-2');
  });
});
